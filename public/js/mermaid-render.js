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
            this.container.innerHTML = `<div class="render-error">
                <p>渲染错误: ${error.message}</p>
                <pre>${code}</pre>
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