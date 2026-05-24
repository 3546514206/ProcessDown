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
    theme: 'dark',

    // Elements
    previewContent: null,
    previewArea: null,

    init() {
        this.previewContent = document.getElementById('preview-content');
        this.previewArea = document.getElementById('preview-area');
        this.theme = localStorage.getItem('theme') || 'dark';

        this.initZoomControls();
        this.initPanControls();
        this.initBackgroundControls();
        this.initFullscreenControl();
        this.initPanelResizer();
        this.initKeyboardShortcuts();

        // Load saved theme
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
        this.scale = Math.max(0.1, Math.min(5, this.scale + delta));
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

    // Background controls
    initBackgroundControls() {
        const btnBgDark = document.getElementById('btn-bg-dark');
        const btnBgLight = document.getElementById('btn-bg-light');
        const btnBgTransparent = document.getElementById('btn-bg-transparent');

        btnBgDark.addEventListener('click', () => this.setTheme('dark'));
        btnBgLight.addEventListener('click', () => this.setTheme('light'));
        btnBgTransparent.addEventListener('click', () => this.setTheme('transparent'));

        // Update button states
        this.updateBgButtons();
    },

    setTheme(theme) {
        const oldTheme = this.theme;
        this.theme = theme;
        localStorage.setItem('theme', theme);

        const container = document.getElementById('mermaid-container');
        if (container) {
            container.classList.remove('bg-dark', 'bg-light', 'bg-transparent');

            if (theme === 'dark') {
                container.classList.add('bg-dark');
            } else if (theme === 'light') {
                container.classList.add('bg-light');
            }
        }

        this.updateBgButtons();

        if (this.previewArea) {
            this.previewArea.style.background = theme === 'transparent'
                ? 'repeating-conic-gradient(#e8e8e8 0% 25%, #fff 0% 50%) 50% / 20px 20px'
                : (theme === 'dark' ? '#1a1a2e' : '#f5f5f5');
        }

        if (theme !== oldTheme && window.app && window.app.reinitMermaid) {
            window.app.reinitMermaid();
        }
    },

    updateBgButtons() {
        const buttons = [
            { id: 'btn-bg-dark', theme: 'dark' },
            { id: 'btn-bg-light', theme: 'light' },
            { id: 'btn-bg-transparent', theme: 'transparent' }
        ];

        buttons.forEach(({ id, theme }) => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.classList.toggle('active', this.theme === theme);
            }
        });
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