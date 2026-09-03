/**
 * Visio (.vsdx) 导出按钮烟雾测试：用 jsdom 加载 public/index.html + 全部 public/js，
 * 校验 Visio 按钮存在、点击触发 exportVisio、空 currentMermaid 时只 toast 不抛、
 * 非空 currentMermaid 时正确用 flowchart.htmlLabels:false 调用 mermaid.render 并还原
 * 配置。
 *
 * vendored lib (@klyratech/mermaid-to-visio) 在 jsdom 不做真实 dynamic import：
 * 测试里 monkey-patch exportModule._loadVisioLib 返回伪造的 svgElementToVsdx。
 * 该测关心的是 export.js 的契约——"覆盖 mermaid 配置 + 渲染 + 还原"——而不是库本身。
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

    // mermaid mock：getConfig / initialize / render 三件套都覆盖。
    // 默认实现是空——空 currentMermaid 路径根本不会调
    const calls = [];
    w.mermaid = {
        initialize(cfg) { calls.push(['initialize', cfg && JSON.parse(JSON.stringify(cfg || {}))]); },
        getConfig: () => ({ theme: 'default', securityLevel: 'loose', flowchart: { htmlLabels: true, useMaxWidth: true } }),
        render: async (id, code) => {
            calls.push(['render', id, code]);
            return { svg: '<svg><text>mock</text></svg>' };
        }
    };

    // app / chat mock：toast 静默，避免 jsdom 报 appendChild etc；chat 默认空
    w.app = Object.assign(w.app || {}, {
        showToast: () => {}
    });
    if (opts.chat) {
        Object.assign(w, { chat: opts.chat });
    }
    // jsdom 默认 URL.createObjectURL 在 hyperlink.click() 路径上不一定存在——预先 polyfill
    w.URL.createObjectURL = w.URL.createObjectURL || (() => 'blob:mock');
    w.URL.revokeObjectURL = w.URL.revokeObjectURL || (() => {});

    // 顺序加载所有脚本（index.html 中顺序固定；export.js 也纳入本测试）
    // svg-foreignobject-to-text.js 必须在 export.js 之前——exportVisio 调用 window.svgForeignObjectToText
    const scripts = ['app.js', 'chat.js', 'mermaid-render.js', 'components.js', 'svg-foreignobject-to-text.js', 'export.js'];
    for (const s of scripts) {
        const code = fs.readFileSync(path.join(ROOT, 'public', 'js', s), 'utf8');
        try {
            w.eval(code);
        } catch (e) {
            errs.push('[eval ' + s + '] ' + (e && e.message || String(e)));
        }
    }
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    return { dom, window: w, document: w.document, errs, calls };
}

describe('Visio (.vsdx) 导出按钮烟雾测试', () => {
    it('按钮 DOM 存在', () => {
        const { document } = loadPage();
        const btn = document.getElementById('btn-export-visio');
        assert.ok(btn, 'DOM #btn-export-visio 必须存在');
        assert.equal(btn.tagName, 'BUTTON', '必须是 <button> 元素');
        assert.equal(btn.title, '导出 Visio', 'title 必须是"导出 Visio"');
    });

    it('window.exportModule.exportVisio 是方法', () => {
        const { window } = loadPage();
        assert.ok(window.exportModule, 'window.exportModule 必须挂上');
        assert.equal(typeof window.exportModule.exportVisio, 'function',
            'exportModule.exportVisio 必须是 function');
    });

    it('空 currentMermaid 时只 toast，不抛、不调 mermaid.render', async () => {
        // 不设 currentMermaid——loadPage 默认就是空
        const { window, calls, errs } = loadPage();
        await window.exportModule.exportVisio.call(window.exportModule);
        const renderCalls = calls.filter((c) => c[0] === 'render');
        assert.equal(renderCalls.length, 0,
            '空 currentMermaid 不应触发 mermaid.render');
        assert.equal(errs.length, 0,
            '空 currentMermaid 不应抛错（路径上 console 不应有 error）');
    });

    it('非空 currentMermaid 时用 htmlLabels:false 调用 mermaid.render，finally 还原配置', async () => {
        // mock _loadVisioLib：跳过真实 dynamic import（jsdom 不支持 module import）。
        // 该 hack 模拟"库已加载"的语义；这样 exportVisio 的真正契约——配置覆盖
        // + 还原 + mermaid.render 一次调用——得到验证
        const svgCalls = [];
        const { window, calls } = loadPage();
        window.exportModule._loadVisioLib = async () => ({
            svgElementToVsdx: async (svgEl, opts) => {
                svgCalls.push({ hasSvg: !!svgEl, title: opts && opts.title });
                return { bytes: new Uint8Array([0x50, 0x4b]) };
            }
        });
        window.app.showToast = (msg, type) => { window.__lastToast = { msg, type }; };
        // 显式设 currentMermaid（chat mock 在 loadPage 里默认空）
        window.chat = { currentMermaid: 'flowchart TD\nA-->B', isStreaming: false };

        await window.exportModule.exportVisio.call(window.exportModule);

        const initCalls = calls.filter((c) => c[0] === 'initialize');
        // exportVisio 调一次覆盖 + finally 一次还原。但其他模块（app.initMermaid）
        // 也会在 DOMContentLoaded 里调 initialize，所以不能用绝对索引定位"覆盖"/
        // "还原"，应按内容筛选
        const coverCall = initCalls.find((c) => c[1] && c[1].flowchart && c[1].flowchart.htmlLabels === false);
        const restoreCall = [...initCalls].reverse().find((c) => c[1] && c[1].flowchart && c[1].flowchart.htmlLabels === true);
        assert.ok(coverCall, '应至少一次 initialize 把 flowchart.htmlLabels 设为 false');
        assert.ok(restoreCall, '应至少一次 initialize 把 flowchart.htmlLabels 还原为 true');
        // mermaid 11.x 的 getEffectiveHtmlLabels 读顶层 htmlLabels（flowchart.htmlLabels
        // 已被 deprecated）。只设 flowchart.htmlLabels 不生效，节点仍走 <foreignObject>，
        // 库抽不到 shape → vsdx 空白。修复后必须顶层 htmlLabels:false 一起覆写。
        // app.initMermaid 原本不设顶层 htmlLabels，所以还原后顶层不是 true，是 undefined
        const topLevelCoverCall = initCalls.find((c) => c[1] && c[1].htmlLabels === false);
        assert.ok(topLevelCoverCall, '应至少一次 initialize 把顶层 htmlLabels 设为 false（mermaid 11.x canonical 路径）');
        // 覆盖后、还原前不能再有顶层 htmlLabels:false 的 initialize（防漏还原）
        const lastInit = initCalls[initCalls.length - 1];
        assert.ok(!(lastInit[1] && lastInit[1].htmlLabels === false),
            '最后一次 initialize（finally 还原）必须把顶层 htmlLabels 从 false 清掉');
        // 还原必须在覆盖之后（finally 顺序保证）
        assert.ok(initCalls.indexOf(restoreCall) > initCalls.indexOf(coverCall),
            '还原必须发生在覆盖之后（finally 块的顺序约束）');

        const renderCalls = calls.filter((c) => c[0] === 'render');
        assert.equal(renderCalls.length, 1, 'mermaid.render 应调用一次');
        assert.ok(/vsdx-/.test(renderCalls[0][1]),
            'mermaid.render id 应以 vsdx- 前缀开始，实际 ' + renderCalls[0][1]);
        assert.equal(svgCalls.length, 1, 'svgElementToVsdx 应调用一次');
        assert.ok(svgCalls[0].hasSvg, 'svgElementToVsdx 必须拿到 svg DOM 元素');
        assert.ok(svgCalls[0].title && /^flowchart-\d+$/.test(svgCalls[0].title),
            'title 应为 flowchart-<timestamp>，实际 ' + svgCalls[0].title);
        assert.ok(window.__lastToast && window.__lastToast.msg === 'Visio 已导出' && window.__lastToast.type === 'success',
            '成功路径应 toast "Visio 已导出"，实际 ' + JSON.stringify(window.__lastToast));
    });

    it('流式期间点击仅 toast，不调 mermaid.render', async () => {
        const { window, calls } = loadPage();
        window.exportModule._loadVisioLib = async () => ({
            svgElementToVsdx: async () => ({ bytes: new Uint8Array([0]) })
        });
        window.app.showToast = (msg, type) => { window.__lastToast = { msg, type }; };
        window.chat = { currentMermaid: 'flowchart TD\nA-->B', isStreaming: true };

        await window.exportModule.exportVisio.call(window.exportModule);

        assert.equal(calls.filter((c) => c[0] === 'render').length, 0,
            '流式期间不应触发 mermaid.render');
        assert.ok(window.__lastToast && /生成中/.test(window.__lastToast.msg),
            '流式期间应 toast 提示，实际 ' + JSON.stringify(window.__lastToast));
    });

    it('lib 抛错时 finally 仍还原 mermaid 配置 + 卸载 holder', async () => {
        const { window, document, calls } = loadPage();
        window.exportModule._loadVisioLib = async () => ({
            svgElementToVsdx: async () => { throw new Error('mock lib failure'); }
        });
        window.app.showToast = (msg, type) => { window.__lastToast = { msg, type }; };
        window.chat = { currentMermaid: 'flowchart TD\nA-->B', isStreaming: false };

        await window.exportModule.exportVisio.call(window.exportModule);

        const initCalls = calls.filter((c) => c[0] === 'initialize');
        assert.ok(initCalls.length >= 2,
            '即使 lib 抛错，finally 必须仍还原 mermaid 配置（至少 2 次 initialize）');
        // 离屏 holder：必须不存在于 body（被 finally 清掉）
        const holders = document.querySelectorAll('div[style*="-99999px"]');
        assert.equal(holders.length, 0,
            'lib 抛错后 holder 必须被 finally 移除，实际 ' + holders.length + ' 个残留');
        assert.ok(window.__lastToast && /导出 Visio 失败/.test(window.__lastToast.msg)
            && window.__lastToast.msg.includes('mock lib failure'),
            '失败 toast 必须带原 error.message，实际 ' + JSON.stringify(window.__lastToast));
    });

    it('mermaid 渲染含 foreignObject 的 SVG 时，exportVisio 链路会调 svgForeignObjectToText.convertForeignObjectToText', async () => {
        // 验集成：mermaid 11.x 默认把 flowchart / stateDiagram-v2 / classDiagram 等
        // 图表文字塞进 <foreignObject>。修前 vendored visio 库抽不到这些文字 → vsdx
        // 空白。修后 exportVisio 必须在喂给 holder 之前先过一遍 convertForeignObjectToText。
        const FO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">' +
            '<foreignObject x="10" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:14px"><p>节点A</p></div>' +
            '</foreignObject></svg>';
        const { window, calls } = loadPage();
        window.mermaid.render = async (id, code) => {
            calls.push(['render', id, code]);
            return { svg: FO_SVG };
        };
        // spy svgForeignObjectToText（覆盖 window 上的真实函数，记录调用）
        let foCallCount = 0;
        let lastFoInput = null;
        const realFn = window.svgForeignObjectToText.convertForeignObjectToText;
        window.svgForeignObjectToText.convertForeignObjectToText = (s) => {
            foCallCount += 1;
            lastFoInput = s;
            return realFn(s);
        };
        // mock lib 抓 svgEl 的 outerHTML 以校验最终喂给 svgElementToVsdx 的 SVG 已不含 foreignObject
        let capturedSvgHtml = null;
        window.exportModule._loadVisioLib = async () => ({
            svgElementToVsdx: async (svgEl) => {
                capturedSvgHtml = svgEl.outerHTML;
                return { bytes: new Uint8Array([0x50, 0x4b]) };
            }
        });
        window.app.showToast = () => {};
        window.chat = { currentMermaid: 'flowchart TD\nA-->B', isStreaming: false };

        await window.exportModule.exportVisio.call(window.exportModule);

        assert.ok(foCallCount >= 1,
            'exportVisio 应至少调用一次 convertForeignObjectToText，实际 ' + foCallCount);
        assert.ok(lastFoInput && /<foreignObject/i.test(lastFoInput),
            'spy 收到的入参应是 mermaid 原始含 foreignObject 的 SVG');
        assert.ok(capturedSvgHtml, 'svgElementToVsdx 必须被调用');
        assert.ok(!/<foreignObject/i.test(capturedSvgHtml),
            '最终喂给 svgElementToVsdx 的 SVG 已不含 foreignObject，实际: ' + capturedSvgHtml.slice(0, 200));
        assert.ok(/<text\b/.test(capturedSvgHtml),
            '最终 SVG 应含 <text>，实际: ' + capturedSvgHtml.slice(0, 200));
        // 文本内容应保留
        assert.ok(/节点A/.test(capturedSvgHtml),
            '中文"节点A"应保留在转换后的 SVG 中');
    });
});
