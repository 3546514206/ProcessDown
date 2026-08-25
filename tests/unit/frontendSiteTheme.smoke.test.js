/**
 * 全站主题统一控制烟雾测试：用 jsdom 加载 public/index.html + 全部 public/js，
 * 校验顶栏切换按钮存在、点击后 <html data-theme> 在 dark/light 间切换、
 * localStorage['site-theme'] 持久化、预置浅色记录时启动即为浅色。
 *
 * 统一语义：site-theme 是全站唯一主题状态源--切换时画布背景
 * （mermaid-container 的 bg-* 类 + preview-area 底色）、mermaid 主题
 * （initialize 以新主题重调）、当前图表重渲染（chat.renderMermaid）全部联动。
 * 旧 'theme' 键（画布背景三态）已退役：仅 index.html 内联迁移脚本读取一次，
 * 此后任何前端代码不得读写它。
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
    const initCalls = [];
    w.mermaid = {
        initialize(cfg) { initCalls.push(cfg && cfg.theme); },
        render: async () => ({ svg: '<svg></svg>' })
    };
    w.navigator.clipboard = { writeText: async () => {} };

    // 在脚本加载前预置 localStorage（app.js 的 state 在 eval 时读初始值）
    if (opts.beforeLoad) opts.beforeLoad(w);

    // 顺序加载所有脚本（index.html 中顺序固定；export.js 不参与本测试关注的交互）
    const scripts = ['app.js', 'chat.js', 'mermaid-render.js', 'components.js'];
    for (const s of scripts) {
        const code = fs.readFileSync(path.join(ROOT, 'public', 'js', s), 'utf8');
        w.eval(code);
    }
    // 触发 DOMContentLoaded
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    return { dom, window: w, document: w.document, errs, initCalls };
}

describe('全站主题切换烟雾测试', () => {
    it('切换按钮 DOM 存在', () => {
        const { document } = loadPage();
        assert.ok(document.getElementById('btn-site-theme'), 'DOM #btn-site-theme 必须存在');
    });

    it('无 site-theme 记录时默认浅色', () => {
        const { document } = loadPage();
        assert.equal(document.documentElement.dataset.theme, 'light',
            '默认应为浅色（data-theme="light"）');
    });

    it('点击切换按钮 -> data-theme 变 dark 并持久化', () => {
        const { window, document } = loadPage();
        document.getElementById('btn-site-theme').click();
        assert.equal(document.documentElement.dataset.theme, 'dark',
            '点击后应为深色');
        assert.equal(window.localStorage.getItem('site-theme'), 'dark',
            'site-theme 应持久化为 dark');
    });

    it('再点一次 -> 切回 light 并持久化', () => {
        const { window, document } = loadPage();
        const btn = document.getElementById('btn-site-theme');
        btn.click();
        btn.click();
        assert.equal(document.documentElement.dataset.theme, 'light',
            '第二次点击应切回浅色');
        assert.equal(window.localStorage.getItem('site-theme'), 'light',
            'site-theme 应持久化为 light');
    });

    it('预置 site-theme=light 时启动即为浅色，画布背景同步为浅色档', () => {
        const { document } = loadPage({ beforeLoad: (w) => w.localStorage.setItem('site-theme', 'light') });
        assert.equal(document.documentElement.dataset.theme, 'light',
            '预置 light 时应渲染为浅色');
        assert.ok(document.getElementById('mermaid-container').classList.contains('bg-light'),
            '画布背景类应为 bg-light（#f5f5f5 档）');
        assert.equal(document.getElementById('preview-area').style.background, 'rgb(245, 245, 245)',
            'preview-area 底色应为 #f5f5f5');
    });

    it('默认（未做过任何选择）浅色路径：画布背景为 bg-light 档', () => {
        const { document } = loadPage();
        assert.ok(document.getElementById('mermaid-container').classList.contains('bg-light'),
            '画布背景类应为 bg-light（#f5f5f5 档）');
        assert.equal(document.getElementById('preview-area').style.background, 'rgb(245, 245, 245)',
            'preview-area 底色应为 #f5f5f5');
    });

    it('index.html head 内联防闪烁脚本真实执行：随记录设 light、无记录回退 light、旧 theme 键一次性迁移', () => {
        // 上面的 loadPage 用 runScripts:'outside-only'，index.html head 的
        // 内联脚本从未被执行，测试断言的其实是 app.js 的补写路径。这里改用
        // 'dangerously' 让内联脚本随解析真正跑起来，覆盖防闪烁脚本本身
        // （含旧 'theme' 键 -> site-theme 的一次性迁移）。
        // 外部 <script src> 先剥掉：jsdom 默认 resource loader 不取本地文件，
        // 本用例只关心内联脚本的行为。
        const inlineOnly = html.replace(/<script src=[^>]*><\/script>\s*/g, '');
        const loadInline = (preset) => {
            const dom = new JSDOM(inlineOnly, {
                url: 'http://127.0.0.1:3000/',
                runScripts: 'dangerously',
                pretendToBeVisual: true,
                virtualConsole: new VirtualConsole(),
                // beforeParse 在解析开始前执行，时序上早于 head 内联脚本
                beforeParse(w) {
                    if (preset.siteTheme !== undefined) w.localStorage.setItem('site-theme', preset.siteTheme);
                    if (preset.legacyTheme !== undefined) w.localStorage.setItem('theme', preset.legacyTheme);
                }
            });
            return dom.window;
        };

        // site-theme 已有值：直接生效（存量偏好一律保留）
        assert.equal(loadInline({ siteTheme: 'light' }).document.documentElement.dataset.theme, 'light',
            '预置 site-theme=light 时内联脚本应写入 data-theme="light"');
        assert.equal(loadInline({ siteTheme: 'dark' }).document.documentElement.dataset.theme, 'dark',
            '预置 site-theme=dark 时内联脚本应写入 data-theme="dark"（存量深色偏好保留）');
        assert.equal(loadInline({}).document.documentElement.dataset.theme, 'light',
            '无任何记录时内联脚本应回退 data-theme="light"');

        // 一次性迁移：只有旧 'theme' 键时按其值推导并写回 site-theme。
        // 新规则：显式选过 dark 的保留 dark，light/transparent/其他 -> light
        assert.equal(loadInline({ legacyTheme: 'light' }).document.documentElement.dataset.theme, 'light',
            "旧 'theme'=light 应迁移为浅色");
        const migratedLight = loadInline({ legacyTheme: 'light' });
        assert.equal(migratedLight.localStorage.getItem('site-theme'), 'light',
            '迁移结果应写回 site-theme');
        for (const legacy of ['transparent']) {
            const w = loadInline({ legacyTheme: legacy });
            assert.equal(w.document.documentElement.dataset.theme, 'light',
                `旧 'theme'=${legacy} 应迁移为浅色`);
            assert.equal(w.localStorage.getItem('site-theme'), 'light',
                `旧 'theme'=${legacy} 迁移后 site-theme 应为 light`);
            assert.equal(w.localStorage.getItem('theme'), legacy,
                '旧键应保留不删（无害残留）');
        }
        const migratedDark = loadInline({ legacyTheme: 'dark' });
        assert.equal(migratedDark.document.documentElement.dataset.theme, 'dark',
            "旧 'theme'=dark 应迁移为深色（显式选过深色的保留）");
        assert.equal(migratedDark.localStorage.getItem('site-theme'), 'dark',
            "旧 'theme'=dark 迁移后 site-theme 应为 dark");
        assert.equal(migratedDark.localStorage.getItem('theme'), 'dark',
            '旧键应保留不删（无害残留）');

        // site-theme 已存在时不再看旧键（迁移只发生一次）
        assert.equal(loadInline({ siteTheme: 'dark', legacyTheme: 'light' })
            .document.documentElement.dataset.theme, 'dark',
            'site-theme 已有值时旧键不参与判定');
    });

    it('统一控制：切换主题联动画布背景 + mermaid 主题重初始化 + 当前图表重渲染', () => {
        const { window, document, initCalls } = loadPage();
        assert.equal(initCalls[initCalls.length - 1], 'default',
            '启动时应以 default 主题初始化 mermaid（默认浅色）');
        // 模拟已有一张图：切换主题必须让它用新 mermaid 主题重渲染
        window.chat.currentMermaid = 'flowchart TD\nA-->B';
        const renderArgs = [];
        const origRender = window.chat.renderMermaid;
        window.chat.renderMermaid = function (code) {
            renderArgs.push(code);
            return origRender.call(this, code);
        };

        document.getElementById('btn-site-theme').click();
        assert.equal(document.documentElement.dataset.theme, 'dark', '切到深色');
        assert.ok(document.getElementById('mermaid-container').classList.contains('bg-dark'),
            '画布背景类应联动为 bg-dark');
        assert.equal(document.getElementById('preview-area').style.background, 'rgb(26, 26, 46)',
            'preview-area 底色应联动为 #1a1a2e');
        assert.equal(initCalls[initCalls.length - 1], 'dark',
            'mermaid.initialize 应以 dark 主题重新调用');
        assert.equal(renderArgs[renderArgs.length - 1], 'flowchart TD\nA-->B',
            '重渲染的必须是 currentMermaid 本身（防退化成渲染空串清空预览仍判绿）');

        document.getElementById('btn-site-theme').click();
        assert.equal(document.documentElement.dataset.theme, 'light', '切回浅色');
        assert.ok(document.getElementById('mermaid-container').classList.contains('bg-light'),
            '画布背景类应联动回 bg-light');
        assert.equal(document.getElementById('preview-area').style.background, 'rgb(245, 245, 245)',
            'preview-area 底色应联动回 #f5f5f5');
        assert.equal(initCalls[initCalls.length - 1], 'default',
            'mermaid.initialize 应以 default 主题重新调用');
        assert.equal(renderArgs.length, 2,
            '切回浅色时图表应再重渲染一次（且仅一次）');
        assert.equal(renderArgs[1], 'flowchart TD\nA-->B',
            '切回浅色的重渲染同样必须用 currentMermaid');
    });

    it('流式生成中切换主题：mermaid 主题重设，但不重渲染当前图', () => {
        // 流式中 currentMermaid 停留在上一轮完整图，reinitMermaid 若照常
        // renderMermaid 会用旧图非静默顶掉预览区的流式半成品
        const { window, document, initCalls } = loadPage();
        window.chat.currentMermaid = 'flowchart TD\nA-->B';
        let rendered = 0;
        window.chat.renderMermaid = function () { rendered++; };
        window.chat.isStreaming = true;
        document.getElementById('btn-site-theme').click();
        assert.equal(initCalls[initCalls.length - 1], 'dark',
            'mermaid.initialize 仍应以新主题重调（半成品图后续节流渲染要用）');
        assert.equal(rendered, 0,
            '流式中不得触发 renderMermaid（后续 600ms 节流 silent 渲染自然接棒）');
    });

    it('切换主题不读写已退役的旧 theme 键', () => {
        // beforeLoad 预置旧键残留（迁移只在内联脚本发生一次，这里模拟迁移后的
        // 浏览器：site-theme 已有值，旧 'theme' 仍在但无人再读）
        const { window, document } = loadPage({
            beforeLoad: (w) => {
                w.localStorage.setItem('theme', 'transparent');
                w.localStorage.setItem('site-theme', 'dark');
            }
        });
        assert.equal(window.app.readSiteTheme(), 'dark', '前置：site-theme 为 dark');
        document.getElementById('btn-site-theme').click();
        document.getElementById('btn-site-theme').click();
        assert.equal(window.localStorage.getItem('theme'), 'transparent',
            "旧 'theme' 键不得被写入或删除");
        assert.equal(window.localStorage.getItem('site-theme'), 'dark',
            '主题状态只落在 site-theme');
    });

    it('图标随主题切换：浅色显太阳、深色显月亮', () => {
        const { document } = loadPage();
        const btn = document.getElementById('btn-site-theme');
        const moon = btn.querySelector('.icon-moon');
        const sun = btn.querySelector('.icon-sun');
        assert.equal(moon.style.display, 'none', '浅色态月亮应隐藏');
        assert.equal(sun.style.display, '', '浅色态太阳应可见');
        btn.click();
        assert.equal(moon.style.display, '', '深色态月亮应可见');
        assert.equal(sun.style.display, 'none', '深色态太阳应隐藏');
    });

    it('页面加载与点击序列不应有 console 错误', () => {
        const { errs, document } = loadPage();
        document.getElementById('btn-site-theme').click();
        document.getElementById('btn-site-theme').click();
        assert.equal(errs.length, 0,
            '不应有 console 错误，实际:\n' + errs.join('\n'));
    });
});
