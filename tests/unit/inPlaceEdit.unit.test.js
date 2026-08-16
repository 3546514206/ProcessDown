'use strict';

/**
 * In-place Mermaid code editing feature — client-side unit tests.
 *
 * 覆盖目标（chat.js 的 in-place 编辑）：
 *   1) appendAiMessage 现在创建 <textarea>（不是 <pre>），初始 readOnly=true
 *   2) 用户输入触发 _onCodeEdited，同步驱动 scheduleRender（silent preview）
 *      与 _scheduleDiagramSave（节流 PATCH）
 *   3) 600ms 防抖节奏与 scheduleRender 共享同一 timer 调色板
 *   4) finalizeAiMessage 移除 readOnly，开放编辑
 *   5) renderHistory 用 .value（不是 .textContent）回填，readOnly=false
 *   6) 流式期间编辑被原生 readonly 属性阻断（DOM 级防御）
 *   7) 切会话 / 清空 / 登出 路径会 flushPendingDiagramSave
 *   8) localStorage 失败入队 pd_pending_saves（_enqueuePendingSave / _drainPendingSaves）
 *
 * 复用 mermaidRenderErrorHints.test.js 的 vm.runInNewContext 沙箱模式：
 * chat.js 是浏览器脚本、依赖 window.app / window.mermaidRender / fetch / localStorage，
 * 不能直接 require。沙箱里全部 stub 掉，集中验证 DOM 构造 + 事件流 + 节流逻辑。
 *
 * 计时器策略：沙箱内替换 setTimeout/clearTimeout 为可手动 flush 的 fake timers。
 * 这避开了 node:test mock.timers 影响主进程定时器的副作用，也避免真等 600ms。
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_PATH = path.join(__dirname, '..', '..', 'public', 'js', 'chat.js');
const CHAT_SOURCE = fs.readFileSync(CHAT_PATH, 'utf8');

/**
 * Build a fresh sandbox that loads chat.js with all stubs wired.
 * Returns { sandbox, dom, timers, fetches, pendingSaves }.
 */
function loadChat() {
    // ---- Fake timers: capture callbacks so tests can flush them deterministically ----
    let now = 1000000;
    const pending = new Map(); // id -> { fn, due }
    let nextId = 1;
    const fakeSetTimeout = (fn, delay) => {
        const id = nextId++;
        pending.set(id, { fn, due: now + (delay || 0) });
        return id;
    };
    const fakeClearTimeout = (id) => { pending.delete(id); };
    const flushTimers = () => {
        // Snapshot the pending set so timers scheduled by timers don't recurse infinitely.
        const due = [...pending.entries()]
            .filter(([_, t]) => t.due <= now)
            .sort((a, b) => a[1].due - b[1].due);
        for (const [id, t] of due) {
            pending.delete(id);
            t.fn();
        }
    };
    const advance = (ms) => {
        now += ms;
        flushTimers();
    };

    // ---- DOM ----
    // Minimal DOM stub: track appended children, support createElement / addEventListener.
    const messages = makeContainer('chat-messages');
    const welcome = { hidden: true };
    const textarea = makeContainer('chat-textarea');
    textarea.value = '';
    textarea.style = {};
    const send = makeContainer('chat-send');
    send.querySelector = (sel) => sel === '.icon-send' ? { style: {} } : sel === '.icon-stop' ? { style: {} } : null;
    const scrollBtn = makeContainer('scroll-bottom-btn');
    const status = { textContent: '', className: '' };
    const documentStub = {
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
    };

    // ---- Capture fetch calls (PATCH /api/session/.../diagram) ----
    const fetches = [];
    const fetchStub = (url, opts = {}) => {
        fetches.push({ url, opts });
        // For PATCH diagram: succeed by default unless test sets shouldFail
        return Promise.resolve({
            ok: !fetchStub._shouldFail,
            status: fetchStub._shouldFail ? 500 : 200,
            json: async () => ({ success: true })
        });
    };

    // ---- Localstorage ----
    const lsStore = {};
    const localStorageStub = {
        getItem: (k) => k in lsStore ? lsStore[k] : null,
        setItem: (k, v) => { lsStore[k] = String(v); },
        removeItem: (k) => { delete lsStore[k]; },
        clear: () => { for (const k in lsStore) delete lsStore[k]; }
    };

    // ---- Window.app (stubs) ----
    const ensureSession = async () => {};
    const appState = { sessionId: '11111111-2222-3333-4444-555555555555', user: 'alice' };
    const appStub = {
        state: appState,
        ensureSession,
        loadSessions: async () => {},
        showToast: () => {},
        updateStatus: () => {},
        showLoginMask: () => {}
    };

    // ---- Window.mermaidRender (record render calls + provide clear) ----
    const renderCalls = [];
    const mermaidRenderStub = {
        init() {},
        async render(code, opts) {
            renderCalls.push({ code, opts });
            // Simulate the silent / non-silent contract: silent means we don't mutate.
            return { svg: '<svg></svg>' };
        },
        clear() {}
    };

    // ---- Sandbox ----
    const sandbox = {
        console,
        document: documentStub,
        window: null,
        self: null,
        globalThis: null,
        localStorage: localStorageStub,
        fetch: fetchStub,
        setTimeout: fakeSetTimeout,
        clearTimeout: fakeClearTimeout,
        Date: { now: () => now },
        navigator: { clipboard: { writeText: async () => {} } },
        Promise,
        Map,
        Set,
        Array,
        Object,
        JSON,
        Math,
        String,
        Number,
        Boolean,
        Error,
        URL,
        Symbol,
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
    // chat.js auto-runs init() on DOMContentLoaded; we call init directly here.
    vm.runInContext('chat.init();', sandbox);

    return {
        sandbox,
        chat: sandbox.chat,
        dom: { messages, welcome, textarea, send, scrollBtn, status },
        timers: { advance, pending, now: () => now },
        fetches,
        renderCalls,
        lsStore,
        appState
    };
}

function makeContainer(tag) {
    const children = [];
    const listeners = {};
    return {
        tagName: tag.toUpperCase(),
        children,
        className: '',
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
        style: {},
        hidden: false,
        dataset: {},
        readOnly: false,
        spellcheck: true,
        wrap: 'soft',
        value: '',
        textContent: '',
        scrollHeight: 100,
        scrollTop: 0,
        clientHeight: 100,
        addEventListener(name, fn) {
            (listeners[name] = listeners[name] || []).push(fn);
        },
        removeEventListener(name, fn) {
            if (!listeners[name]) return;
            listeners[name] = listeners[name].filter(x => x !== fn);
        },
        _dispatch(name, evt) {
            (listeners[name] || []).forEach(fn => fn(evt || {}));
        },
        appendChild(c) { children.push(c); return c; },
        removeChild(c) {
            const i = children.indexOf(c);
            if (i >= 0) children.splice(i, 1);
        },
        remove() { /* parent will drop */ },
        querySelector(sel) {
            if (sel === '.think-label') return { textContent: '' };
            // onError 会取 root 下的代码面板做隐藏；按 className 在直接子节点里找，
            // 够用且不引入真正的选择器引擎
            if (sel === '.code-details') {
                return children.find(c => String(c.className).includes('code-details')) || null;
            }
            return null;
        },
        querySelectorAll() { return []; }
    };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('chat.js: in-place code editing — DOM construction', () => {
    let env;
    beforeEach(() => { env = loadChat(); });

    it('appendAiMessage creates a <textarea> (not <pre>) with readOnly=true initially', () => {
        const ai = env.chat.appendAiMessage();
        assert.strictEqual(ai.codePre.tagName, 'TEXTAREA',
            'code panel must be a TEXTAREA so the browser provides cursor / paste / undo');
        assert.strictEqual(ai.codePre.readOnly, true,
            'code panel must start readOnly so streaming deltas are not corrupted by stray edits');
        assert.strictEqual(ai.codePre.spellcheck, false,
            'spellcheck off — code editor, not prose');
        assert.strictEqual(ai.codePre.wrap, 'off',
            'wrap=off preserves newline semantics; wrap=soft would inject visual line breaks');
        assert.strictEqual(ai.codePre.className, 'code-pre',
            'class preserved so chat.css .code-pre rules still apply');
    });

    it('appendAiMessage places the textarea inside the <details> so collapse still works', () => {
        const ai = env.chat.appendAiMessage();
        // Walk: message-ai -> details -> summary + textarea
        const root = ai.root;
        const details = root.children.find(c => c.tagName === 'DETAILS');
        assert.ok(details, 'message-ai must contain a <details>');
        const summary = details.children.find(c => c.tagName === 'SUMMARY');
        const codePre = details.children.find(c => c.tagName === 'TEXTAREA');
        assert.ok(summary, '<details> contains <summary>');
        assert.ok(codePre, '<details> contains <textarea>');
        assert.strictEqual(codePre, ai.codePre, 'returned codePre is the same node as in the details');
    });
});

describe('chat.js: in-place code editing — input handler', () => {
    let env;
    beforeEach(() => { env = loadChat(); env.appState.sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; });

    it('input event triggers _onCodeEdited which updates currentMermaid and schedules render', () => {
        const ai = env.chat.appendAiMessage();
        env.chat.finalizeAiMessage(ai, 'flowchart TD\nA-->B', []);
        // After finalize: readOnly is removed and value is the sanitized mermaid.
        assert.strictEqual(ai.codePre.readOnly, false);
        assert.strictEqual(ai.codePre.value, 'flowchart TD\nA-->B');

        // User types — replace value with a hand edit and fire input event.
        ai.codePre.value = 'flowchart LR\nX-->Y';
        ai.codePre._dispatch('input', { target: ai.codePre });

        assert.strictEqual(env.chat.currentMermaid, 'flowchart LR\nX-->Y',
            '_onCodeEdited must mirror the textarea into currentMermaid so regen uses the edit as seed');

        // scheduleRender should be armed (debounce timer present in pending map).
        assert.ok(env.timers.pending.size > 0, 'a render timer should be armed after edit');
        // Advance past 600ms — silent render should fire.
        env.timers.advance(700);
        assert.ok(env.renderCalls.some(c => c.code === 'flowchart LR\nX-->Y' && c.opts && c.opts.silent === true),
            'scheduleRender should have rendered the edited code with silent:true');
    });

    it('input event arms _scheduleDiagramSave with 600ms debounce and dispatches PATCH', async () => {
        // Pretend the user is logged in so the Bearer header is attached.
        env.lsStore['pd_token'] = 'fake-token-abc';
        const ai = env.chat.appendAiMessage();
        env.chat.finalizeAiMessage(ai, 'flowchart TD\nA-->B', []);
        ai.codePre.value = 'flowchart LR\nC-->D';
        ai.codePre._dispatch('input', { target: ai.codePre });

        // No PATCH yet (still debounced).
        assert.strictEqual(env.fetches.length, 0, 'no PATCH immediately on edit');

        env.timers.advance(700); // flush the 600ms debounce

        // Wait one microtask for fetch promise resolution.
        await new Promise(r => setImmediate(r));

        assert.strictEqual(env.fetches.length, 1, 'one PATCH dispatched after debounce');
        const f = env.fetches[0];
        assert.match(f.url, /\/api\/session\/[^/]+\/diagram$/);
        assert.strictEqual(f.opts.method, 'PATCH');
        const body = JSON.parse(f.opts.body);
        assert.strictEqual(body.code, 'flowchart LR\nC-->D');
        assert.match(f.opts.headers.Authorization, /^Bearer /, 'PATCH carries Bearer token');
    });

    it('multiple edits within the debounce window only dispatch one PATCH (latest value wins)', async () => {
        const ai = env.chat.appendAiMessage();
        env.chat.finalizeAiMessage(ai, 'flowchart TD\nA-->B', []);
        ai.codePre.value = 'flowchart LR\nA';
        ai.codePre._dispatch('input', { target: ai.codePre });
        env.timers.advance(100); // before debounce fires
        ai.codePre.value = 'flowchart LR\nA-->B';
        ai.codePre._dispatch('input', { target: ai.codePre });
        env.timers.advance(100);
        ai.codePre.value = 'flowchart LR\nA-->B-->C';
        ai.codePre._dispatch('input', { target: ai.codePre });

        env.timers.advance(700); // cross 600ms from first edit
        await new Promise(r => setImmediate(r));

        assert.strictEqual(env.fetches.length, 1, 'only one PATCH dispatched across multiple keystrokes');
        const body = JSON.parse(env.fetches[0].opts.body);
        assert.strictEqual(body.code, 'flowchart LR\nA-->B-->C',
            'latest edit wins (not the value at timer creation)');
    });
});

describe('chat.js: in-place code editing — finalize & restore', () => {
    let env;
    beforeEach(() => { env = loadChat(); });

    it('finalizeAiMessage removes readOnly and replaces value with sanitized mermaid', () => {
        const ai = env.chat.appendAiMessage();
        // Simulate streaming accumulation of raw text (then sanitization happens on finalize).
        ai.codePre.value = 'flowchart TD\nA-->B';
        env.chat.finalizeAiMessage(ai, 'flowchart TD\nA-->B', []);
        assert.strictEqual(ai.codePre.readOnly, false, 'finalize must drop the streaming lock');
        assert.strictEqual(ai.codePre.value, 'flowchart TD\nA-->B');
    });

    it('finalizeAiMessage also unlocks when mermaid is empty (LLM extraction failed)', () => {
        const ai = env.chat.appendAiMessage();
        // empty mermaid path: still unlock so the user can hand-write the fix
        env.chat.finalizeAiMessage(ai, '', []);
        assert.strictEqual(ai.codePre.readOnly, false,
            'empty mermaid path still opens the textarea — user-driven recovery');
    });

    it('renderHistory sets .value (not textContent) and unlocks the textarea', () => {
        const history = [
            { role: 'user', content: '画图' },
            { role: 'assistant', content: 'flowchart TD\nA-->B' }
        ];
        env.chat.renderHistory(history);
        const assistantMsg = env.dom.messages.children.find(c => c.className.includes('message-ai'));
        const textarea = assistantMsg.children
            .find(c => c.tagName === 'DETAILS')
            .children.find(c => c.tagName === 'TEXTAREA');
        assert.strictEqual(textarea.value, 'flowchart TD\nA-->B');
        assert.strictEqual(textarea.textContent, '',
            'renderHistory writes .value (the editable surface); .textContent stays empty');
        assert.strictEqual(textarea.readOnly, false,
            'restored messages must be editable from day-zero');
    });
});

describe('chat.js: in-place code editing — race conditions', () => {
    let env;
    beforeEach(() => { env = loadChat(); env.appState.sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; });

    it('edit during streaming is blocked by native readOnly attribute (browser gate)', () => {
        // The defense contract is the textarea's readOnly HTML attribute: while readOnly=true,
        // the BROWSER itself rejects keystrokes — no input event fires. We assert on that
        // attribute here, which is the load-bearing invariant. (A programmatic input event
        // bypasses the gate, but real users cannot trigger one.)
        const ai1 = env.chat.appendAiMessage();
        env.chat.finalizeAiMessage(ai1, 'flowchart TD\nA-->B', []);
        const ai2 = env.chat.appendAiMessage();
        env.chat.isStreaming = true;
        env.chat.setStreaming(true);
        assert.strictEqual(ai2.codePre.readOnly, true,
            'streaming textarea must be readOnly — the browser is the gate');

        // Simulate streaming delta accumulation (this is the only writer while readOnly=true).
        ai2.codePre.value = 'flowchart TD\nC';
        ai2.codePre.value += '-->D';

        // finalizeAiMessage is the single source of truth for the post-stream value:
        // it overwrites whatever raw accumulated text with the SANITIZED mermaid.
        env.chat.finalizeAiMessage(ai2, 'flowchart TD\nC-->D', []);
        assert.strictEqual(ai2.codePre.value, 'flowchart TD\nC-->D',
            'finalizeAiMessage overwrites any accumulated raw text with sanitized mermaid');
        assert.strictEqual(ai2.codePre.readOnly, false,
            'finalize unlocks so the user can now edit');
    });

    it('user edits AFTER streaming completes trigger PATCH normally (smoke)', async () => {
        // Companion to the streaming-blocked test: once readOnly is dropped by finalize,
        // a subsequent input event should reach the diagram-save path.
        env.lsStore['pd_token'] = 'fake-token-abc';
        const ai = env.chat.appendAiMessage();
        env.chat.finalizeAiMessage(ai, 'flowchart TD\nA-->B', []);
        ai.codePre.value = 'flowchart LR\nX-->Y';
        ai.codePre._dispatch('input', { target: ai.codePre });
        env.timers.advance(700);
        await new Promise(r => setImmediate(r));
        assert.strictEqual(env.fetches.length, 1, 'post-stream edit dispatches PATCH as designed');
    });

    it('clear() flushes any pending diagram save before clearing', async () => {
        const ai = env.chat.appendAiMessage();
        env.chat.finalizeAiMessage(ai, 'flowchart TD\nA-->B', []);
        ai.codePre.value = 'flowchart LR\nX-->Y';
        ai.codePre._dispatch('input', { target: ai.codePre });
        // 600ms hasn't elapsed — timer is still pending.
        env.timers.advance(100);
        assert.strictEqual(env.fetches.length, 0, 'still in debounce window');

        env.chat.clear();
        await new Promise(r => setImmediate(r));

        assert.strictEqual(env.fetches.length, 1,
            'clear() must flush the pending PATCH so the in-flight edit is not lost on session switch');
        const body = JSON.parse(env.fetches[0].opts.body);
        assert.strictEqual(body.code, 'flowchart LR\nX-->Y',
            'flushed save carries the latest typed value');
    });
});

describe('chat.js: in-place code editing — failure & retry', () => {
    let env;
    beforeEach(() => { env = loadChat(); env.appState.sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; });

    it('failed PATCH is enqueued to localStorage pd_pending_saves', async () => {
        env.sandbox.fetch._shouldFail = true;
        const ai = env.chat.appendAiMessage();
        env.chat.finalizeAiMessage(ai, 'flowchart TD\nA-->B', []);
        ai.codePre.value = 'flowchart LR\nQ';
        ai.codePre._dispatch('input', { target: ai.codePre });
        env.timers.advance(700);
        await new Promise(r => setImmediate(r));

        const raw = env.lsStore['pd_pending_saves'];
        assert.ok(raw, 'failed save must be enqueued');
        const queue = JSON.parse(raw);
        assert.strictEqual(queue.length, 1);
        assert.strictEqual(queue[0].code, 'flowchart LR\nQ');
        assert.strictEqual(queue[0].sessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('successful PATCH drains the pending queue (best-effort FIFO)', async () => {
        // Pre-populate the queue with a stale failure.
        env.lsStore['pd_pending_saves'] = JSON.stringify([
            { sessionId: 'old-session-a', code: 'flowchart TD\nOLD', ts: Date.now() - 10000 }
        ]);
        env.sandbox.fetch._shouldFail = false;

        const ai = env.chat.appendAiMessage();
        env.chat.finalizeAiMessage(ai, 'flowchart TD\nA-->B', []);
        ai.codePre.value = 'flowchart LR\nFRESH';
        ai.codePre._dispatch('input', { target: ai.codePre });
        env.timers.advance(700);
        await new Promise(r => setImmediate(r));
        // Let drain's async IIFE settle.
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));

        const urls = env.fetches.map(f => f.url);
        assert.ok(urls.some(u => u.includes('old-session-a')),
            'the stale queued save must be drained on the next successful PATCH');
        assert.ok(urls.some(u => u.includes('aaaaaaaa-bbbb')),
            'the current session save must still go through');
        // The queue should be empty (or only contain items that re-failed, which ours did not).
        const remaining = env.lsStore['pd_pending_saves'];
        const remainingArr = remaining ? JSON.parse(remaining) : [];
        assert.strictEqual(remainingArr.length, 0,
            'queue should drain on success — no leftover failures');
    });
});
// -----------------------------------------------------------------------------
// Round 3 回归：编辑丢失 / 按钮读陈旧值 / PATCH body 未解析
// -----------------------------------------------------------------------------

describe('chat.js: 恢复会话时消费 lastMermaid（用户编辑优先）', () => {
    let env;
    beforeEach(() => { env = loadChat(); });

    it('renderHistory 用 lastMermaid 覆盖最后一轮的 LLM 原文', () => {
        const history = [
            { role: 'user', content: '画个注册流程' },
            { role: 'assistant', content: 'flowchart TD\nLLM-->ORIGINAL' }
        ];
        env.chat.renderHistory(history, 'flowchart LR\nUSER-->EDIT');

        assert.strictEqual(env.chat.currentMermaid, 'flowchart LR\nUSER-->EDIT',
            'diagram.json 里的用户编辑必须优先于 history 的 LLM 原文');
        assert.ok(env.renderCalls.some(c => c.code === 'flowchart LR\nUSER-->EDIT'),
            '预览区渲染的应是用户编辑后的图');
    });

    it('无 lastMermaid 时回落到 history 最后一条 assistant', () => {
        const history = [
            { role: 'user', content: 'p' },
            { role: 'assistant', content: 'flowchart TD\nA-->B' }
        ];
        env.chat.renderHistory(history, null);
        assert.strictEqual(env.chat.currentMermaid, 'flowchart TD\nA-->B');
    });
});

describe('chat.js: 操作按钮读取编辑后的实时内容', () => {
    let env;
    beforeEach(() => { env = loadChat(); });

    it('查看此图 / 复制代码 用 textarea.value，而非陈旧的 _mermaid', () => {
        const ai = env.chat.appendAiMessage('本轮提示词');
        ai.root._mermaid = 'flowchart TD\nSTALE';
        ai.codePre.value = 'flowchart LR\nEDITED';

        const btns = ai.actionRow.children;
        btns[0]._dispatch('click');   // 查看此图
        assert.strictEqual(env.chat.currentMermaid, 'flowchart LR\nEDITED');

        let copied = null;
        env.sandbox.navigator.clipboard.writeText = (t) => { copied = t; return Promise.resolve(); };
        btns[1]._dispatch('click');   // 复制代码
        assert.strictEqual(copied, 'flowchart LR\nEDITED');
    });

    it('中断轮（_mermaid 未设置）复制的是已流式累积的内容，而不是空串', () => {
        const ai = env.chat.appendAiMessage('本轮提示词');
        ai.codePre.value = 'flowchart TD partial';
        let copied = null;
        env.sandbox.navigator.clipboard.writeText = (t) => { copied = t; return Promise.resolve(); };
        ai.actionRow.children[1]._dispatch('click');
        assert.strictEqual(copied, 'flowchart TD partial', '按钮不应对用户撒谎（toast 已复制却是空串）');
    });

    it('重新生成回放本轮的 user 指令，而非全局最后一条', () => {
        env.chat.messages.push({ role: 'user', content: '第三轮提示词' });
        const ai = env.chat.appendAiMessage('第一轮提示词');
        // 桩掉 sendMessage：这里只验证"回填哪条指令"，不跑真实流式
        env.chat.sendMessage = () => {};
        ai.actionRow.children[2]._dispatch('click');
        assert.strictEqual(env.dom.textarea.value, '第一轮提示词',
            '每轮的重新生成按钮是 per-round 可供性，必须重放本轮指令');
    });
});

describe('chat.js: 空内容不落盘', () => {
    let env;
    beforeEach(() => { env = loadChat(); env.appState.sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; });

    it('清空 textarea 不触发 PATCH（防抖竞态误抹预览）', async () => {
        const ai = env.chat.appendAiMessage('p');
        ai.codePre.value = '   ';
        ai.codePre._dispatch('input', { target: ai.codePre });
        env.timers.advance(700);
        await new Promise(r => setImmediate(r));
        assert.strictEqual(env.fetches.filter(f => f.url.includes('/diagram')).length, 0);
    });
});

describe('chat.js: 生成出错后仍可编辑（onError 解锁）', () => {
    let env;
    beforeEach(() => { env = loadChat(); env.appState.sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; });

    // 驱动 sendMessage 但桩掉 streamGenerate，拿到那组回调后手动触发 onError，
    // 这是唯一能覆盖出错分支的入口（回调是 sendMessage 里的闭包）
    async function startRound() {
        let captured = null;
        env.chat.streamGenerate = (opts) => { captured = opts; };
        env.dom.textarea.value = '画个流程图';
        await env.chat.sendMessage();
        return captured;
    }

    it('出错时保留已流出的半截代码，并解除 readOnly 供用户改后保存', async () => {
        const cbs = await startRound();
        const codePre = env.chat._activeCodePre;
        assert.strictEqual(codePre.readOnly, true, '流式期间应上锁');

        cbs.onContent('flowchart TD\n    A-->');
        cbs.onError('LLM 服务不可用', '');

        assert.strictEqual(codePre.readOnly, false,
            '出错轮必须解锁，否则用户永远改不了这一轮的代码（与 onAbort/finalize 对称）');
        assert.strictEqual(codePre.value, 'flowchart TD\n    A-->', '半截代码不该被清掉');
    });

    it('有残片时代码面板不隐藏——隐藏会让解锁变成空动作', async () => {
        const cbs = await startRound();
        cbs.onContent('flowchart TD\n    A-->');
        cbs.onError('boom', '');

        const root = env.dom.messages.children[env.dom.messages.children.length - 1];
        const panel = root.querySelector('.code-details');
        assert.ok(panel, '代码面板应仍在 DOM 里');
        assert.notStrictEqual(panel.style.display, 'none', '有残片就该留着给用户改');
    });

    it('一个字都没流出来时仍隐藏空面板（保持原有观感）', async () => {
        const cbs = await startRound();
        cbs.onError('鉴权失败', '请重新登录');

        const root = env.dom.messages.children[env.dom.messages.children.length - 1];
        const panel = root.querySelector('.code-details');
        assert.strictEqual(panel.style.display, 'none', '空面板无内容可编辑，隐藏更干净');
    });
});
