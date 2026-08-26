/**
 * 欢迎场景 "作弊 key 透传" 烟雾测试：用 jsdom 加载 public/index.html + chat.js，
 * 验证 chat.js 的 welcomeKey 透传行为——chip 触发的那一轮 sendMessage 应把
 * 对应的 data-example-key 注入 fetch body（/api/generate/stream），后续用户
 * 自输入的 sendMessage 不应携带 welcomeKey。
 *
 * 契约：
 *   - state 新增 _pendingWelcomeKey: null
 *   - bindExampleChips 里 chip click 同步设 _pendingWelcomeKey = chip.dataset.exampleKey
 *   - sendMessage 同步取出后清空，并把该值透传给 streamGenerate
 *   - streamGenerate 在 fetch body 里写 welcomeKey: welcomeKey || undefined
 *
 * 跑法：npm test（自动包含 tests/unit/）。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ---- EXAMPLE_PROMPTS 提取（与 frontendExampleChips.smoke.test.js 同套路）----
function examplePrompts() {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
    const start = src.indexOf('const EXAMPLE_PROMPTS = {');
    const end = src.indexOf('\n};', start);
    const body = src.slice(start, end);
    const entries = {};
    const re = /'([^']+)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(body)) !== null) entries[m[1]] = m[2];
    return entries;
}

function emptyStream() {
    // 让 streamGenerate 的 reader 立刻 done：while 一次迭代 break，
    // finally 兜底走 onError('连接已断开，请重试')，setStreaming(false)
    // 把 isStreaming 复位，下一轮 sendMessage 才能进入
    return {
        getReader() {
            return {
                read: async () => ({ done: true, value: undefined }),
                cancel: async () => {}
            };
        }
    };
}

function loadPage(opts = {}) {
    const errs = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errs.push('[jsdomError] ' + (e.stack || e.message || String(e))));
    vc.on('error', (...m) => errs.push('[error] ' + m.map(String).join(' ')));

    const dom = new JSDOM(html, {
        url: 'http://127.0.0.1:3000/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        virtualConsole: vc
    });
    const w = dom.window;

    // mermaid 占位（app.js eval 时 initMermaid 会调 mermaid.initialize）
    w.mermaid = {
        initialize() {},
        render: async () => ({ svg: '<svg></svg>' })
    };
    w.navigator.clipboard = { writeText: async () => {} };

    // 顺序加载脚本（与 index.html 一致）
    const scripts = ['app.js', 'chat.js', 'mermaid-render.js', 'components.js'];
    for (const s of scripts) {
        const code = fs.readFileSync(path.join(ROOT, 'public', 'js', s), 'utf8');
        try {
            w.eval(code);
        } catch (e) {
            errs.push('[eval ' + s + '] ' + (e && e.message || String(e)));
        }
    }
    // DOMContentLoaded → chat.init() 真正绑好 textarea / send 引用
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

    // 覆盖 app（app.js eval 时挂了真实的 app，这里 patch 成可控 mock——
    // 确保 chip click 触发的 ensureSession / updateStatus / showToast 走 mock）
    w.app = {
        showToast: () => {},
        updateStatus: () => {},
        ensureSession: async () => { return null; },
        loadSessions: () => {},
        getSiteTheme: () => 'light',
        state: { sessionId: 'test-session-uuid', user: { username: 'tester' } }
    };

    // fetch 拦截：每次调用捕获 url + init.body
    const calls = [];
    w.fetch = (url, init) => {
        calls.push({ url: String(url), init: init || {} });
        return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
            body: emptyStream()
        });
    };

    return { dom, window: w, document: w.document, errs, calls };
}

function waitTick(ms = 30) {
    // flush 微任务队列（多个 await 链）+ 一点点缓冲
    return new Promise((r) => setTimeout(r, ms));
}

describe('欢迎场景 chip 触发 fetch body 含 welcomeKey', () => {
    it('DOM 存在：4 个 .example-chip 都有 data-example-key', () => {
        const { document } = loadPage();
        const chips = document.querySelectorAll('.example-chip');
        assert.equal(chips.length, 4, '必须有 4 个 chip');
        for (const c of chips) {
            assert.ok(c.dataset.exampleKey, 'chip 必须有 data-example-key');
        }
    });

    it('chat state 初始有 _pendingWelcomeKey: null', () => {
        const { window } = loadPage();
        assert.equal(window.chat._pendingWelcomeKey, null,
            '初始 _pendingWelcomeKey 必须为 null');
    });

    it('点击 chip 后 fetch body 含 welcomeKey=c4-ecommerce，prompt 等于 EXAMPLE_PROMPTS[key]', async () => {
        const { window, document, calls } = loadPage();
        const key = 'c4-ecommerce';
        const expectedPrompt = examplePrompts()[key];

        const chip = document.querySelector(`.example-chip[data-example-key="${key}"]`);
        assert.ok(chip, `必须有 data-example-key=${key} 的 chip`);
        chip.click();

        // chip click 同步设 _pendingWelcomeKey、填 textarea、调 sendMessage；
        // sendMessage 同步段立即消费 _pendingWelcomeKey（赋 null）并把它作为
        // welcomeKey 透传给 streamGenerate。所以 chip.click 返回后
        // _pendingWelcomeKey 已经被清空、textarea 也已被清空（sendMessage 收尾），
        // 真实透传的证据落在 fetch body 上
        assert.equal(window.chat._pendingWelcomeKey, null,
            'chip click 后 _pendingWelcomeKey 应已被 sendMessage 消费清空');

        await waitTick();

        assert.equal(calls.length, 1, '应有 1 次 fetch 调用，实际 ' + calls.length);
        assert.match(calls[0].url, /\/api\/generate\/stream/,
            'fetch URL 应是 /api/generate/stream，实际 ' + calls[0].url);

        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.welcomeKey, key,
            `fetch body 应含 welcomeKey=${key}，实际 ${JSON.stringify(body.welcomeKey)}`);
        assert.equal(body.prompt, expectedPrompt,
            'fetch body.prompt 必须等于 EXAMPLE_PROMPTS[key]（chip 填入 textarea 的文本）');
        assert.equal(body.sessionId, 'test-session-uuid',
            'sessionId 应从 app.state 透传');
    });

    it('点击不同 chip 透传对应 key：mindmap-genai', async () => {
        const { window, document, calls } = loadPage();
        const key = 'mindmap-genai';
        const expectedPrompt = examplePrompts()[key];

        document.querySelector(`.example-chip[data-example-key="${key}"]`).click();
        await waitTick();

        assert.equal(calls.length, 1);
        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.welcomeKey, key,
            '不同 chip 应透传各自 key，实际 ' + body.welcomeKey);
        assert.equal(body.prompt, expectedPrompt);
    });

    it('点击不同 chip 透传对应 key：git-enterprise-flow', async () => {
        const { window, document, calls } = loadPage();
        const key = 'git-enterprise-flow';
        const expectedPrompt = examplePrompts()[key];

        document.querySelector(`.example-chip[data-example-key="${key}"]`).click();
        await waitTick();

        assert.equal(calls.length, 1);
        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.welcomeKey, key);
        assert.equal(body.prompt, expectedPrompt);
    });

    it('点击不同 chip 透传对应 key：seq-spring-bean', async () => {
        const { window, document, calls } = loadPage();
        const key = 'seq-spring-bean';
        const expectedPrompt = examplePrompts()[key];

        document.querySelector(`.example-chip[data-example-key="${key}"]`).click();
        await waitTick();

        assert.equal(calls.length, 1);
        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.welcomeKey, key);
        assert.equal(body.prompt, expectedPrompt);
    });

    it('chip 触发后用户继续输入：第二轮 sendMessage 不应带 welcomeKey', async () => {
        const { window, document, calls } = loadPage();

        // 第一轮：chip click
        const key = 'c4-ecommerce';
        document.querySelector(`.example-chip[data-example-key="${key}"]`).click();
        await waitTick();

        assert.equal(calls.length, 1, '第一轮 fetch 后调用次数应为 1');
        const firstBody = JSON.parse(calls[0].init.body);
        assert.equal(firstBody.welcomeKey, key,
            '第一轮必须带 welcomeKey（chip 触发）');

        // 流式因为空流被 finally 兜底走 onError，isStreaming 已复位为 false
        assert.equal(window.chat.isStreaming, false,
            '第一轮流式结束后 isStreaming 应已复位，下一轮 sendMessage 才能进入');

        // 第二轮：用户自输入
        const userPrompt = '画一个简单的用户登录流程图';
        window.chat.el.textarea.value = userPrompt;
        window.chat.sendMessage();
        await waitTick();

        assert.equal(calls.length, 2, '应有 2 次 fetch 调用');
        const secondBody = JSON.parse(calls[1].init.body);
        assert.equal(secondBody.welcomeKey, undefined,
            '用户自输入的第二轮不应带 welcomeKey（_pendingWelcomeKey 已消费），实际 '
            + JSON.stringify(secondBody.welcomeKey));
        assert.equal(secondBody.prompt, userPrompt,
            '第二轮 prompt 应是用户输入文本');
    });

    it('source 文本断言：chat.js 暴露 _pendingWelcomeKey / 透传给 streamGenerate', () => {
        // 防回归：如果有人把 _pendingWelcomeKey 改名或漏传给 streamGenerate，
        // 仅靠运行时测试可能漏（万一 chip click 那条路径走别的分支）。
        // 这里做源码层面的存在性检查，绑死契约
        const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
        assert.ok(/_pendingWelcomeKey/.test(src),
            'chat.js 应声明 _pendingWelcomeKey 字段');
        assert.ok(/welcomeKey:\s*welcomeKey\s*\|\|\s*undefined/.test(src),
            'streamGenerate 的 fetch body 应写 welcomeKey: welcomeKey || undefined');
        assert.ok(/const welcomeKey = this\._pendingWelcomeKey/.test(src),
            'sendMessage 应同步取出 _pendingWelcomeKey');
        assert.ok(/this\._pendingWelcomeKey = null/.test(src),
            'sendMessage 应在取出后立即置 null（防下一轮误带）');
    });

    it('页面加载与 click 序列不应有 console 错误', async () => {
        const { document, errs } = loadPage();
        document.querySelector('.example-chip[data-example-key="c4-ecommerce"]').click();
        await waitTick();
        assert.equal(errs.length, 0,
            '不应有 console 错误，实际:\n' + errs.join('\n'));
    });
});