/**
 * Export functionality
 * Handles PNG, SVG, and Visio (.vsdx) export.
 * PNG 走服务端 resvg-wasm；SVG 走前端 Blob；Visio 走 vendored
 * @klyratech/mermaid-to-visio（前端 dynamic import），三者均与登录态、共用主题。
 * 三套入口：exportPNG(scale) / exportSVG() / exportVisio()——前者被 showExportOptions
 * 缩放菜单复用，后两者是按钮直连；exportVisio 与前两者共享 _visioBusy 串行化守卫。
 */

const exportModule = {
    // ---- Visio 模块私有状态 -------------------------------------------------
    // 与 exportModule 同生命周期；放对象内（而不是模块级闭包）以保持 `this` 一致与
    // 测试钩子友好（单测可直接读 this._visio*）
    _visioLibPromise: null,
    _visioRenderSeq: 0,
    _visioBusy: false,

    // 首次点击才动态 import 这 24KB：后续复用同一 promise（避免每次连点重解析 ESM）。
    // 命中 public/vendor/ 的 ?v= 强缓存（max-age=86400），离线也能复用。
    // 失败时清空缓存：一次 404/网络瞬断不能永久废掉按钮，下次点击要能重试。
    // 成功 promise 继续缓存（覆盖 hot path，多窗口/多标签同时点也只取一次）
    _loadVisioLib() {
        if (!this._visioLibPromise) {
            this._visioLibPromise = import('/vendor/mermaid-to-visio.esm.js?v=0.1.0')
                .then((mod) => mod)
                .catch((e) => {
                    this._visioLibPromise = null;
                    throw e;
                });
        }
        return this._visioLibPromise;
    },

    init() {
        this.initExportButtons();
    },

    initExportButtons() {
        const btnExportPng = document.getElementById('btn-export-png');
        const btnExportSvg = document.getElementById('btn-export-svg');
        const btnExportVisio = document.getElementById('btn-export-visio');

        btnExportPng.addEventListener('click', () => this.showExportOptions());
        btnExportSvg.addEventListener('click', () => this.exportSVG());
        // 与 PNG/SVG 同 set：导出中全程禁用按钮 + 模块级守卫，防止连点触发并发重渲染。
        // mermaid.render 不是真正的并发安全（同 process 同时刻同一 id 候选串会冲突），
        // 因此必须串行化。模块级守卫防 SVG / PNG / Visio 之间跨链路的并发
        if (btnExportVisio) {
            btnExportVisio.addEventListener('click', () => this.exportVisio());
        }
    },

    getSvgString() {
        if (window.mermaidRender) {
            return window.mermaidRender.getSvg();
        }
        const container = document.getElementById('mermaid-container');
        const svg = container ? container.querySelector('svg') : null;
        return svg ? svg.outerHTML : null;
    },

    exportSVG() {
        const svgString = this.getSvgString();

        if (!svgString) {
            window.app.showToast('没有可导出的 SVG', 'warning');
            return;
        }

        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = `flowchart-${Date.now()}.svg`;
        link.click();

        URL.revokeObjectURL(url);
        window.app.showToast('SVG 已导出', 'success');
    },

    async exportPNG(scale = 1) {
        const svgString = this.getSvgString();

        if (!svgString) {
            window.app.showToast('没有可导出的图表', 'warning');
            return;
        }

        try {
            // 导出底色跟随全站主题：深色站导深底、浅色站导白底。
            // 走 getSiteTheme（运行时真源）而非读存储：持久化失败（隐私模式）
            // 时界面已浅色，读存储会拿到旧 'dark' 导出深底图
            const theme = window.app && window.app.getSiteTheme
                ? window.app.getSiteTheme()
                : 'light';

            // 走 apiFetch：自动带 Bearer 登录态，且 401 时清 token 弹登录遮罩
            // （原生 fetch 会在 token 过期时卡在错误 toast）。apiFetch 已设
            // Content-Type，这里不再重复传 headers。
            const response = await window.app.apiFetch('/api/export/png', {
                method: 'POST',
                body: JSON.stringify({
                    svg: svgString,
                    scale: scale,
                    bg: theme
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || '导出失败');
            }

            const blob = await response.blob();

            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `flowchart-${Date.now()}-${scale}x.png`;
            link.click();

            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            window.app.showToast(`PNG 已导出 (${scale}x)`, 'success');

        } catch (error) {
            console.error('Export PNG error:', error);
            window.app.showToast('导出 PNG 失败: ' + error.message, 'error');
        }
    },

    showExportOptions() {
        const existingMenu = document.querySelector('.export-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'export-menu';
        menu.innerHTML = `
            <div class="export-menu-item" data-scale="1">1x (标准)</div>
            <div class="export-menu-item" data-scale="2">2x (高清)</div>
            <div class="export-menu-item" data-scale="3">3x (超清)</div>
        `;

        const btn = document.getElementById('btn-export-png');
        const rect = btn.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 5}px`;
        menu.style.left = `${rect.left}px`;

        document.body.appendChild(menu);

        const closeMenu = (e) => {
            if (menu.contains(e.target)) return;
            menu.remove();
            document.removeEventListener('click', closeMenu);
        };

        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 10);

        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.export-menu-item');
            if (!item) return;
            const scale = parseInt(item.dataset.scale) || 1;
            document.removeEventListener('click', closeMenu);
            menu.remove();
            this.exportPNG(scale);
        });
    },

    // ---- Visio (.vsdx) 导出 -------------------------------------------------
    // 与 PNG/SVG 同 set，但调用栈完全本地：动态 import vendored lib（24KB 零依赖 ESM）→
    // 在离屏容器里以 htmlLabels:false 重渲染 → 喂给 svgElementToVsdx → Blob 下载。
    // 配置改 mermaid.initialize 必须 try/finally 还：mermaid 是全局单例，不还污染
    // 后续画布渲染（主题切换 / chat 流式 finalize 等都走 mermaid.render）。
    // exportVisio 串行化见 _visioBusy 模块级守卫：mermaid.render 不是真正的并发安全
    // （同 process 同时刻同 id 候选串会冲突），必须串行化。
    async exportVisio() {
        // 取最新一张图：与 chat.renderHistory 落地路径同源（chat.currentMermaid），
        // 也是 diagram.json 当前规范图表；用户编辑后的代码也会被覆盖正确处理（见 _onCodeEdited）
        const code = window.chat && window.chat.currentMermaid || '';
        if (!code.trim()) {
            window.app.showToast('没有可导出的图表', 'warning');
            return;
        }
        // 流式期间禁导：与 PNG/SVG 一致；此外流式代码面板 readonly 是为保护 pending 落盘与
        // 用户光标——中途 exportVisio 触发 mermaid 重渲染会顶掉预览区半成品
        if (window.chat && window.chat.isStreaming) {
            window.app.showToast('生成中，请稍候', 'warning');
            return;
        }
        // mermaid 全局缺失兜底：理论边界（index.html 通过 <script> 同步注入），但
        // 极端缺件（脚本加载失败/被 CSP 拦）会让后面的 mermaid.render 抛
        // TypeError，向上炸到用户那里更不友好。早返 + 给提示。
        if (!window.mermaid || typeof window.mermaid.render !== 'function') {
            window.app.showToast('Mermaid 未就绪，请稍候再试', 'error');
            return;
        }
        // 兜底：按钮 disabled 与函数入口之间仍有竞态（极端快速连点），这里硬挡
        if (this._visioBusy) return;
        this._visioBusy = true;

        const btn = document.getElementById('btn-export-visio');
        const prevDisabled = btn ? btn.disabled : false;
        if (btn) btn.disabled = true;

        // 离屏 holder：仅靠 left:-99999px 推到视口外，**不能** visibility:hidden。
        // 库的 isHidden() 会过滤 visibility:hidden / display:none / opacity:0，
        // holder 上设 visibility:hidden 会让 SVG 子节点全部 inherit 到 hidden，
        // 库 walk 阶段每个节点都早返，items 为空 → vsdx 空白。
        // 仅 left:-99999px 即可（不影响用户视觉，不触发 isHidden）
        const holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:auto;height:auto;pointer-events:none';
        document.body.appendChild(holder);

        let prevMermaidConfig = null;
        try {
            const { svgElementToVsdx } = await this._loadVisioLib();

            // htmlLabels 必须 false：默认 (true) 把节点文字塞进 <foreignObject><div>，
            // 库的 SVG → Geometry 路径只解析 <text>，吃外标签会把所有节点导成空框。
            // 用 mermaid.getConfig() 做整盘快照，再深合并覆写 htmlLabels 子键，
            // 保留主题、安全级别、flowchart 其它子项，try/finally 把整盘快照还回去
            // mermaid 11.x 把 flowchart.htmlLabels 标为 deprecated，getEffectiveHtmlLabels
            // 实际读顶层 htmlLabels；只覆写 flowchart.htmlLabels 不生效，必须顶层+flowchart
            // 双覆写，否则 mermaid 仍走 foreignObject 路径 → 库抽不到 shape → 产物空白
            prevMermaidConfig = window.mermaid && window.mermaid.getConfig
                ? window.mermaid.getConfig()
                : null;
            if (prevMermaidConfig) {
                const baseFlowchart = (prevMermaidConfig.flowchart && typeof prevMermaidConfig.flowchart === 'object')
                    ? prevMermaidConfig.flowchart
                    : {};
                window.mermaid.initialize({
                    ...prevMermaidConfig,
                    htmlLabels: false,
                    flowchart: { ...baseFlowchart, htmlLabels: false }
                });
            }

            const renderId = 'vsdx-' + (++this._visioRenderSeq) + '-' + Date.now();
            const result = await window.mermaid.render(renderId, code);
            const svgString = result && result.svg;
            if (!svgString) throw new Error('渲染未产出 SVG');
            // foreignObject → text 转换：mermaid 11.x 的 flowchart / stateDiagram-v2 /
            // classDiagram / erDiagram / pie / gantt / C4* 等图表默认把节点文字塞进
            // <foreignObject><div xmlns=...xhtml>，但 vendored visio 库的 captureSvgToDisplayList
            // 只 walk <text> + 7 种基本图元（见 public/vendor/mermaid-to-visio.esm.js
            // SKIP_ANCESTORS / polyFor），<div> 子树直接丢 → vsdx 空白。**在喂给 holder
            // 之前**先把 svgString 字符串归一化成纯 <text>/<tspan> 形态（与 PNG 端共用同一
            // 函数 src/utils/svgForeignObjectToText.js 的浏览器版，逻辑一致）。不依赖
            // mermaid 配置切换（htmlLabels:false 已被 mermaid 11.x deprecate，且只对
            // flowchart 生效），属于输出端兜底，对所有图表类型普适。
            const visioSafeSvg = window.svgForeignObjectToText
                ? window.svgForeignObjectToText.convertForeignObjectToText(svgString)
                : svgString;
            // 把 svg 串塞进离屏 holder：库要吃挂在 document 里的 svg DOM 元素才能
            // getBBox 拿到像素尺寸（脱离 DOM 的 detached SVG 多数浏览器补 0）
            holder.innerHTML = visioSafeSvg;
            const svgEl = holder.querySelector('svg');
            if (!svgEl) throw new Error('未找到 SVG 节点');

            const baseName = 'flowchart-' + Date.now();
            const out = await svgElementToVsdx(svgEl, { title: baseName });
            const bytes = out && out.bytes;
            if (!bytes) throw new Error('库未产出 vsdx 字节流');
            // 硬验证：库报告 0 shapes + 0 texts 时产物就是一片空白（库内部 fallback
            // 到 1×1 英寸页）。明确抛错避免用户闷头下一个空白 vsdx 而误以为成功。
            if (out && out.stats && out.stats.shapes === 0 && out.stats.texts === 0) {
                throw new Error('库未从 SVG 抽取到任何 shape/text（mermaid 输出与库解析失配？）');
            }

            // .vsdx 是 OPC ZIP 包；MIME 取 Visio 2013+ drawing
            const blob = new Blob([bytes], { type: 'application/vnd.ms-visio.drawing.12' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = baseName + '.vsdx';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            window.app.showToast('Visio 已导出', 'success');
        } catch (e) {
            // 不区分 mermaid 错 / 库错 / 任意网络或 shape 几何错：用户只关心"导出 Visio"结果
            console.error('Export Visio error:', e);
            window.app.showToast('导出 Visio 失败: ' + (e && e.message || String(e)), 'error');
        } finally {
            // 配置必须还：mermaid 是全局单例，不还污染后续渲染（app.reinitMermaid 后续
            // 不会帮我们兜底——它只用 initMermaid 模板，与本次临时覆写无关）
            if (prevMermaidConfig && window.mermaid) {
                try { window.mermaid.initialize(prevMermaidConfig); } catch (_) { /* swallow */ }
            }
            if (holder.parentNode) holder.parentNode.removeChild(holder);
            this._visioBusy = false;
            if (btn) btn.disabled = !!prevDisabled;
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    exportModule.init();
});

window.exportModule = exportModule;