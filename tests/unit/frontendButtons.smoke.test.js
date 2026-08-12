/**
 * 前端按钮烟雾测试：用 jsdom 加载 public/index.html + 全部 public/js，
 * 模拟点击登录/登出/抽屉/关闭抽屉/新建会话/登录 Tab 切换按钮，
 * 校验事件触发后 DOM 状态正确，并确认没有任何 console error。
 *
 * 目的：兜底"删一处坏一片"的回归——之前删代码 Tab 后用户反馈按钮失效，
 * jsdom 可在 1 秒内暴露事件流问题，不必跑浏览器。
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

function loadPage() {
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

describe('public/js 按钮事件烟雾测试', () => {
    it('所有关键按钮 DOM 存在', () => {
        const { document } = loadPage();
        for (const id of [
            'btn-toggle-drawer', 'btn-logout', 'btn-close-drawer', 'btn-new-session',
            'login-mask', 'login-form', 'register-form', 'history-drawer'
        ]) {
            assert.ok(document.getElementById(id), `DOM #${id} 必须存在`);
        }
    });

    it('点击历史会话按钮 → 抽屉添加 .open 类', () => {
        const { document, errs } = loadPage();
        document.getElementById('btn-toggle-drawer').click();
        assert.ok(
            document.getElementById('history-drawer').classList.contains('open'),
            'history-drawer 必须有 .open 类'
        );
        assert.equal(errs.length, 0, '无 console 错误');
    });

    it('再次点击历史会话按钮 → 抽屉移除 .open 类', () => {
        const { document } = loadPage();
        const btn = document.getElementById('btn-toggle-drawer');
        btn.click();
        btn.click();
        assert.ok(
            !document.getElementById('history-drawer').classList.contains('open'),
            '第二次点击应关闭抽屉'
        );
    });

    it('点击关闭抽屉按钮 → 抽屉移除 .open 类', () => {
        const { document } = loadPage();
        document.getElementById('btn-toggle-drawer').click();
        document.getElementById('btn-close-drawer').click();
        assert.ok(
            !document.getElementById('history-drawer').classList.contains('open'),
            '关闭按钮应移除 .open'
        );
    });

    it('点击登录 Tab 切换到注册表单', () => {
        const { document } = loadPage();
        const registerTab = Array.from(document.querySelectorAll('.login-tab'))
            .find(t => t.dataset.tab === 'register');
        registerTab.click();
        assert.ok(document.getElementById('register-form').hidden === false,
            '注册表单应可见');
        assert.ok(document.getElementById('login-form').hidden === true,
            '登录表单应隐藏');
    });

    it('点击新建会话按钮 → 清空当前 mermaid', () => {
        const { window, document } = loadPage();
        // 模拟先有 mermaid 内容
        if (window.chat) window.chat.currentMermaid = 'flowchart TD\nA-->B';
        document.getElementById('btn-new-session').click();
        assert.equal(window.chat.currentMermaid, '',
            '新建会话应清空 currentMermaid');
    });

    it('提交空登录表单 → 显示"请输入用户名和密码"', () => {
        const { window, document } = loadPage();
        const form = document.getElementById('login-form');
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        assert.equal(document.getElementById('login-message').textContent,
            '请输入用户名和密码');
    });

    it('整个流程不应有 console.error', () => {
        // 这一项作为最后兜底：如果前面的 click 都 OK 但有错误堆出来，这条会暴露。
        const { errs, document } = loadPage();
        document.getElementById('btn-toggle-drawer').click();
        document.getElementById('btn-close-drawer').click();
        document.getElementById('btn-new-session').click();
        Array.from(document.querySelectorAll('.login-tab'))
            .find(t => t.dataset.tab === 'register').click();
        Array.from(document.querySelectorAll('.login-tab'))
            .find(t => t.dataset.tab === 'login').click();
        assert.equal(errs.length, 0,
            '页面加载与点击序列不应有 console 错误，实际:\n' + errs.join('\n'));
    });
});
