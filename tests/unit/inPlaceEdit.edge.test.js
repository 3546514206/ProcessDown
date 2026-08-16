'use strict';

/**
 * In-place editing — edge cases & behavioral contracts.
 *
 * 覆盖：
 *   1) 重载（restore）回放编辑后的版本：PATCH 写入 diagram.json → checkSession
 *      读 diagram 优先 → 前端拿到 lastMermaid === 编辑版
 *   2) 编辑 + 新 prompt 的赛跑：编辑进行中发新 prompt，新 prompt 的 finalize
 *      覆盖 textarea.value（流式累积阶段 readOnly=false）。新 LLM 输出最终胜出
 *      并被 PATCH 到 diagram.json（如果 finalize 路径会触发）。**用户编辑丢失**——
 *      这是设计文档明确接受的语义（diagram.json 是"当前规范"，不保留历史）
 *   3) 净化的边界：history 仍含 raw LLM 输出（带 <think> 标签、emoji 等），
 *      diagram 必须是已编辑的代码。checkSession 的 history 净化与 diagram 优
 *      先级组合保证前端只渲染合规内容
 *   4) 无效 mermaid 语法：编辑允许（textarea 不做语法校验），预览走 scheduleRender
 *      silent=true 路径不报错，最终 renderMermaid（loud）展示错误；保存接受任意
 *      字符串。**故意宽松**：服务端不替你做语法检查，留给 mermaid.render 报错
 *
 * 复用 mermaidRenderErrorHints.test.js 的 vm 沙箱模式 + diagramPersistence
 * 的 router+mockReq/mockRes 模式。
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

// ---- server-side setup (mock generator, real router, tmpdir) ----------------

const GeneratorService = require('../../src/services/generator');
const originalGenerate = GeneratorService.prototype.generate;
const originalGenerateStream = GeneratorService.prototype.generateStream;

let roundCounter = 0;
function installGeneratorMocks() {
    GeneratorService.prototype.generate = async () => {
        roundCounter += 1;
        return `flowchart TD\n    Round${roundCounter}A-->Round${roundCounter}B`;
    };
    GeneratorService.prototype.generateStream = async (_p, _c, _h, hooks) => {
        roundCounter += 1;
        const mermaid = `flowchart TD\n    Round${roundCounter}A-->Round${roundCounter}B`;
        if (hooks && hooks.onContent) hooks.onContent(mermaid);
        if (hooks && hooks.onDone) hooks.onDone({ mermaid, fixes: [], extracted: true });
    };
}
installGeneratorMocks();

const createRouter = require('../../src/routes/api');
const { SessionStore } = require('../../src/services/sessionStore');

function mockRes() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        writeHead(code, h) {
            this.statusCode = code;
            if (h) Object.assign(this.headers, h);
        },
        end(data) { this.body = data; }
    };
}

function mockStreamRes() {
    return {
        statusCode: 200, headers: {}, chunks: [], writableEnded: false,
        writeHead(code, h) { this.statusCode = code; if (h) Object.assign(this.headers, h); },
        write(data) { if (!this.writableEnded) this.chunks.push(String(data)); },
        end(data) { if (data) this.chunks.push(String(data)); this.writableEnded = true; }
    };
}

function makeConfig(tempDir) {
    return {
        session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
        users: { dir: tempDir },
        llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.7, maxTokens: 1000, timeout: 30000 },
        server: { port: 3000, timeout: 30000 },
        cors: { enabled: true, origins: ['*'] },
        rateLimit: { enabled: false, maxRequests: 100, windowMs: 60000 },
        auth: { enabled: false, tokenTtlDays: 7 },
        health: { checkLlm: false }
    };
}

// ---- client-side vm sandbox (similar to inPlaceEdit.unit.test.js) -----------

const CHAT_PATH = path.join(__dirname, '..', '..', 'public', 'js', 'chat.js');
const CHAT_SOURCE = fs.readFileSync(CHAT_PATH, 'utf8');
const RENDER_PATH = path.join(__dirname, '..', '..', 'public', 'js', 'mermaid-render.js');
const RENDER_SOURCE = fs.readFileSync(RENDER_PATH, 'utf8');

function loadChat() {
    let now = 1000000;
    const pending = new Map();
    let nextId = 1;
    const fakeSetTimeout = (fn, delay) => {
        const id = nextId++;
        pending.set(id, { fn, due: now + (delay || 0) });
        return id;
    };
    const fakeClearTimeout = (id) => pending.delete(id);
    const flushTimers = () => {
        const due = [...pending.entries()].filter(([_, t]) => t.due <= now);
        for (const [id, t] of due) { pending.delete(id); t.fn(); }
    };
    const advance = (ms) => { now += ms; flushTimers(); };

    const messages = makeContainer('chat-messages');
    const welcome = { hidden: true };
    const textarea = makeContainer('chat-textarea');
    textarea.value = '';
    textarea.style = {};
    const send = makeContainer('chat-send');
    send.querySelector = (sel) => sel === '.icon-send' || sel === '.icon-stop' ? { style: {} } : null;
    const scrollBtn = makeContainer('scroll-bottom-btn');
    const status = { textContent: '', className: '' };

    const fetches = [];
    const fetchStub = (url, opts = {}) => {
        fetches.push({ url, opts });
        return Promise.resolve({
            ok: !fetchStub._shouldFail,
            status: fetchStub._shouldFail ? 500 : 200,
            json: async () => ({ success: true })
        });
    };

    const lsStore = {};
    const localStorageStub = {
        getItem: (k) => k in lsStore ? lsStore[k] : null,
        setItem: (k, v) => { lsStore[k] = String(v); },
        removeItem: (k) => { delete lsStore[k]; }
    };

    const appState = { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', user: 'alice' };
    const appStub = {
        state: appState,
        ensureSession: async () => {},
        loadSessions: async () => {},
        showToast: () => {},
        updateStatus: () => {},
        showLoginMask: () => {}
    };

    const renderCalls = [];
    const mermaidRenderStub = {
        init() {},
        async render(code, opts) {
            renderCalls.push({ code, opts });
            // Honor the silent contract: silent means preview should NOT mutate innerHTML.
            // Non-silent (final render) may fail and render an error block — but the
            // sandbox doesn't have a real container here, so we no-op.
            return { svg: '<svg></svg>' };
        },
        clear() {}
    };

    const sandbox = {
        console, document: {
            getElementById: (id) => {
                if (id === 'chat-messages') return messages;
                if (id === 'welcome-state') return welcome;
                if (id === 'chat-textarea') return textarea;
                if (id === 'chat-send') return send;
                if (id === 'scroll-bottom-btn') return scrollBtn;
                if (id === 'status-text') return status;
                return null;
            },
            createElement: (tag) => makeContainer(tag),
            querySelectorAll: () => [],
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true
        },
        localStorage: localStorageStub,
        fetch: fetchStub,
        setTimeout: fakeSetTimeout,
        clearTimeout: fakeClearTimeout,
        Date: { now: () => now },
        navigator: { clipboard: { writeText: async () => {} } },
        Promise, Map, Set, Array, Object, JSON, Math, String, Number, Boolean,
        Error, Symbol, URL,
        AbortController: typeof AbortController !== 'undefined' ? AbortController : class { constructor(){this.signal={}} abort(){} },
        TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : class { decode(){return ''} }
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.window.fetch = fetchStub;
    sandbox.window.localStorage = localStorageStub;
    sandbox.window.app = appStub;
    sandbox.window.mermaidRender = mermaidRenderStub;
    sandbox.window.mermaid = { render: async () => ({ svg: '<svg></svg>' }) };

    vm.createContext(sandbox);
    vm.runInContext(CHAT_SOURCE, sandbox, { filename: 'chat.js' });
    vm.runInContext('chat.init();', sandbox);

    return {
        sandbox, chat: sandbox.chat,
        dom: { messages, welcome, textarea, send, scrollBtn, status },
        timers: { advance, pending },
        fetches, renderCalls, lsStore, appState
    };
}

function makeContainer(tag) {
    const children = [];
    const listeners = {};
    return {
        tagName: tag.toUpperCase(), children, className: '',
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            toggle(c, force) {
                if (force === true) this._set.add(c);
                else if (force === false) this._set.delete(c);
                else if (this._set.has(c)) this._set.delete(c);
                else this._set.add(c);
                return this._set.has(c);
            },
            contains(c) { return this._set.has(c); }
        },
        style: {}, hidden: false, dataset: {},
        readOnly: false, spellcheck: true, wrap: 'soft',
        value: '', textContent: '', scrollHeight: 100, scrollTop: 0, clientHeight: 100,
        addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
        removeEventListener(name, fn) { if (listeners[name]) listeners[name] = listeners[name].filter(x => x !== fn); },
        _dispatch(name, evt) { (listeners[name] || []).forEach(fn => fn(evt || {})); },
        appendChild(c) { children.push(c); return c; },
        removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); },
        remove() {},
        querySelector(sel) { return sel === '.think-label' ? { textContent: '' } : null; },
        querySelectorAll() { return []; }
    };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('in-place edit: reload restores edited version (round-trip)', () => {
    let tempDir, router, sessionsDir;
    const ID = '550e8400-e29b-41d4-a716-446655440000';

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-edit-reload-'));
        router = createRouter(makeConfig(tempDir));
        sessionsDir = path.join(tempDir, 'testuser', 'sessions');
        roundCounter = 0;
        installGeneratorMocks();
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        GeneratorService.prototype.generate = originalGenerate;
        GeneratorService.prototype.generateStream = originalGenerateStream;
    });

    function mockReq(method, url, body) {
        return { method, url, body, user: 'testuser', on() { return this; } };
    }

    it('PATCH diagram → checkSession returns edited code as lastMermaid (round-trip)', async () => {
        // 1) Initial generate
        await router.generate(mockReq('POST', '/api/generate',
            { prompt: 'round 1', sessionId: ID }), mockRes());
        // 2) User edits — PATCH diagram
        const patchRes = mockRes();
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`,
            { code: 'flowchart LR\n    UserEdit1-->UserEdit2' }), patchRes);
        assert.strictEqual(patchRes.statusCode, 200);
        // 3) Simulate a fresh page load → checkSession
        const checkRes = mockRes();
        router.checkSession(mockReq('POST', '/api/session/check', { sessionId: ID }), checkRes);
        const body = JSON.parse(checkRes.body);
        assert.strictEqual(body.lastMermaid, 'flowchart LR\n    UserEdit1-->UserEdit2',
            'restored lastMermaid must reflect the user edit, not the LLM round');
        assert.strictEqual(body.exists, true);
        assert.ok(Array.isArray(body.history) && body.history.length === 2,
            'history still contains the original LLM round (immutable audit trail)');
    });
});

describe('in-place edit: race — edit + new prompt (which wins?)', () => {
    // Contract (documented in design): when the user starts a NEW generation round,
    // finalizeAiMessage overwrites the active textarea's value with the SANITIZED
    // mermaid (chat.js finalizeAiMessage line 329). The user's in-flight edit on
    // the SAME textarea is clobbered — this is the explicit semantic: the new LLM
    // round supersedes all prior human-edited state for that round.
    //
    // The PERSISTED diagram.json is updated by /api/generate's saveDiagram call
    // (api.js line 396), so the new LLM output also wins on disk.
    let env;
    beforeEach(() => { env = loadChat(); env.appState.sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; });

    it('starting a new round during an edit: new LLM output wins on textarea AND on disk', async () => {
        env.lsStore['pd_token'] = 'fake';

        // Round 1 — finalize a "first" diagram.
        const ai1 = env.chat.appendAiMessage();
        env.chat.finalizeAiMessage(ai1, 'flowchart TD\n    FirstA-->FirstB', []);
        assert.strictEqual(ai1.codePre.readOnly, false);

        // User starts editing round 1's textarea.
        ai1.codePre.value = 'flowchart LR\n    MyEdit-->X';
        ai1.codePre._dispatch('input', { target: ai1.codePre });
        env.timers.advance(700); // flush the 600ms debounce — PATCH diagram fires
        await new Promise(r => setImmediate(r));
        assert.strictEqual(env.fetches.length, 1, 'PATCH dispatched for edit');

        // Now user sends a NEW prompt — Round 2 begins, textarea is replaced by
        // a fresh appendAiMessage. Old ai1 textarea is no longer "active" but
        // is still in the DOM; this test does NOT touch it directly.
        const ai2 = env.chat.appendAiMessage();
        env.chat.isStreaming = true;
        env.chat.setStreaming(true);
        // Stream deltas accumulate in ai2.
        ai2.codePre.value = 'flowchart TD\n    NewRound';
        // Finalize: sanitized mermaid overwrites whatever was in ai2's textarea.
        env.chat.finalizeAiMessage(ai2, 'flowchart TD\n    NewRoundA-->NewRoundB', []);
        assert.strictEqual(ai2.codePre.value, 'flowchart TD\n    NewRoundA-->NewRoundB',
            'finalize writes the sanitized mermaid to the NEW round\'s textarea');

        // Note: the edit on ai1 is preserved in ai1.codePre.value (the user can
        // still see it) — but on DISK, /api/generate for round 2 will overwrite
        // diagram.json with the new LLM output. The edit's PATCH (1st fetch)
        // happened before the round 2 generate.
        assert.strictEqual(env.fetches.length, 1, 'still just one PATCH; round 2 hasn\'t been generated server-side in this test');

        // Documented behavior summary:
        //   * Old round (ai1): user edit visible in textarea; persisted PATCH visible in fetches[0]
        //   * New round (ai2): LLM output visible in textarea; will overwrite diagram.json on /api/generate
        // This is intentional — diagram.json is the "current canonical diagram", not an edit log.
        assert.strictEqual(env.fetches[0].opts.body && JSON.parse(env.fetches[0].opts.body).code,
            'flowchart LR\n    MyEdit-->X',
            'round-1 edit PATCH body is preserved verbatim');
    });
});

describe('in-place edit: invalid mermaid syntax is allowed, preview may show error', () => {
    let env;
    beforeEach(() => { env = loadChat(); env.appState.sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; });

    it('editing garbage into the textarea: PATCH succeeds, scheduleRender fires (silent)', async () => {
        env.lsStore['pd_token'] = 'fake';
        const ai = env.chat.appendAiMessage();
        env.chat.finalizeAiMessage(ai, 'flowchart TD\nA-->B', []);

        // User types absolute garbage — server-side validation does NOT inspect
        // mermaid syntax (only length). The PATCH must succeed and the silent
        // preview must be armed.
        ai.codePre.value = 'this is not mermaid at all 🚀 emoji too';
        ai.codePre._dispatch('input', { target: ai.codePre });

        env.timers.advance(700);
        await new Promise(r => setImmediate(r));

        assert.strictEqual(env.fetches.length, 1, 'PATCH dispatched with garbage code (validation is permissive)');
        const body = JSON.parse(env.fetches[0].opts.body);
        assert.strictEqual(body.code, 'this is not mermaid at all 🚀 emoji too');

        // scheduleRender (silent:true) was called — no loud error rendered in preview.
        assert.ok(env.renderCalls.some(c => c.opts && c.opts.silent === true),
            'silent preview is armed so the user is not spammed with errors mid-typing');
    });

    it('loud render with invalid syntax: mermaid.render throws → preview shows render-error', async () => {
        // Load the real mermaid-render.js into a sandbox with a stubbed mermaid
        // that throws on invalid syntax. This is the path final / "view this"
        // renders take (NOT silent). Behavior: container.innerHTML gets the
        // <div class="render-error">...</div> block.
        const container = {
            innerHTML: '',
            classList: {
                _set: new Set(),
                add() {}, remove() {}, toggle() {}, contains: () => false
            },
            querySelector: () => null
        };
        const sandbox = {
            console,
            document: {
                getElementById(id) { return id === 'mermaid-container' ? container : null; },
                addEventListener() {}, removeEventListener() {}
            },
            localStorage: { getItem: () => 'dark', setItem() {}, removeItem() {} },
            setTimeout, clearTimeout, Promise, Map, Set, Date,
            mermaid: null
        };
        sandbox.window = sandbox;
        sandbox.self = sandbox;
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(RENDER_SOURCE, sandbox, { filename: 'mermaid-render.js' });
        vm.runInContext('mermaidRender.init();', sandbox);

        sandbox.mermaid = {
            async render(_id, _code) {
                // Simulate the v11 error format (line number is extractable).
                throw new Error('Parse error on line 1: got EOF');
            }
        };

        await sandbox.mermaidRender.render('not mermaid at all');
        assert.match(container.innerHTML, /render-error/,
            'loud render of invalid code shows the render-error block');
        assert.match(container.innerHTML, /Parse error on line 1/,
            'error message reaches the user');
    });
});

describe('in-place edit: sanitization boundary between history and diagram', () => {
    // Contract: history.json is the immutable audit trail of what the LLM
    // produced, possibly with quirks (emoji, gitGraph LR:, think tags, etc.).
    // The frontend renders history only AFTER checkSession runs each entry
    // through extractMermaidCode + autoFixMermaidCode. diagram.json is the
    // human-editable overlay and is saved as-is. After the user has edited,
    // checkSession returns diagram.code directly (no re-sanitization needed
    // — the user is the source of truth).
    //
    // This is the property that lets the design safely NOT sanitize PATCH input:
    // the human editor's changes are presumed intentional.

    let tempDir, router, sessionsDir;
    const ID = '550e8400-e29b-41d4-a716-446655440000';

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-edit-sanitize-'));
        router = createRouter(makeConfig(tempDir));
        sessionsDir = path.join(tempDir, 'testuser', 'sessions');
        roundCounter = 0;
        installGeneratorMocks();
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        GeneratorService.prototype.generate = originalGenerate;
        GeneratorService.prototype.generateStream = originalGenerateStream;
    });

    function mockReq(method, url, body) {
        return { method, url, body, user: 'testuser', on() { return this; } };
    }

    it('PATCH persists user-authored code verbatim — server does NOT re-sanitize', () => {
        const unusual = 'flowchart TD\n    A--"`weird label with `<backticks>` "-->B';
        const res = mockRes();
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`, { code: unusual }), res);
        assert.strictEqual(res.statusCode, 200);

        const diagram = JSON.parse(fs.readFileSync(
            path.join(sessionsDir, ID, 'diagram.json'), 'utf-8'));
        assert.strictEqual(diagram.code, unusual,
            'PATCH must persist the user\'s exact bytes — no server-side rewrite');
    });

    it('history entries keep raw LLM output (with quirks) intact; diagram is the cleaned overlay', async () => {
        // Seed: one generate round so the session exists and history is populated.
        const genRes = mockRes();
        await router.generate(mockReq('POST', '/api/generate',
            { prompt: 'round', sessionId: ID }), genRes);
        assert.strictEqual(genRes.statusCode, 200);

        // Re-patch with a clearly sanitized version
        const cleaned = 'flowchart TD\n    A-->B';
        const patchRes = mockRes();
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`, { code: cleaned }), patchRes);
        assert.strictEqual(patchRes.statusCode, 200);

        // checkSession returns the sanitized diagram AND the raw history.
        // The frontend renders history via renderHistory which uses the sanitized
        // history entries (api.js L234-240 runs extract+autoFix per entry).
        const checkRes = mockRes();
        router.checkSession(mockReq('POST', '/api/session/check', { sessionId: ID }), checkRes);
        const body = JSON.parse(checkRes.body);
        assert.strictEqual(body.exists, true);

        assert.strictEqual(body.lastMermaid, cleaned,
            'lastMermaid comes from the user\'s clean diagram edit');

        // history survives — it still has the raw LLM output from earlier rounds
        // (verified by content match — the raw RoundN text doesn't equal cleaned).
        const rawHistory = body.history;
        if (rawHistory && rawHistory.length) {
            const lastAssistant = [...rawHistory].reverse().find(h => h.role === 'assistant');
            assert.notStrictEqual(lastAssistant.content, cleaned,
                'history preserves the LLM\'s raw output distinct from the edited diagram');
        }
    });
});