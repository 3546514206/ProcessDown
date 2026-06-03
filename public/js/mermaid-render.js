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

    async render(code) {
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
                commonHints.push('Tip: The code may contain emoji characters. Try regenerating or removing emojis from the code.');
            }
            if (/got\s+'\d+'/i.test(error.message)) {
                commonHints.push('Tip: There may be special characters (emoji, Chinese punctuation) confusing the parser. Check the code editor for issues.');
            }

            const hintsHtml = commonHints.length > 0
                ? `<div class="error-hints">${commonHints.map(h => `<p>${h}</p>`).join('')}</div>`
                : '';

            this.container.innerHTML = `<div class="render-error">
                <p class="error-title">Render Error: ${error.message ? error.message.split('\n')[0] : 'Unknown error'}</p>
                ${errorLine}
                ${hintsHtml}
                <p class="error-action">You can edit the Mermaid code in the editor below to fix syntax issues, or click "Generate" again to regenerate.</p>
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