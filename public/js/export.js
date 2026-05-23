/**
 * Export functionality
 * Handles PNG and SVG export
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

    getSvgElement() {
        const container = document.getElementById('mermaid-container');
        return container ? container.querySelector('svg') : null;
    },

    getSvgString() {
        const svg = this.getSvgElement();
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
        const svg = this.getSvgElement();

        if (!svg) {
            window.app.showToast('没有可导出的图表', 'warning');
            return;
        }

        try {
            // Create canvas
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // Get SVG dimensions
            const bbox = svg.getBoundingClientRect();
            const width = bbox.width * scale;
            const height = bbox.height * scale;

            canvas.width = width;
            canvas.height = height;

            // Create image from SVG
            const svgData = new XMLSerializer().serializeToString(svg);
            const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(svgBlob);

            const img = new Image();

            img.onload = () => {
                // Draw white background
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);

                // Draw SVG
                ctx.drawImage(img, 0, 0, width, height);

                // Export
                canvas.toBlob((blob) => {
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = `flowchart-${Date.now()}-${scale}x.png`;
                    link.click();

                    URL.revokeObjectURL(url);
                    window.app.showToast(`PNG 已导出 (${scale}x)`, 'success');
                }, 'image/png');
            };

            img.onerror = () => {
                throw new Error('Failed to load SVG');
            };

            img.src = url;

        } catch (error) {
            console.error('Export PNG error:', error);
            window.app.showToast('导出 PNG 失败', 'error');
        }
    },

    showExportOptions() {
        // Create a simple options menu
        const menu = document.createElement('div');
        menu.className = 'export-menu';
        menu.innerHTML = `
            <div class="export-menu-item" data-scale="1">1x (标准)</div>
            <div class="export-menu-item" data-scale="2">2x (高清)</div>
            <div class="export-menu-item" data-scale="3">3x (超清)</div>
            <div class="export-menu-item" data-scale="4">4x (4K)</div>
        `;

        // Style
        menu.style.cssText = `
            position: fixed;
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 4px;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `;

        document.querySelectorAll('.export-menu-item').forEach(item => {
            item.style.cssText = `
                padding: 8px 16px;
                cursor: pointer;
                border-radius: 4px;
                font-size: 13px;
            `;
            item.addEventListener('mouseenter', () => {
                item.style.background = 'var(--bg-tertiary)';
            });
            item.addEventListener('mouseleave', () => {
                item.style.background = 'transparent';
            });
        });

        // Position near button
        const btn = document.getElementById('btn-export-png');
        const rect = btn.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 5}px`;
        menu.style.left = `${rect.left}px`;

        // Handle click
        menu.addEventListener('click', (e) => {
            const scale = e.target.dataset.scale;
            if (scale) {
                this.exportPNG(parseInt(scale));
                menu.remove();
            }
        });

        // Close on click outside
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };

        document.addEventListener('click', closeMenu);
        document.body.appendChild(menu);
    }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    exportModule.init();
});

// Export for global access
window.exportModule = exportModule;