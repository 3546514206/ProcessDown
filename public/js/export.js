/**
 * Export functionality
 * Handles PNG and SVG export using server-side rendering
 */

const exportModule = {
    init() {
        this.initExportButtons();
    },

    initExportButtons() {
        const btnExportPng = document.getElementById('btn-export-png');
        const btnExportSvg = document.getElementById('btn-export-svg');

        btnExportPng.addEventListener('click', () => this.showExportOptions());
        btnExportSvg.addEventListener('click', () => this.exportSVG());
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
            const theme = localStorage.getItem('theme') || 'dark';

            const response = await fetch('/api/export/png', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
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
            <div class="export-menu-item" data-scale="4">4x (4K)</div>
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
    }
};

document.addEventListener('DOMContentLoaded', () => {
    exportModule.init();
});

window.exportModule = exportModule;