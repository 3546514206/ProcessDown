/**
 * Mermaid Renderer
 * Handles rendering of Mermaid diagrams
 */

const mermaidRender = {
    container: null,
    currentCode: '',

    init() {
        this.container = document.getElementById('mermaid-container');
    },

    async render(code, options = {}) {
        if (!code) {
            this.clear();
            return;
        }

        this.currentCode = code;

        try {
            // Use mermaid to render
            const id = 'mermaid-' + Date.now();
            const { svg } = await mermaid.render(id, code);

            // Update container
            this.container.innerHTML = svg;

            // Apply theme class
            this.applyThemeClass();

        } catch (error) {
            // silent: 流式节流渲染时代码不完整是常态，失败时保留上一次成功渲染，
            // 不写 render-error 进 DOM（否则预览区每 600ms 闪烁错误）。仅最终渲染
            // （非 silent）才展示诊断错误。
            if (options.silent) {
                return;
            }
            console.error('Mermaid render error:', error);

            let errorLine = '';
            const lineMatch = error.message && error.message.match(/line\s+(\d+)/i);
            if (lineMatch) {
                const lineNum = parseInt(lineMatch[1]);
                const codeLines = code.split('\n');
                if (lineNum > 0 && lineNum <= codeLines.length) {
                    const start = Math.max(0, lineNum - 3);
                    const end = Math.min(codeLines.length, lineNum + 2);
                    const snippet = codeLines.slice(start, end).map((l, i) => {
                        const n = start + i + 1;
                        return n === lineNum ? `>> ${n}: ${l}` : `   ${n}: ${l}`;
                    }).join('\n');
                    errorLine = `<pre class="error-snippet">${snippet}</pre>`;
                }
            }

            const commonHints = [];
            if (/emoji|got\s+'\\u/i.test(error.message)) {
                commonHints.push('提示：代码里可能混入了表情符号，请重新生成或在聊天框的"Mermaid 代码"折叠面板里删除表情。');
            }
            if (/got\s+'\d+'/i.test(error.message)) {
                commonHints.push('提示：可能存在表情符号或中文标点等特殊字符干扰解析器，请检查聊天框里的"Mermaid 代码"折叠面板。');
            }

            // gitGraph 专属错误诊断：仅当当前代码确实含 `gitGraph` 头部时提示，
            // 避免误把其他图的报错归到 gitGraph。
            if (/\bgitGraph\b/i.test(code)) {
                // v10+ merge algorithm 关键字：SQUASH / REBASE / FAST_FORWARD(-)/ NO_FF
                // 错误信息通常包含出错的源行片段，匹配 `type: <keyword>` 形态足够精确。
                if (/\btype:\s*(SQUASH|REBASE|FAST_FORWARD|FAST-FORWARD|NO_FF)\b/i.test(error.message)) {
                    commonHints.push('gitGraph merge 行上的 type 关键字 (SQUASH/REBASE/FAST_FORWARD/NO_FF) 是 Mermaid v10+ 特性，本项目 vendored 解析器不支持。直接把 `merge ... type: <keyword>` 段删掉即可，例如 `merge feature/x type: SQUASH tag: "v1"` 改成 `merge feature/x tag: "v1"`。');
                }
                // v10+ cherry-pick 语法 &<branch>：错误信息里常含 `&<branch>` 字面
                if (/&[A-Za-z0-9_./-]+/.test(error.message)) {
                    commonHints.push('gitGraph 检测到 v10+ cherry-pick 语法 `&<branch>`，本项目不支持。把 commit/merge 行尾的 `&分支名` 整段删掉即可，例如 `commit id: "a" &feature/x` 改成 `commit id: "a"`。');
                }
                // gitGraph 头部方向 LR/TB/RL/BT：line 1 parse error 且头部确实带方向
                if (/Parse error on line 1/i.test(error.message) && /\bgitGraph\s+(LR|TB|RL|BT)\b/i.test(code)) {
                    commonHints.push('gitGraph 头部方向关键字（LR / TB / RL / BT）是 Mermaid v10.3.0+ 特性，本项目 vendored 解析器不接受。改成裸 `gitGraph` 即可（默认方向已够用）。');
                }
            }

            const hintsHtml = commonHints.length > 0
                ? `<div class="error-hints">${commonHints.map(h => `<p>${h}</p>`).join('')}</div>`
                : '';

            this.container.innerHTML = `<div class="render-error">
                <p class="error-title">渲染失败：${error.message ? error.message.split('\n')[0] : '未知错误，请稍后重试'}</p>
                ${errorLine}
                ${hintsHtml}
                <p class="error-action">点击聊天框下方的"重新生成"重试一次，或调整描述后再次发送。</p>
            </div>`;
        }
    },

    clear() {
        this.container.innerHTML = '<div class="placeholder">预览区域</div>';
        this.currentCode = '';
    },

    applyThemeClass() {
        const theme = localStorage.getItem('theme') || 'dark';

        this.container.classList.remove('bg-dark', 'bg-light', 'bg-transparent');

        if (theme === 'dark') {
            this.container.classList.add('bg-dark');
        } else if (theme === 'light') {
            this.container.classList.add('bg-light');
        } else {
            this.container.classList.add('bg-transparent');
        }
    },

    getSvg() {
        const svgElement = this.container.querySelector('svg');
        return svgElement ? svgElement.outerHTML : null;
    },

    getSvgElement() {
        return this.container.querySelector('svg');
    }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    mermaidRender.init();
});

// Export for global access
window.mermaidRender = mermaidRender;