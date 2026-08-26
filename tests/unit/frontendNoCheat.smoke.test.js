'use strict';

/**
 * "用户自主输入禁止作弊" 前端层烟雾测试（jsdom）：
 *
 * 验证 chat.js 在用户**自输入**路径上，fetch body 永远不含 welcomeKey。
 * 复盘契约：
 *   - chip click 才会把 _pendingWelcomeKey 置为 key
 *   - sendMessage 同步取出 _pendingWelcomeKey 并立即清空
 *   - streamGenerate 的 body 用 `welcomeKey: welcomeKey || undefined`，
 *     null/undefined 字段会被 JSON.stringify 跳过 → 后端拿不到该字段
 *
 * 关键测试点：
 *   1. 用户直接键入文本 → _pendingWelcomeKey 始终 null → fetch body 无 welcomeKey
 *   2. 多轮对话：第二轮（用户输入）即使紧跟 chip 触发的第一轮，
 *      第二轮 fetch body 也无 welcomeKey
 *   3. 整个用户输入路径 _pendingWelcomeKey 始终未被 chip click 污染
 *   4. 来源层断言：chat.js 的契约字符串必须存在（防回归）
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function emptyStream() {
    // 与 frontendWelcomeKey.smoke.test.js 一致：reader 立刻 done → finally
    // 兜底走 onError('连接已断开，请重试') → setStreaming(false)，下一轮可进入
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

    w.mermaid = {
        initialize() {},
        render: async () => ({ svg: '<svg></svg>' })
    };
    w.navigator.clipboard = { writeText: async () => {} };

    const scripts = ['app.js', 'chat.js', 'mermaid-render.js', 'components.js'];
    for (const s of scripts) {
        const code = fs.readFileSync(path.join(ROOT, 'public', 'js', s), 'utf8');
        try {
            w.eval(code);
        } catch (e) {
            errs.push('[eval ' + s + '] ' + (e && e.message || String(e)));
        }
    }
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

    w.app = {
        showToast: () => {},
        updateStatus: () => {},
        ensureSession: async () => { return null; },
        loadSessions: () => {},
        getSiteTheme: () => 'light',
        state: { sessionId: 'test-session-uuid', user: { username: 'tester' } }
    };

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
    return new Promise((r) => setTimeout(r, ms));
}

// 把所有 fetch body 解析成对象列表，供断言
function fetchBodiesAsObjects(calls) {
    return calls.map(c => JSON.parse(c.init.body));
}

describe('前端：用户自输入路径上 welcomeKey 不偷跑', () => {
    it('用户直接键入 → fetch body 不应含 welcomeKey 字段（JSON.stringify 跳过 undefined）', async () => {
        const { window, document, calls } = loadPage();

        // 防御性：起始 _pendingWelcomeKey 必须为 null
        assert.equal(window.chat._pendingWelcomeKey, null,
            '初始 _pendingWelcomeKey 必须为 null');

        // 用户直接键入文本，不点 chip
        const userPrompt = '画一个简单的用户登录流程图';
        window.chat.el.textarea.value = userPrompt;
        assert.equal(window.chat._pendingWelcomeKey, null,
            '键入文本不应修改 _pendingWelcomeKey');

        // 点发送按钮
        window.chat.el.send.click();
        await waitTick();

        assert.equal(calls.length, 1, '应有 1 次 fetch');
        const body = fetchBodiesAsObjects(calls)[0];
        assert.ok(!('welcomeKey' in body),
            'fetch body 不应含 welcomeKey 字段（键存在即失败），实际 keys: '
            + JSON.stringify(Object.keys(body)));
        assert.equal(body.welcomeKey, undefined,
            'fetch body.welcomeKey 应为 undefined（JSON.stringify 跳过）');
        assert.equal(body.prompt, userPrompt,
            'fetch body.prompt 应为用户输入文本');
        assert.match(calls[0].url, /\/api\/generate\/stream/);

        // 消费后 _pendingWelcomeKey 必须保持 null（本来就没设）
        assert.equal(window.chat._pendingWelcomeKey, null);
    });

    it('Enter 键发送同样不偷跑 welcomeKey', async () => {
        const { window, document, calls } = loadPage();

        const userPrompt = '用户输入的图表描述';
        window.chat.el.textarea.value = userPrompt;

        // 模拟 Enter 键（Shift 未按下）→ sendMessage
        const enterEvent = new window.KeyboardEvent('keydown', {
            key: 'Enter',
            shiftKey: false,
            bubbles: true,
            cancelable: true
        });
        window.chat.el.textarea.dispatchEvent(enterEvent);
        await waitTick();

        assert.equal(calls.length, 1);
        const body = fetchBodiesAsObjects(calls)[0];
        assert.ok(!('welcomeKey' in body),
            'Enter 键触发的 sendMessage 也不应带 welcomeKey');
        assert.equal(body.prompt, userPrompt);
    });

    it('多轮对话：第一轮 chip，第二轮用户输入 → 第二轮 fetch body 不带 welcomeKey', async () => {
        const { window, document, calls } = loadPage();

        // 第一轮：点 chip（合法使用 welcomeKey）
        const key = 'c4-ecommerce';
        document.querySelector(`.example-chip[data-example-key="${key}"]`).click();
        await waitTick();

        assert.equal(calls.length, 1, '第一轮 fetch');
        const firstBody = fetchBodiesAsObjects(calls)[0];
        assert.equal(firstBody.welcomeKey, key,
            '第一轮 chip 触发应带 welcomeKey（合法）');

        // 第一轮流式走 finally 兜底 → isStreaming 复位 → 可进入第二轮
        assert.equal(window.chat.isStreaming, false);

        // 关键：第二轮之前，_pendingWelcomeKey 必须已为 null
        // （sendMessage 在第一轮就消费并清空了）
        assert.equal(window.chat._pendingWelcomeKey, null,
            '第一轮 sendMessage 消费后 _pendingWelcomeKey 必须清空，下一轮不该误带');

        // 第二轮：用户输入
        const userPrompt = '第二轮用户输入的描述';
        window.chat.el.textarea.value = userPrompt;
        window.chat.sendMessage();
        await waitTick();

        assert.equal(calls.length, 2, '应有 2 次 fetch');
        const secondBody = fetchBodiesAsObjects(calls)[1];
        assert.ok(!('welcomeKey' in secondBody),
            '第二轮用户输入不应带 welcomeKey（关键防作弊），实际 keys: '
            + JSON.stringify(Object.keys(secondBody)));
        assert.equal(secondBody.welcomeKey, undefined);
        assert.equal(secondBody.prompt, userPrompt);
        assert.equal(window.chat._pendingWelcomeKey, null,
            '第二轮结束后 _pendingWelcomeKey 仍为 null');
    });

    it('"重新生成"按钮调用路径：不偷跑 welcomeKey（直接 sendMessage）', async () => {
        const { window, document, calls } = loadPage();

        // 准备一轮：用户输入触发流式（合法自输入，无 welcomeKey）
        const userPrompt = '画个电商流程';
        window.chat.el.textarea.value = userPrompt;
        window.chat.sendMessage();
        await waitTick();

        assert.equal(calls.length, 1);
        const firstBody = fetchBodiesAsObjects(calls)[0];
        assert.ok(!('welcomeKey' in firstBody),
            '用户输入首轮不应带 welcomeKey');

        // 流式结束后 isStreaming 复位
        assert.equal(window.chat.isStreaming, false);

        // 找到"重新生成"按钮：operation-row 内的 .action-btn 最后一个
        // （顺序：查看此图 / 复制代码 / 重新生成；appendAiMessage 里就是这个顺序）
        const actionBtns = document.querySelectorAll('.message-ai .action-row .action-btn');
        assert.ok(actionBtns.length >= 1, 'AI 消息应有 action-row 按钮');
        const regenBtn = actionBtns[actionBtns.length - 1];  // 最后一个 = 重新生成
        assert.equal(regenBtn.textContent, '重新生成',
            '最后一个按钮应为"重新生成"');

        // 点击"重新生成"
        regenBtn.click();
        await waitTick();

        assert.equal(calls.length, 2, '应有 2 次 fetch（用户输入 + 重新生成）');
        const regenBody = fetchBodiesAsObjects(calls)[1];
        assert.ok(!('welcomeKey' in regenBody),
            '"重新生成"按钮不应触发 welcomeKey（该按钮只调 sendMessage），实际 keys: '
            + JSON.stringify(Object.keys(regenBody)));
        assert.equal(regenBody.welcomeKey, undefined);
        // 重新生成用的是本轮的 user 指令
        assert.equal(regenBody.prompt, userPrompt,
            '"重新生成"应重放本轮指令');
        // _pendingWelcomeKey 仍为 null（从来没被 chip 触发过）
        assert.equal(window.chat._pendingWelcomeKey, null);
    });

    it('"查看此图"按钮：纯前端操作，不发请求，_pendingWelcomeKey 仍为 null', async () => {
        const { window, document, calls } = loadPage();

        // 先用用户输入产生一轮 AI 消息（让"查看此图"按钮存在）
        window.chat.el.textarea.value = '画个流程';
        window.chat.sendMessage();
        await waitTick();

        assert.equal(calls.length, 1);

        // "查看此图"按钮：appendAiMessage 里是 action-btn 第一个
        const actionBtns = document.querySelectorAll('.message-ai .action-row .action-btn');
        assert.ok(actionBtns.length >= 1);
        const viewBtn = actionBtns[0];
        assert.equal(viewBtn.textContent, '查看此图',
            '第一个按钮应为"查看此图"');

        const beforeCalls = calls.length;
        viewBtn.click();
        await waitTick();

        // "查看此图"只改 currentMermaid + renderMermaid（前端），不应再发请求
        assert.equal(calls.length, beforeCalls,
            '"查看此图"不应发请求，调用次数前后一致');
        assert.equal(window.chat._pendingWelcomeKey, null,
            '"查看此图"点击不应污染 _pendingWelcomeKey');
    });

    it('纯用户输入：连续 N 轮自输入，_pendingWelcomeKey 始终保持 null', async () => {
        const { window, calls } = loadPage();

        assert.equal(window.chat._pendingWelcomeKey, null,
            '初始 _pendingWelcomeKey 必须为 null');

        const prompts = [
            '第一轮用户输入',
            '第二轮用户输入',
            '第三轮用户输入'
        ];

        for (let i = 0; i < prompts.length; i++) {
            window.chat.el.textarea.value = prompts[i];
            assert.equal(window.chat._pendingWelcomeKey, null,
                `第 ${i + 1} 轮键入前 _pendingWelcomeKey 应仍为 null`);
            window.chat.sendMessage();
            await waitTick();

            const body = fetchBodiesAsObjects(calls)[i];
            assert.ok(!('welcomeKey' in body),
                `第 ${i + 1} 轮 fetch body 不应含 welcomeKey，实际 keys: `
                + JSON.stringify(Object.keys(body)));
            assert.equal(window.chat._pendingWelcomeKey, null,
                `第 ${i + 1} 轮结束后 _pendingWelcomeKey 应仍为 null`);
        }

        assert.equal(calls.length, prompts.length);
    });

    it('source 文本断言：chat.js 的契约字符串必须存在（防回归）', () => {
        const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');

        // _pendingWelcomeKey 字段声明（state 对象里用冒号赋值初值 null）
        assert.ok(/_pendingWelcomeKey\s*:\s*null/.test(src),
            'chat.js state 应声明 _pendingWelcomeKey: null');

        // sendMessage 取出后立即清空（用 this._pendingWelcomeKey = null 置位）
        assert.ok(/const welcomeKey = this\._pendingWelcomeKey/.test(src),
            'sendMessage 应同步取出 _pendingWelcomeKey');
        assert.ok(/this\._pendingWelcomeKey\s*=\s*null/.test(src),
            'sendMessage 应立即置 _pendingWelcomeKey = null');

        // streamGenerate 的 fetch body 用 `welcomeKey: welcomeKey || undefined`
        // （这样 JSON.stringify 会跳过 undefined → 后端拿不到 welcomeKey 字段）
        assert.ok(/welcomeKey:\s*welcomeKey\s*\|\|\s*undefined/.test(src),
            'streamGenerate 应写 welcomeKey: welcomeKey || undefined（undefined 触发字段跳过）');

        // 反向断言：除 chip 触发路径外，不应再有任何设 _pendingWelcomeKey 为非 null 的代码。
        // 计数：源码中 `_pendingWelcomeKey = key` 的赋值语句应只出现 1 次（chip click 触发）
        // —— sendMessage 里的清空是 `= null`，单独算。精确匹配避免误判。
        // 这是"chip click 之外不应被赋非 null 值"的不变式——任何 0 次或 >1 次都意味着
        // 多/少了"让用户消息偷跑预制代码"的赋值点，是回归。
        const setNonNull = src.match(/_pendingWelcomeKey\s*=\s*key\b/g) || [];
        assert.equal(setNonNull.length, 1,
            '_pendingWelcomeKey = key 应仅在 bindExampleChips 里出现 1 次，实际 '
            + setNonNull.length + ' 处');

        // 清空 `= null` 应恰好 4 处（修复 BUG-1/2/3 stale 跨轮污染后的合法清空点）：
        //   1) sendMessage 早返：isStreaming 守卫拦住流式期间点击的 chip（防流中 click B 后
        //      用户改 textarea 文本再发送把 stale B 透传）
        //   2) sendMessage 早返：空 prompt 守卫（对称安全）
        //   3) sendMessage 主流：取出后立即清空（"本轮取完即清"主路径）
        //   4) clear() 末尾：跨会话边界清空（防上一个会话流式期间点 chip 的 stale 跨会话）
        // —— state 声明用的是 `: null`（不在此正则里）
        const setNull = src.match(/_pendingWelcomeKey\s*=\s*null\b/g) || [];
        assert.equal(setNull.length, 4,
            '_pendingWelcomeKey = null 应恰好 4 处合法清空点（2 早返 + 1 主流 + 1 clear），实际 '
            + setNull.length + ' 处');

        // "重新生成"按钮只调 sendMessage，不直接设 _pendingWelcomeKey
        // —— 已通过上面的精确计数覆盖（chip click 是唯一非 null 赋值点）
    });

    it('页面加载与发送序列不应有 console 错误', async () => {
        const { window, document, errs } = loadPage();
        window.chat.el.textarea.value = '测试 prompt';
        window.chat.el.send.click();
        await waitTick();
        assert.equal(errs.length, 0,
            '不应有 console 错误，实际:\n' + errs.join('\n'));
    });
});