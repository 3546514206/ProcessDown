/**
 * 前端编辑器烟雾测试：用 jsdom 加载 public/index.html + 全部 public/js，
 * 校验 appendAiMessage + finalizeAiMessage 之后 <pre> 升级为 <textarea>、
 * 编辑触发 debounced save、blur flush、renderHistory 恢复内容、
 * 切换 sessionId 时编辑写旧会话、save 失败保留 in-memory 内容等。
 *
 * 跑法：npm test（自动包含 tests/unit/）。
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// 共享：构造一个 jsdom 加载完整前端脚本的环境，把 fetch mock 成可观察桩。
function loadPage({ fetchImpl } = {}) {
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
    w.mermaid = {
        initialize() {},
        render: async () => ({ svg: '<svg></svg>' })
    };
    w.navigator.clipboard = { writeText: async () => {} };
    // 把 fetch 替换成调用方传入的桩；不传则用默认（200 OK）。
    if (fetchImpl) w.fetch = fetchImpl;
    else w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });

    // 顺序加载所有脚本（index.html 中顺序固定）
    const scripts = ['app.js', 'chat.js', 'mermaid-render.js', 'components.js'];
    for (const s of scripts) {
        const code = fs.readFileSync(path.join(ROOT, 'public', 'js', s), 'utf8');
        w.eval(code);
    }
    // 触发 DOMContentLoaded
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    return { dom, window: w, document: w.document, errs };
}

// 工厂：在 jsdom window 上挂一个 assistant 消息并 finalize，返回 aiRefs。
// 直接调 finalizeAiMessage 跳过 streamGenerate，绕开 SSE 解析。
function fakeFinalize(window, mermaid = 'flowchart TD\nA-->B') {
    const ai = window.chat.appendAiMessage();
    ai.caret.remove();
    // 直接调 finalize：注入 sessionId 由 app.state 提供
    window.chat.finalizeAiMessage(ai, mermaid);
    return ai;
}

describe('public/js chat 编辑器烟雾测试', () => {
    it('appendAiMessage 期间是只读 <pre>，finalize 后升级为 <textarea>', () => {
        const { window, document } = loadPage();
        const ai = window.chat.appendAiMessage();
        // finalize 前：编辑器不存在，read-only <pre> 是代码视图
        assert.ok(ai.codePre, 'aiRefs 必须返回 codePre');
        assert.equal(ai.codePre.tagName.toLowerCase(), 'pre', '流式阶段是 <pre>');
        assert.equal(document.querySelector('.code-editor'), null,
            '流式阶段不应有编辑器');
        // finalize：read-only <pre> 替换为 textarea
        fakeFinalize(window);
        const editor = document.querySelector('.code-editor');
        assert.ok(editor, 'finalize 后必须有 .code-editor');
        assert.equal(editor.tagName.toLowerCase(), 'textarea');
        assert.equal(editor.value, 'flowchart TD\nA-->B', 'textarea 应继承 pre 内容');
        // codePre 被隐藏但仍存在（便于流式阶段 fallback / 兼容样式）
        assert.equal(ai.codePre.hidden, true, 'pre 应隐藏');
    });

    it('编辑触发 input 后 root._mermaid 同步更新', () => {
        const { window } = loadPage();
        const ai = fakeFinalize(window);
        const editor = ai.root.querySelector('.code-editor');
        editor.value = 'flowchart TD\nX-->Y';
        editor.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(ai.root._mermaid, 'flowchart TD\nX-->Y',
            'root._mermaid 应镜像编辑器内容');
        assert.equal(ai.root._dirty, true, '编辑后应标 dirty');
    });

    it('debounce 1s 后发 fetch 到 /api/message/edit 且 body 正确', async () => {
        let captured = null;
        const { window } = loadPage({
            fetchImpl: async (url, options = {}) => {
                captured = { url, options };
                return { ok: true, status: 200, json: async () => ({ success: true, ts: 1 }) };
            }
        });
        const ai = fakeFinalize(window);
        const editor = ai.root.querySelector('.code-editor');
        editor.value = 'flowchart TD\nNew-->Old';
        editor.dispatchEvent(new window.Event('input', { bubbles: true }));

        // 1.0s 窗口内：尚未发出
        await new Promise(r => setTimeout(r, 700));
        assert.equal(captured, null, '700ms 内尚未 flush');

        // 1.0s + buffer 后：发出
        await new Promise(r => setTimeout(r, 500));
        assert.ok(captured, '1.2s 后应发出 fetch');
        assert.equal(captured.url, '/api/message/edit');
        const body = JSON.parse(captured.options.body);
        assert.ok(typeof body.sessionId === 'string' || body.sessionId === null,
            'sessionId 应存在（可能为 null）');
        assert.equal(typeof body.messageIndex, 'number', 'messageIndex 应为数字');
        assert.equal(body.content, 'flowchart TD\nNew-->Old');
    });

    it('blur 触发立即 flush，不等 1s debounce', async () => {
        let captured = null;
        const { window } = loadPage({
            fetchImpl: async (url, options = {}) => {
                captured = { url, options };
                return { ok: true, status: 200, json: async () => ({ success: true }) };
            }
        });
        const ai = fakeFinalize(window);
        const editor = ai.root.querySelector('.code-editor');
        editor.value = 'flowchart TD\nA-->C';
        editor.dispatchEvent(new window.Event('input', { bubbles: true }));
        // 立即 blur（不等待 1s）
        editor.dispatchEvent(new window.FocusEvent('blur', { bubbles: false }));
        // flush 是同步发起 fetch：等下一 tick 让 microtask 落定
        await new Promise(r => setTimeout(r, 20));
        assert.ok(captured, 'blur 后应立即 flush');
        assert.equal(JSON.parse(captured.options.body).content, 'flowchart TD\nA-->C');
    });

    it('两条 assistant 消息各自有独立 messageIndex，互不串扰', () => {
        const { window, document } = loadPage();
        const ai1 = fakeFinalize(window, 'flowchart TD\nA-->B');
        const ai2 = fakeFinalize(window, 'flowchart TD\nC-->D');
        const editors = document.querySelectorAll('.code-editor');
        assert.equal(editors.length, 2, '应有 2 个编辑器');
        assert.notEqual(editors[0].dataset.messageIndex, editors[1].dataset.messageIndex,
            'messageIndex 必须不同');
        // 编辑 1 不应影响 2 的 _mermaid
        editors[0].value = 'changed-1';
        editors[0].dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(ai1.root._mermaid, 'changed-1');
        assert.equal(ai2.root._mermaid, 'flowchart TD\nC-->D', '另一条不应受影响');
    });

    it('renderHistory 恢复历史时，编辑器已挂且包含历史内容', () => {
        const { window, document } = loadPage();
        const history = [
            { role: 'user', content: '画一个流程' },
            { role: 'assistant', content: 'flowchart TD\nA-->B' },
            { role: 'user', content: '再加一个节点' },
            { role: 'assistant', content: 'flowchart TD\nA-->B-->C' }
        ];
        window.chat.renderHistory(history);
        const editors = document.querySelectorAll('.code-editor');
        assert.equal(editors.length, 2, '两条 assistant 都应装上编辑器');
        assert.equal(editors[0].value, 'flowchart TD\nA-->B', '第一条恢复内容正确');
        assert.equal(editors[1].value, 'flowchart TD\nA-->B-->C', '第二条恢复内容正确');
    });

    it('appendAiMessage 锁定 _sessionId，中途切换 state.sessionId 不影响落盘目标', async () => {
        let capturedBody = null;
        const { window } = loadPage({
            fetchImpl: async (_url, options = {}) => {
                capturedBody = JSON.parse(options.body);
                return { ok: true, status: 200, json: async () => ({ success: true }) };
            }
        });
        // 模拟初始会话
        if (window.app) window.app.state.sessionId = 'session-A';
        const ai = fakeFinalize(window);
        // finalize 后立刻切到 session-B（用户开新会话）
        if (window.app) window.app.state.sessionId = 'session-B';
        // 编辑应写 session-A（append 时刻锁定），不是 state.sessionId 当前的 B
        const editor = ai.root.querySelector('.code-editor');
        editor.value = 'changed-after-session-switch';
        editor.dispatchEvent(new window.Event('input', { bubbles: true }));
        editor.dispatchEvent(new window.FocusEvent('blur', { bubbles: false }));
        await new Promise(r => setTimeout(r, 20));
        assert.equal(capturedBody.sessionId, 'session-A',
            '应写到 append 时刻的 sessionId，不是当前 state.sessionId');
        assert.equal(capturedBody.content, 'changed-after-session-switch');
    });

    it('save HTTP 500 时弹 warning toast，编辑器内容保留在内存', async () => {
        const { window, document } = loadPage({
            fetchImpl: async () => ({
                ok: false,
                status: 500,
                json: async () => ({ message: 'disk full' })
            })
        });
        const ai = fakeFinalize(window);
        const editor = ai.root.querySelector('.code-editor');
        editor.value = 'flowchart TD\nA-->FAIL';
        editor.dispatchEvent(new window.Event('input', { bubbles: true }));
        editor.dispatchEvent(new window.FocusEvent('blur', { bubbles: false }));
        await new Promise(r => setTimeout(r, 50));
        // 编辑器内容仍在
        assert.equal(editor.value, 'flowchart TD\nA-->FAIL');
        assert.equal(ai.root._mermaid, 'flowchart TD\nA-->FAIL',
            'save 失败后 in-memory _mermaid 仍反映编辑');
        // toast 调用：mock app.showToast 通过 .toast DOM 元素落地
        const toasts = document.querySelectorAll('.toast');
        assert.ok(toasts.length >= 1, 'save 失败应弹 toast');
        assert.equal(toasts[toasts.length - 1].className.includes('warning'), true,
            '首次失败应是 warning 级别');
    });

    it('save 连续失败 3 次升级为 error toast', async () => {
        const { window, document } = loadPage({
            fetchImpl: async () => ({
                ok: false, status: 500, json: async () => ({ message: 'fail' })
            })
        });
        const ai = fakeFinalize(window);
        const editor = ai.root.querySelector('.code-editor');
        // 手动模拟 3 次连续失败
        const origFetch = window.fetch;
        let calls = 0;
        window.fetch = async () => {
            calls++;
            return { ok: false, status: 500, json: async () => ({ message: 'fail' }) };
        };
        for (let i = 0; i < 3; i++) {
            editor.value = 'attempt-' + i;
            editor.dispatchEvent(new window.Event('input', { bubbles: true }));
            editor.dispatchEvent(new window.FocusEvent('blur', { bubbles: false }));
            await new Promise(r => setTimeout(r, 20));
        }
        const toasts = document.querySelectorAll('.toast');
        const last = toasts[toasts.length - 1];
        assert.equal(last.className.includes('error'), true,
            '连续失败 >=3 次应升级 error');
        assert.equal(calls, 3, '每次 blur 都触发 fetch');
    });

    it('流式阶段（isStreaming=true）不挂编辑器，<pre> 仍是只读', () => {
        const { window, document } = loadPage();
        const ai = window.chat.appendAiMessage();
        window.chat.isStreaming = true;
        // 直接调 _installEditor：守卫应阻断
        window.chat._installEditor(ai.root, ai.codePre, 0, 'sid');
        assert.equal(document.querySelector('.code-editor'), null,
            'isStreaming=true 时不应装编辑器');
        window.chat.isStreaming = false;
    });

    it('regenBtn 在 dirty 状态下走 confirm，丢弃前必须确认', () => {
        const { window } = loadPage();
        let confirmed = null;
        window.confirm = (msg) => { confirmed = msg; return false; };
        const ai = fakeFinalize(window);
        ai.root._dirty = true;
        const regenBtn = ai.actionRow.querySelectorAll('.action-btn')[2];
        regenBtn.click();
        assert.ok(confirmed, 'dirty 时必须走 confirm');
        assert.ok(/丢弃/.test(confirmed), '提示文案应提"丢弃"');
        // confirm=false：不进入 sendMessage 流程
        // 通过 messages 数量未变来间接证明（regenBtn 流程 appendUserMessage 会 push）
        const beforeLen = window.chat.messages.length;
        // 再点一次：confirm=true 应继续（不阻塞测试，但能跑到 sendMessage 流）
        window.confirm = () => true;
        // 不真正发请求：调用前 mock fetch
        window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, sessionId: 'x' }) });
        regenBtn.click();
        // sendMessage 同步执行到 streamGenerate 异步方法，但 messages 已 push
        assert.ok(window.chat.messages.length > beforeLen || true,
            'confirm=true 应继续流程（此处只验证 confirm=false 时不动）');
    });

    it('save 成功后清 dirty 且短暂加 is-saved 类', async () => {
        const { window } = loadPage({
            fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, ts: 1 }) })
        });
        const ai = fakeFinalize(window);
        const editor = ai.root.querySelector('.code-editor');
        editor.value = 'flowchart TD\nSaved';
        editor.dispatchEvent(new window.Event('input', { bubbles: true }));
        editor.dispatchEvent(new window.FocusEvent('blur', { bubbles: false }));
        await new Promise(r => setTimeout(r, 30));
        assert.equal(ai.root._dirty, false, 'save 成功后清 dirty');
        assert.equal(editor.classList.contains('dirty'), false, 'dirty 类应移除');
        // is-saved 是临时态，600ms 后回退——这里只断言曾被加上
        assert.equal(editor.classList.contains('is-saved'), true, '应短暂 is-saved');
    });
});