'use strict';

// 预览区全屏（#btn-preview-fullscreen）的前端逻辑边界测试。
//
// 策略说明：项目约定“前端 DOM 逻辑无单元测试，靠手动冒烟”，但
// appInputClearing.edge.test.js 已立先例——用 node:vm 加载真实前端源码 +
// 手搓最小 DOM stub（不引入 jsdom 等依赖）来覆盖决策路径。本文件沿用同一
// 模式测 components.js 的全屏决策与 active 态同步，覆盖手动冒烟难以稳定
// 复现的“条件反转/绑错元素/跨全屏误亮”回归。真实浏览器行为（Esc、top-layer
// 布局、Safari 前缀）仍由手动冒烟清单兜底（见测试报告）。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const componentsPath = path.join(__dirname, '../../public/js/components.js');
const source = fs.readFileSync(componentsPath, 'utf8');

// 与 appInputClearing.edge.test.js 同构的最小 stub，仅补全全屏路径所需能力。
function createClassList() {
    const values = new Set();
    return {
        add(...names) { names.forEach(n => values.add(n)); },
        remove(...names) { names.forEach(n => values.delete(n)); },
        toggle(name, force) {
            if (force === true) { values.add(name); return true; }
            if (force === false) { values.delete(name); return false; }
            if (values.has(name)) { values.delete(name); return false; }
            values.add(name); return true;
        },
        contains(name) { return values.has(name); }
    };
}

function createElement(id = '') {
    const listeners = new Map();
    const element = {
        id,
        value: '',
        hidden: false,
        textContent: '',
        className: '',
        dataset: {},
        style: {},
        disabled: false,
        classList: createClassList(),
        addEventListener(type, handler) { listeners.set(type, handler); },
        _listeners: listeners,
        // 全屏路径专用：requestFullscreen 在浏览器返回 Promise，dev 代码 .catch 兜底。
        requestFullscreenCalls: 0,
        _requestFullscreenResult: null,
        requestFullscreen() {
            element.requestFullscreenCalls += 1;
            return element._requestFullscreenResult || Promise.resolve();
        }
    };
    return element;
}

function createHarness({ previewButtonMissing = false } = {}) {
    const dom = new Map();
    const documentListeners = new Map();
    let _fullscreenElement = null;
    let _exitCalls = 0;
    const documentElement = createElement('html');

    const document = {
        getElementById(id) {
            if (previewButtonMissing && id === 'btn-preview-fullscreen') return null;
            if (!dom.has(id)) dom.set(id, createElement(id));
            return dom.get(id);
        },
        addEventListener(type, handler) { documentListeners.set(type, handler); },
        get fullscreenElement() { return _fullscreenElement; },
        set fullscreenElement(v) { _fullscreenElement = v; },
        exitFullscreen() { _exitCalls += 1; },
        documentElement,
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement(tag) { return createElement(tag); }
    };

    const storage = new Map();
    const localStorage = {
        getItem(k) { return storage.has(k) ? storage.get(k) : null; },
        setItem(k, v) { storage.set(k, String(v)); },
        removeItem(k) { storage.delete(k); }
    };
    const consoleStub = { log() {}, error() {}, warn() {} };
    const windowObj = {};

    const context = {
        window: windowObj, document, localStorage,
        console: consoleStub, navigator: {},
        setTimeout() { return 0; }, clearTimeout() {}
    };
    vm.runInNewContext(source, context, { filename: componentsPath });

    return {
        components: windowObj.components,
        document,
        dom,
        documentListeners,
        console: consoleStub,
        get fullscreenElement() { return _fullscreenElement; },
        set fullscreenElement(v) { _fullscreenElement = v; },
        get exitCalls() { return _exitCalls; },
        documentElement
    };
}

describe('preview panel fullscreen', () => {
    it('init wires previewPanel and registers fullscreenchange listener', () => {
        const h = createHarness();
        h.components.init();

        assert.equal(h.components.previewPanel, h.dom.get('panel-right'),
            'previewPanel 应绑定到 #panel-right 元素');
        assert.ok(h.documentListeners.has('fullscreenchange'),
            '应在 document 上监听 fullscreenchange 以同步按钮态');
    });

    it('togglePreviewFullscreen requests fullscreen on previewPanel when not active', () => {
        const h = createHarness();
        h.components.init();
        const panel = h.components.previewPanel;
        h.fullscreenElement = null; // 当前未处全屏

        h.components.togglePreviewFullscreen();

        assert.equal(panel.requestFullscreenCalls, 1, '应调用 previewPanel.requestFullscreen');
        assert.equal(h.exitCalls, 0, '不应调用 document.exitFullscreen');
    });

    it('togglePreviewFullscreen exits when previewPanel is already the fullscreen element', () => {
        const h = createHarness();
        h.components.init();
        const panel = h.components.previewPanel;
        h.fullscreenElement = panel; // 预览区已全屏

        h.components.togglePreviewFullscreen();

        assert.equal(h.exitCalls, 1, '应调用 document.exitFullscreen');
        assert.equal(panel.requestFullscreenCalls, 0, '不应再次 requestFullscreen');
    });

    it('togglePreviewFullscreen still requests (not exits) when page fullscreen is active', () => {
        // 跨全屏边界：整页全屏(documentElement)激活时点预览全屏，应请求预览全屏
        // 而非退出——previewPanel !== documentElement，走 request 分支。
        const h = createHarness();
        h.components.init();
        const panel = h.components.previewPanel;
        h.fullscreenElement = h.documentElement;

        h.components.togglePreviewFullscreen();

        assert.equal(panel.requestFullscreenCalls, 1);
        assert.equal(h.exitCalls, 0);
    });

    it('fullscreenchange activates button only when previewPanel is the fullscreen element', () => {
        const h = createHarness();
        h.components.init();
        const btn = h.dom.get('btn-preview-fullscreen');
        const panel = h.components.previewPanel;
        const handler = h.documentListeners.get('fullscreenchange');

        // 进入预览全屏 -> 亮
        h.fullscreenElement = panel;
        handler();
        assert.equal(btn.classList.contains('active'), true, '预览全屏时按钮应 active');

        // 退出 -> 灭
        h.fullscreenElement = null;
        handler();
        assert.equal(btn.classList.contains('active'), false, '退出后按钮应取消 active');
    });

    it('fullscreenchange does NOT activate button during page fullscreen (cross-isolation)', () => {
        // 回归守卫：若有人把条件误写成 !!document.fullscreenElement，
        // 整页全屏时预览按钮会错误地亮起。本测固化正确语义。
        const h = createHarness();
        h.components.init();
        const btn = h.dom.get('btn-preview-fullscreen');
        const handler = h.documentListeners.get('fullscreenchange');

        h.fullscreenElement = h.documentElement; // 整页全屏
        handler();
        assert.equal(btn.classList.contains('active'), false,
            '整页全屏时预览按钮不应 active');
    });

    it('requestFullscreen rejection is swallowed by .catch (silent fail)', async () => {
        // Safari 老版本/权限被拒时 requestFullscreen 可能 reject；
        // dev 代码 .catch 兜底，不应抛未捕获异常。
        const h = createHarness();
        h.components.init();
        const panel = h.components.previewPanel;
        let logged = false;
        h.console.log = () => { logged = true; };
        panel._requestFullscreenResult = Promise.reject(new Error('denied'));

        h.components.togglePreviewFullscreen();
        // 等 rejected promise 的 .catch 微任务跑完
        await new Promise(r => setTimeout(r, 0));

        assert.equal(logged, true, 'reject 应被 .catch 捕获并 console.log');
    });

    it('initPreviewFullscreenControl is a no-op when the button is absent', () => {
        // 防御性 guard：按钮缺失时不应抛、不应注册监听。
        const h = createHarness({ previewButtonMissing: true });
        assert.doesNotThrow(() => h.components.init());
        assert.equal(h.documentListeners.has('fullscreenchange'), false,
            '按钮缺失时不应注册 fullscreenchange 监听');
    });
});
