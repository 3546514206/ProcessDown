/**
 * 客户端 _pendingWelcomeKey stale 防御性测试：
 * 复现并锁死以下早返路径必须在 sendMessage()/clear() 内清空 _pendingWelcomeKey，
 * 防止 stale key 跨轮污染下一轮 fetch body.welcomeKey。
 *
 * BUG-1: sendMessage() isStreaming 早返前清空 _pendingWelcomeKey
 * BUG-2: clear() 跨会话边界清空 _pendingWelcomeKey
 * BUG-3: sendMessage() !prompt 早返前清空 _pendingWelcomeKey（防御纵深）
 *
 * 跑法：node --test tests/unit/frontendWelcomeKeyStale.smoke.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function emptyStream() {
    // 让 streamGenerate 的 reader 立刻 done，onDone 走完后 setStreaming(false)
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

// ---- helper：把 body JSON 解析出来 ----
function parseBody(call) {
    return JSON.parse(call.init.body);
}

// ============================================================
// BUG-1: isStreaming 早返路径 stale key 防御
// ============================================================
describe('BUG-1: sendMessage() isStreaming 早返清空 _pendingWelcomeKey', () => {
    it('流式期间点击 chip B（早返）→ 用户后续自输入第二轮 fetch body 不带 stale welcomeKey', async () => {
        const { window, document, calls } = loadPage();

        // 步骤 1: 用户点击 chip A (c4-ecommerce) → 第一次 fetch
        const chipA = document.querySelector('.example-chip[data-example-key="c4-ecommerce"]');
        assert.ok(chipA, '必须有 data-example-key=c4-ecommerce 的 chip');
        chipA.click();
        await waitTick();

        // 流式因为空流被 finally 兜底走 onError，isStreaming 已复位为 false
        assert.equal(window.chat.isStreaming, false,
            'chip A 流式结束后 isStreaming 应已复位');
        assert.equal(calls.length, 1, '应有 1 次 fetch 调用');
        assert.equal(parseBody(calls[0]).welcomeKey, 'c4-ecommerce',
            '第一轮 fetch body.welcomeKey 应是 c4-ecommerce');

        // 步骤 2: 模拟"流式期间"——人为把 isStreaming 设为 true（chip B click 时
        // sendMessage 会命中 isStreaming 早返分支；测试不依赖真实时序，聚焦
        // 该早返路径对 _pendingWelcomeKey 的清空动作）
        window.chat.isStreaming = true;

        // 步骤 2 续: 点击 chip B（mindmap-genai）→ bindExampleChips 的 click 监听器
        // 会先设 _pendingWelcomeKey = 'mindmap-genai'，再调 sendMessage()；
        // sendMessage 同步段命中 `if (this.isStreaming) { this._pendingWelcomeKey = null; return; }`
        // 修复前这里只 return，留下 stale 'mindmap-genai'；修复后必须清空
        const chipB = document.querySelector('.example-chip[data-example-key="mindmap-genai"]');
        assert.ok(chipB, '必须有 data-example-key=mindmap-genai 的 chip');
        chipB.click();

        // 早返同步执行，chip click 返回后 _pendingWelcomeKey 必须已是 null
        assert.equal(window.chat._pendingWelcomeKey, null,
            'chip B click 命中 isStreaming 早返后，_pendingWelcomeKey 必须被清空（修复前会留 stale mindmap-genai）');

        // 步骤 3: 把 isStreaming 设回 false（流式结束），用户键入自定义 prompt
        window.chat.isStreaming = false;
        const customPrompt = '我的自定义输入';
        window.chat.el.textarea.value = customPrompt;

        // 步骤 4: 调 sendMessage() → 应有第二次 fetch
        window.chat.sendMessage();
        await waitTick();

        // 断言
        assert.equal(calls.length, 2,
            '应有 2 次 fetch 调用（第一轮 chip A + 第二轮用户自输入），实际 ' + calls.length);

        const secondBody = parseBody(calls[1]);
        assert.equal(secondBody.welcomeKey, undefined,
            '第二轮 fetch body.welcomeKey 必须是 undefined（修复前会带 stale mindmap-genai），实际 '
            + JSON.stringify(secondBody.welcomeKey));
        assert.equal(secondBody.prompt, customPrompt,
            '第二轮 fetch body.prompt 必须是用户自输入文本，实际 '
            + JSON.stringify(secondBody.prompt));
    });

    it('isStreaming 早返后 _pendingWelcomeKey 即时为 null（不依赖后续 sendMessage）', () => {
        const { window, document } = loadPage();

        // 准备：人为设 _pendingWelcomeKey 模拟"上一轮 chip click 已设 key 但 sendMessage 还没走到消费处"
        // 实际 chip click handler 是：先设 _pendingWelcomeKey = key，再调 sendMessage()。
        // 这里直接手动触发同一序列：人为设 key → 设 isStreaming → 调 sendMessage
        window.chat._pendingWelcomeKey = 'c4-ecommerce';
        window.chat.isStreaming = true;

        // sendMessage 同步段第一句就是清空 + return
        window.chat.sendMessage();

        assert.equal(window.chat._pendingWelcomeKey, null,
            'sendMessage 命中 isStreaming 早返后，_pendingWelcomeKey 必须立即为 null');
    });
});

// ============================================================
// BUG-2: clear() 跨会话边界清空 _pendingWelcomeKey
// ============================================================
describe('BUG-2: clear() 末尾清空 _pendingWelcomeKey（跨会话边界）', () => {
    it('chip click → clear() → 用户自输入：第二轮 fetch body 不带 stale welcomeKey', async () => {
        const { window, document, calls } = loadPage();

        // 步骤 1: 用户点击 chip A → 第一次 fetch
        document.querySelector('.example-chip[data-example-key="c4-ecommerce"]').click();
        await waitTick();

        assert.equal(window.chat.isStreaming, false,
            'chip A 流式结束后 isStreaming 应已复位');
        assert.equal(calls.length, 1);
        assert.equal(parseBody(calls[0]).welcomeKey, 'c4-ecommerce');

        // 步骤 2: 立即调 window.chat.clear()（模拟切换会话/登出/新建会话）
        // 修复前：clear() 没清 _pendingWelcomeKey，残留 c4-ecommerce
        // 修复后：clear() 末尾 _pendingWelcomeKey = null
        window.chat.clear();
        assert.equal(window.chat._pendingWelcomeKey, null,
            'clear() 后 _pendingWelcomeKey 必须为 null（防跨会话 stale 污染）');

        // 步骤 3: 用户键入自定义 prompt 发送
        const userPrompt = '画一个简单的状态机';
        window.chat.el.textarea.value = userPrompt;
        window.chat.sendMessage();
        await waitTick();

        // 断言
        assert.equal(calls.length, 2, '应有 2 次 fetch 调用');
        const secondBody = parseBody(calls[1]);
        assert.equal(secondBody.welcomeKey, undefined,
            'clear() 后用户自输入的 fetch body.welcomeKey 必须是 undefined（修复前会带 chip A 的 key），实际 '
            + JSON.stringify(secondBody.welcomeKey));
        assert.equal(secondBody.prompt, userPrompt);
    });

    it('clear() 即时清空 _pendingWelcomeKey（不依赖后续 sendMessage）', () => {
        const { window } = loadPage();
        window.chat._pendingWelcomeKey = 'c4-ecommerce';

        window.chat.clear();

        assert.equal(window.chat._pendingWelcomeKey, null,
            'clear() 末尾必须把 _pendingWelcomeKey 置 null');
    });
});

// ============================================================
// BUG-3: sendMessage() !prompt 早返清空 _pendingWelcomeKey（防御纵深）
// ============================================================
describe('BUG-3: sendMessage() !prompt 早返清空 _pendingWelcomeKey', () => {
    it('chip click → 流式继续 → 空白 prompt 早返 → 用户自输入：fetch body 不带 stale welcomeKey', async () => {
        const { window, document, calls } = loadPage();

        // 步骤 1: chip click → 触发 fetch → 流式继续
        document.querySelector('.example-chip[data-example-key="c4-ecommerce"]').click();
        await waitTick();

        assert.equal(calls.length, 1);
        assert.equal(parseBody(calls[0]).welcomeKey, 'c4-ecommerce');

        // 模拟"流式继续"——人为设 isStreaming=true，让下一步 sendMessage 命中 isStreaming
        // 早返（同时也确保 !prompt 路径之前 _pendingWelcomeKey 已被 isStreaming 守卫清空过一次）
        window.chat.isStreaming = true;

        // 步骤 2: 用户键入 "  "（仅空白）按 Enter → sendMessage 因 prompt 为空 return
        // 此时 _pendingWelcomeKey 应已被清空（isStreaming 守卫）
        window.chat.el.textarea.value = '  ';
        window.chat.sendMessage();

        assert.equal(window.chat._pendingWelcomeKey, null,
            'isStreaming 早返后 _pendingWelcomeKey 必须为 null');

        // 再额外模拟：人为把 _pendingWelcomeKey 设回 stale（让 !prompt 守卫单独被验证）
        // ——这一步锁死"即使绕过 isStreaming 守卫（isStreaming=false），空 prompt 路径
        // 也能清掉 stale _pendingWelcomeKey"
        window.chat._pendingWelcomeKey = 'mindmap-genai';
        window.chat.isStreaming = false;
        window.chat.el.textarea.value = '   '; // 仅空白，trim 后为空
        window.chat.sendMessage();

        assert.equal(window.chat._pendingWelcomeKey, null,
            '!prompt 早返后 _pendingWelcomeKey 必须为 null（防御纵深：清掉任何 stale key）');

        // 步骤 3: 用户键入自定义 prompt 发送
        const customPrompt = '正常 prompt';
        window.chat.el.textarea.value = customPrompt;
        window.chat.sendMessage();
        await waitTick();

        // 断言：第二次 fetch body 不带 stale welcomeKey
        // 注意：第一轮 chip A 后又做了 2 次 sendMessage（isStreaming 早返 + !prompt 早返），
        // 这两次都没发 fetch；只有最后这次用户自输入触发 fetch。
        // calls 应该是 2（第一轮 chip A + 用户自输入）
        assert.equal(calls.length, 2,
            '应有 2 次 fetch 调用（chip A + 用户自输入），中间两次早返不发 fetch，实际 ' + calls.length);

        const secondBody = parseBody(calls[1]);
        assert.equal(secondBody.welcomeKey, undefined,
            '用户自输入的 fetch body.welcomeKey 必须是 undefined（修复前会带 stale），实际 '
            + JSON.stringify(secondBody.welcomeKey));
        assert.equal(secondBody.prompt, customPrompt);
    });
});

// ============================================================
// source 文本断言（防回归：绑死契约）
// ============================================================
describe('source 文本断言：chat.js 三处清空 _pendingWelcomeKey 必须存在', () => {
    it('sendMessage 的 isStreaming 守卫应清空 _pendingWelcomeKey', () => {
        const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
        // 必须存在 `if (this.isStreaming) { this._pendingWelcomeKey = null; return; }`
        // 或等价的多行形式（容许不同换行/缩进）
        const re = /if\s*\(\s*this\.isStreaming\s*\)\s*\{\s*this\._pendingWelcomeKey\s*=\s*null\s*;\s*return\s*;?\s*\}/;
        assert.ok(re.test(src),
            'sendMessage 应在 isStreaming 守卫内清空 _pendingWelcomeKey 并 return');
    });

    it('sendMessage 的 !prompt 守卫应清空 _pendingWelcomeKey', () => {
        const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
        // 必须存在 `if (!prompt) { this._pendingWelcomeKey = null; return; }`
        const re = /if\s*\(\s*!prompt\s*\)\s*\{\s*this\._pendingWelcomeKey\s*=\s*null\s*;\s*return\s*;?\s*\}/;
        assert.ok(re.test(src),
            'sendMessage 应在 !prompt 守卫内清空 _pendingWelcomeKey 并 return');
    });

    it('clear() 末尾应清空 _pendingWelcomeKey', () => {
        const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
        // 定位 clear() 方法定义（避免命中 comment / 字符串里的 "clear()"）
        const defMatch = src.match(/clear\(\)\s*\{/);
        assert.ok(defMatch, '应存在 clear() 方法定义');
        const clearStart = defMatch.index;
        // 从 clear() 末尾 } 倒着匹配：扫描括号配对，找到与方法开 `{` 配对的 `}`
        let depth = 0;
        let endIdx = -1;
        for (let i = clearStart; i < src.length; i++) {
            const ch = src[i];
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { endIdx = i; break; }
            }
        }
        assert.ok(endIdx > 0, '应能定位 clear() 函数体结束');
        const clearBody = src.slice(clearStart, endIdx + 1);
        assert.match(clearBody, /this\._pendingWelcomeKey\s*=\s*null/,
            'clear() 函数体内必须出现 this._pendingWelcomeKey = null');
    });
});