/**
 * UI Components
 * Handles zoom, pan, background, fullscreen, and panel resizing
 */

const components = {
    // State
    scale: 1,
    translateX: 0,
    translateY: 0,
    isPanning: false,
    startX: 0,
    startY: 0,
    theme: 'light',

    // Elements
    previewContent: null,
    previewArea: null,

    init() {
        this.previewContent = document.getElementById('preview-content');
        this.previewArea = document.getElementById('preview-area');
        this.previewPanel = document.getElementById('panel-right');
        // 画布背景由全站主题（site-theme）统一驱动：读取逻辑收敛在 app.js
        // 的 readSiteTheme，避免两处 localStorage 解析各自漂移
        this.theme = window.app && window.app.readSiteTheme ? window.app.readSiteTheme() : 'light';

        this.initZoomControls();
        this.initPanControls();
        this.initFullscreenControl();
        this.initPreviewFullscreenControl();
        this.initPanelResizer();
        this.initKeyboardShortcuts();

        // Apply theme to canvas
        this.setTheme(this.theme);
    },

    // Zoom controls
    initZoomControls() {
        const btnZoomIn = document.getElementById('btn-zoom-in');
        const btnZoomOut = document.getElementById('btn-zoom-out');
        const btnZoomFit = document.getElementById('btn-zoom-fit');
        const btnZoomReset = document.getElementById('btn-zoom-reset');
        const zoomLevel = document.getElementById('zoom-level');

        btnZoomIn.addEventListener('click', () => this.zoom(0.1));
        btnZoomOut.addEventListener('click', () => this.zoom(-0.1));
        btnZoomFit.addEventListener('click', () => this.zoomToFit());
        btnZoomReset.addEventListener('click', () => this.resetZoom());

        // Mouse wheel zoom
        this.previewArea.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            this.zoom(delta);
        }, { passive: false });
    },

    zoom(delta) {
        // 比例缩放（按当前倍率增减）+ 上限 20x（2000%）：复杂流程图在 500% 下
        // 仍看不清细节；线性步进在大倍率区间放大过慢，比例步进更自然。
        this.scale = Math.max(0.1, Math.min(20, this.scale * (1 + delta)));
        this.applyTransform();
        this.updateZoomDisplay();
    },

    zoomToFit() {
        const container = this.previewArea;
        const content = this.previewContent;

        if (!content || !container) return;

        const containerRect = container.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();

        if (contentRect.width === 0 || contentRect.height === 0) return;

        const scaleX = (containerRect.width - 40) / contentRect.width;
        const scaleY = (containerRect.height - 40) / contentRect.height;

        this.scale = Math.min(scaleX, scaleY, 1);
        this.translateX = 0;
        this.translateY = 0;

        this.applyTransform();
        this.updateZoomDisplay();
    },

    resetZoom() {
        this.scale = 1;
        this.translateX = 0;
        this.translateY = 0;
        this.applyTransform();
        this.updateZoomDisplay();
    },

    updateZoomDisplay() {
        const zoomLevel = document.getElementById('zoom-level');
        if (zoomLevel) {
            zoomLevel.textContent = `${Math.round(this.scale * 100)}%`;
        }
    },

    applyTransform() {
        if (this.previewContent) {
            this.previewContent.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
        }
    },

    // Pan controls
    initPanControls() {
        let isDragging = false;
        let startX, startY;

        this.previewArea.addEventListener('mousedown', (e) => {
            if (e.target.closest('.preview-controls')) return;

            isDragging = true;
            this.startX = e.clientX - this.translateX;
            this.startY = e.clientY - this.translateY;
            this.previewArea.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            this.translateX = e.clientX - this.startX;
            this.translateY = e.clientY - this.startY;
            this.applyTransform();
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            if (this.previewArea) {
                this.previewArea.style.cursor = 'grab';
            }
        });
    },

    // Background: 画布背景与全站主题统一，无独立按钮（旧 btn-bg-* 三态已删除）。
    // 仅接受 'dark' | 'light' 二值，由 app.js 的 toggleSiteTheme 调用。
    setTheme(theme) {
        const oldTheme = this.theme;
        this.theme = theme;

        const container = document.getElementById('mermaid-container');
        if (container) {
            container.classList.remove('bg-dark', 'bg-light');
            container.classList.add(theme === 'light' ? 'bg-light' : 'bg-dark');
        }

        if (this.previewArea) {
            this.previewArea.style.background = theme === 'light' ? '#f5f5f5' : '#1a1a2e';
        }

        // 主题变化时让当前图表以新 mermaid 主题重渲染：复用 app.reinitMermaid
        // 链路（initMermaid + chat.renderMermaid(currentMermaid)），不另造通道
        if (theme !== oldTheme && window.app && window.app.reinitMermaid) {
            window.app.reinitMermaid();
        }
    },

    // Fullscreen control
    initFullscreenControl() {
        const btnFullscreen = document.getElementById('btn-fullscreen');

        btnFullscreen.addEventListener('click', () => this.toggleFullscreen());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'F11') {
                e.preventDefault();
                this.toggleFullscreen();
            }
        });
    },

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                console.log('Fullscreen error:', err);
            });
        } else {
            document.exitFullscreen();
        }
    },

    // Preview panel fullscreen (与上方整页全屏正交：只全屏右面板，隐藏输入面板/header/status bar)
    initPreviewFullscreenControl() {
        const btn = document.getElementById('btn-preview-fullscreen');
        if (!btn) return;

        btn.addEventListener('click', () => this.togglePreviewFullscreen());

        // 同步 active 态：浏览器原生 Esc 退出全屏不经过 click，不监听则按钮
        // 仍显 active，误导用户以为还在预览全屏。
        document.addEventListener('fullscreenchange', () => {
            btn.classList.toggle('active', document.fullscreenElement === this.previewPanel);
        });
    },

    togglePreviewFullscreen() {
        if (document.fullscreenElement !== this.previewPanel) {
            this.previewPanel.requestFullscreen().catch(err => {
                console.log('Preview fullscreen error:', err);
            });
        } else {
            document.exitFullscreen();
        }
    },

    // Panel resizer
    initPanelResizer() {
        const resizer = document.getElementById('resizer-horizontal');
        const leftPanel = document.getElementById('panel-left');
        const rightPanel = document.getElementById('panel-right');

        if (!resizer || !leftPanel || !rightPanel) return;

        let isResizing = false;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const containerRect = document.querySelector('.app-main').getBoundingClientRect();
            const newLeftWidth = e.clientX - containerRect.left;

            if (newLeftWidth > 250 && newLeftWidth < containerRect.width - 250) {
                leftPanel.style.flex = 'none';
                leftPanel.style.width = `${newLeftWidth}px`;
            }
        });

        document.addEventListener('mouseup', () => {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        });
    },

    // Keyboard shortcuts
    initKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+0: Reset zoom
            if (e.ctrlKey && e.key === '0') {
                e.preventDefault();
                this.resetZoom();
            }

            // Ctrl++: Zoom in
            if (e.ctrlKey && (e.key === '+' || e.key === '=')) {
                e.preventDefault();
                this.zoom(0.1);
            }

            // Ctrl+-: Zoom out
            if (e.ctrlKey && e.key === '-') {
                e.preventDefault();
                this.zoom(-0.1);
            }

            // Escape: Exit fullscreen
            if (e.key === 'Escape') {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                }
            }
        });
    }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    components.init();
});

// Export for global access
window.components = components;