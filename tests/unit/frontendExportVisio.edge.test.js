/**
 * Visio (.vsdx) 导出按钮边界测试（Round 2）：补强 Round 1 烟雾测的盲区。
 * 覆盖：mermaid 全局缺失降级 / _loadVisioLib 失败缓存清理（重试可恢复）/
 * 并发点击互斥（_visioBusy 守卫）/ holder leak 检测 / 文件名校验 /
 * window.chat 缺失降级 / window.app 缺失降级。
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

    // mermaid 必须在 eval 之前挂上：app.js eval 时 initMermaid 会调 mermaid.initialize
    const calls = [];
    if (opts.mermaid === null) {
        w.mermaid = undefined;
    } else {
        w.mermaid = Object.assign({
            initialize(cfg) { calls.push(['initialize', cfg && JSON.parse(JSON.stringify(cfg || {}))]); },
            getConfig: () => ({ theme: 'default', securityLevel: 'loose', flowchart: { htmlLabels: true, useMaxWidth: true } }),
            render: async (id, code) => {
                calls.push(['render', id, code]);
                return { svg: '<svg><text>mock</text></svg>' };
            }
        }, opts.mermaid || {});
    }

    w.URL.createObjectURL = w.URL.createObjectURL || (() => 'blob:mock');
    w.URL.revokeObjectURL = w.URL.revokeObjectURL || (() => {});

    const scripts = ['app.js', 'chat.js', 'mermaid-render.js', 'components.js', 'export.js'];
    for (const s of scripts) {
        const code = fs.readFileSync(path.join(ROOT, 'public', 'js', s), 'utf8');
        try {
            w.eval(code);
        } catch (e) {
            errs.push('[eval ' + s + '] ' + (e && e.message || String(e)));
        }
    }
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

    // eval 之后挂 app / chat mock（脚本里 window.app = {...} / window.chat = {...}
    // 会覆盖提前设的；沿用现有 smoke 测的"eval 后挂 mock"约定）
    const toasts = [];
    if (opts.app === null) {
        try { delete w.app; } catch (_) { w.app = undefined; }
    } else if (w.app) {
        w.app.showToast = opts.app && opts.app.showToast
            ? opts.app.showToast
            : (msg, type) => { toasts.push({ msg, type }); };
    }
    if (opts.chat) {
        // 整体替换 chat 模块——保持 exportVisio 取 currentMermaid / isStreaming 的契约
        w.chat = Object.assign({}, opts.chat);
    }
    return { dom, window: w, document: w.document, errs, calls, toasts };
}

describe('Visio (.vsdx) 导出按钮边界测试（Round 2）', () => {
    it('_loadVisioLib 失败后下次重试能重新发起 import', async () => {
        // 验 Round 2 fix：失败 promise 不应永久缓存，否则用户网络瞬断后永久点不出 visio。
        // 该测让 _loadVisioLib 抛错，然后在 cache 清空后用同步替换为成功 stub 验证重试路径。
        const { window, toasts } = loadPage({ chat: { currentMermaid: 'flowchart TD\nA-->B', isStreaming: false } });
        let attempt = 0;
        window.exportModule._loadVisioLib = async () => {
            attempt += 1;
            if (attempt === 1) throw new Error('mock network failure');
            return {
                svgElementToVsdx: async () => ({ bytes: new Uint8Array([0x50, 0x4b]) })
            };
        };
        // 第一次调用：lib 失败 → catch → 报错 → 但只调用一次 _loadVisioLib
        await window.exportModule.exportVisio.call(window.exportModule);
        // 第二次调用：lib 恢复 → 走完 → 成功路径
        await window.exportModule.exportVisio.call(window.exportModule);

        // 关键断言：第二次调用 _loadVisioLib 被再次触发。如果 fix 失效（cache 永久 rejected），
        // 第二次会得到 rejection 而非调用 attempt++=2
        assert.equal(attempt, 2,
            '第一次失败后第二次必须能再调 _loadVisioLib（cache 不能永久持有 reject），实际次数 ' + attempt);

        // 最后一条 toast 应该是成功（"Visio 已导出"），而不是失败 toast
        const last = toasts[toasts.length - 1];
        assert.ok(last && last.msg === 'Visio 已导出',
            '重试成功后最后一次 toast 必须是"Visio 已导出"，实际 ' + JSON.stringify(last));
    });

    it('mermaid 全局缺失时不调 mermaid.render，提示"未就绪"并保持 _visioBusy=false', async () => {
        // 缺 mermaid 全局（脚本加载失败 / CSP 拦等极端情况）
        const { window, calls, document, toasts } = loadPage({
            mermaid: null,
            chat: { currentMermaid: 'flowchart TD\nA-->B', isStreaming: false }
        });
        await window.exportModule.exportVisio.call(window.exportModule);

        assert.equal(calls.filter((c) => c[0] === 'render').length, 0,
            'mermaid 缺失时不能调到 render');
        assert.ok(toasts.some((t) => /未就绪/.test(t.msg)),
            'mermaid 缺失应提示"未就绪"，实际 toasts ' + JSON.stringify(toasts));
        // 关键：必须没起 holder（早返，不应留任何 DOM 垃圾）
        const holders = document.querySelectorAll('div[style*="-99999px"]');
        assert.equal(holders.length, 0,
            'mermaid 缺失早期应不创建 holder，实际 ' + holders.length + ' 个残留');
        // 守卫态应该 false（一次缺 mermaid 后，下次正常 mermaid 还能点）
        assert.equal(window.exportModule._visioBusy, false,
            'mermaid 缺失后 _visioBusy 必须回归 false，否则按钮卡死');
        // 按钮必须被还原（不应卡在 disabled）
        const btn = document.getElementById('btn-export-visio');
        assert.equal(btn.disabled, false,
            'mermaid 缺失早期必须还原按钮 disabled 状态');
    });

    it('多次点击并发：第二次点击被 _visioBusy 守卫挡掉，render 只调一次', async () => {
        // mock 一个慢 render：第一次点击还卡在 render() 时第二次点 → 应被早返
        const { window, calls, document } = loadPage({
            chat: { currentMermaid: 'flowchart TD\nA-->B', isStreaming: false }
        });
        let firstResolve = null;
        let renderCalls = 0;
        window.mermaid.render = async (id, code) => {
            renderCalls += 1;
            calls.push(['render', id, code]);
            // 第一次调用挂起，等测试手动放行
            if (renderCalls === 1) {
                await new Promise((resolve) => {
                    firstResolve = resolve;
                });
            }
            return { svg: '<svg><text>mock</text></svg>' };
        };
        window.exportModule._loadVisioLib = async () => ({
            svgElementToVsdx: async () => ({ bytes: new Uint8Array([0]) })
        });

        // 不 await 第一个，让它停留在 render 里
        const firstPromise = window.exportModule.exportVisio.call(window.exportModule);
        // 给微任务一个 yield（保证 _visioBusy 已为 true）—— jsdom 没有 setImmediate，
        // 这里用一层 Promise.resolve().then() 让微任务队列推进 _visioBusy = true
        await Promise.resolve();
        // 再让一次微任务（确保 await _loadVisioLib 已经返回、await render 已经挂起）
        await Promise.resolve();

        // 第二次调用——必须被 _visioBusy 早返，不应该再开第二次 mermaid.render
        await window.exportModule.exportVisio.call(window.exportModule);

        // 放行第一次
        assert.ok(typeof firstResolve === 'function', 'firstResolve 应在第二次点击前已 set');
        firstResolve();
        await firstPromise;

        assert.equal(renderCalls, 1,
            '并发点击必须串行化：mermaid.render 只调一次，实际 ' + renderCalls + ' 次');
        // holder 必须只剩一个（第一次创建的；第二次没创建→没留两个）
        const holders = document.querySelectorAll('div[style*="-99999px"]');
        assert.ok(holders.length <= 1,
            '并发点击后 holder 最多残留 1 个（第一次的已被 finally 清），实际 ' + holders.length);
    });

    it('下载文件名是 flowchart-<timestamp>.vsdx 且 MIME 是 Visio 2013+ drawing', async () => {
        // 验契约：与 PNG / SVG 同链路，命名 + MIME 不漂
        const { window } = loadPage({
            chat: { currentMermaid: 'flowchart TD\nA-->B', isStreaming: false }
        });
        let downloadedFilename = null;
        let downloadedMime = null;
        // jsdom hyperlink.click 不会触发文件写入；抓取 blob + link 看契约
        window.exportModule._loadVisioLib = async () => ({
            svgElementToVsdx: async () => ({ bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) })
        });
        // 重写 Blob 构造器：记录 type，并覆写 URL.createObjectURL
        const OrigBlob = window.Blob;
        window.Blob = function (parts, opts) {
            downloadedMime = opts && opts.type;
            return new OrigBlob(parts, opts);
        };
        // 抓 hyperlink.click 时的 download 属性
        const realCreate = window.document.createElement.bind(window.document);
        window.document.createElement = function (tag) {
            const el = realCreate(tag);
            if (tag === 'a') {
                const origDescriptor = Object.getOwnPropertyDescriptor(window.HTMLAnchorElement.prototype, 'click');
                el.click = function () {
                    downloadedFilename = el.download;
                };
            }
            return el;
        };

        await window.exportModule.exportVisio.call(window.exportModule);

        assert.ok(downloadedFilename && /^flowchart-\d+\.vsdx$/.test(downloadedFilename),
            '文件名必须是 flowchart-<timestamp>.vsdx，实际 ' + downloadedFilename);
        assert.equal(downloadedMime, 'application/vnd.ms-visio.drawing.12',
            'MIME 必须是 application/vnd.ms-visio.drawing.12，实际 ' + downloadedMime);
    });

    it('window.chat 缺失时 currentMermaid 视为空，只 toast 不抛', async () => {
        // 不挂 chat——验 exportVisio 在 chat 缺失时的 graceful 降级
        const { window, calls, toasts } = loadPage();
        // 显式卸掉 chat（loadPage 默认不挂 chat）
        await window.exportModule.exportVisio.call(window.exportModule);

        assert.equal(calls.filter((c) => c[0] === 'render').length, 0,
            'chat 缺失时不能调 mermaid.render');
        assert.ok(toasts.some((t) => /没有可导出的图表/.test(t.msg)),
            'chat 缺失应提示"没有可导出的图表"，实际 toasts ' + JSON.stringify(toasts));
    });

    it('离屏 holder 不能 visibility:hidden——库的 isHidden() 会 inherit 到 SVG 子节点，导致 stats 全 0 / vsdx 空白', async () => {
        // 回归保护：2026-08-26 用户报"导出 .vsdx 在 Visio 里空白"，
        // 排查 2 轮定位到 holder.style.cssText 含 visibility:hidden，
        // 被 vendored 库 isHidden() 过滤：每个 SVG 子节点 csVisibility=hidden，
        // walk 阶段全早返，items 数组空 → 产物是 1×1 英寸空白页。
        // 修复：去掉 visibility:hidden，仅靠 left:-99999px 推离视口。
        const { window, document } = loadPage({
            chat: { currentMermaid: 'flowchart TD\nA-->B', isStreaming: false }
        });
        // 在 exportVisio 内 appendChild 时抓 holder 元素
        const origAppend = window.document.body.appendChild.bind(window.document.body);
        let capturedHolder = null;
        window.document.body.appendChild = function (n) {
            // 抓离屏 holder（position:fixed + left:-99999px）
            if (n && n.style && /-99999px/.test(n.style.cssText || n.style.left || '')) {
                capturedHolder = n;
            }
            return origAppend(n);
        };
        window.exportModule._loadVisioLib = async () => ({
            svgElementToVsdx: async () => ({ bytes: new Uint8Array([0x50, 0x4b]), stats: { shapes: 1, texts: 0 } })
        });
        await window.exportModule.exportVisio.call(window.exportModule);
        // 关键断言：holder 不能有 visibility:hidden（否则库 isHidden 过滤）
        assert.ok(capturedHolder, '必须捕获到离屏 holder');
        const holderStyle = capturedHolder.style.cssText || '';
        assert.ok(!/visibility\s*:\s*hidden/i.test(holderStyle),
            '离屏 holder 不能 visibility:hidden（库的 isHidden 会 inherit 到 SVG 子节点）实际: ' + holderStyle);
        assert.ok(!/display\s*:\s*none/i.test(holderStyle),
            '离屏 holder 不能 display:none（库 getBBox 会返回 0 矩形）实际: ' + holderStyle);
    });

    it('SVG 节点缺失（mermaid 渲染出 null svg）时 holder 被清、busy 还原、给出失败 toast', async () => {
        // 验 mermaid.render 返回 {svg: undefined} 的边缘路径
        const { window, document, toasts } = loadPage({
            chat: { currentMermaid: 'flowchart TD\nA-->B', isStreaming: false }
        });
        window.mermaid.render = async () => ({ svg: '' });
        window.exportModule._loadVisioLib = async () => ({
            svgElementToVsdx: async () => ({ bytes: new Uint8Array([0x50, 0x4b]) })
        });
        await window.exportModule.exportVisio.call(window.exportModule);

        const holders = document.querySelectorAll('div[style*="-99999px"]');
        assert.equal(holders.length, 0,
            'SVG 节点缺失时 holder 必须被 finally 清，实际 ' + holders.length + ' 个残留');
        assert.equal(window.exportModule._visioBusy, false,
            '_visioBusy 必须还原，否则按钮卡死');
        const btn = document.getElementById('btn-export-visio');
        assert.equal(btn.disabled, false, '按钮 disabled 必须还原');
        assert.ok(toasts.some((t) => /导出 Visio 失败/.test(t.msg)),
            '应有"导出 Visio 失败" toast，实际 ' + JSON.stringify(toasts));
    });
});
