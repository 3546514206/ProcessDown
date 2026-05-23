/**
 * Main Application Logic
 * Handles user input, API calls, and state management
 */

// State
const state = {
    mermaidCode: '',
    history: [],
    apiKey: localStorage.getItem('api_key') || '',
    theme: localStorage.getItem('theme') || 'dark',
    zoom: 1,
    isGenerating: false,
    serverAuthEnabled: false
};

// DOM Elements
const elements = {
    inputPrompt: document.getElementById('input-prompt'),
    codeEditor: document.getElementById('code-editor'),
    btnGenerate: document.getElementById('btn-generate'),
    btnClear: document.getElementById('btn-clear'),
    btnCopy: document.getElementById('btn-copy'),
    statusText: document.getElementById('status-text'),
    codeStatus: document.getElementById('code-status'),
    toastContainer: document.getElementById('toast-container'),
    settingsModal: document.getElementById('settings-modal'),
    settingApiKey: document.getElementById('setting-api-key'),
    settingTheme: document.getElementById('setting-theme'),
    btnSettings: document.getElementById('btn-settings'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    apiConfig: document.getElementById('api-config')
};

// Initialize Mermaid
function initMermaid() {
    mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        flowchart: {
            useMaxWidth: true,
            htmlLabels: true
        }
    });
}

// Show toast notification
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 4000);
}

// Update status
function updateStatus(text, type = 'ready') {
    elements.statusText.textContent = text;
    elements.statusText.className = `status-${type}`;
}

function updateCodeStatus(text, type = 'ready') {
    elements.codeStatus.textContent = text;
}

// Generate flowchart
async function generateFlowchart() {
    const prompt = elements.inputPrompt.value.trim();

    if (!prompt) {
        showToast('请输入流程描述', 'warning');
        return;
    }

    if (state.serverAuthEnabled && !state.apiKey) {
        showToast('请先设置 API Key', 'error');
        openSettings();
        return;
    }

    state.isGenerating = true;
    elements.btnGenerate.disabled = true;
    elements.btnGenerate.querySelector('.btn-text').style.display = 'none';
    elements.btnGenerate.querySelector('.btn-loading').style.display = 'inline';

    updateStatus('生成中...', 'loading');
    updateCodeStatus('生成中...', 'loading');

    try {
        const headers = {
            'Content-Type': 'application/json'
        };

        if (state.serverAuthEnabled && state.apiKey) {
            headers['X-API-Key'] = state.apiKey;
        }

        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                prompt: prompt,
                mermaid: state.mermaidCode || undefined
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || '生成失败');
        }

        state.mermaidCode = data.mermaid;
        state.history = data.history || [];

        elements.codeEditor.value = data.mermaid;

        updateStatus('生成成功', 'ready');
        updateCodeStatus('已生成', 'ready');
        showToast('流程图已生成', 'success');

        // Render the diagram
        if (window.mermaidRender) {
            window.mermaidRender.render(data.mermaid);
        }

    } catch (error) {
        console.error('Generation error:', error);
        updateStatus('生成失败', 'error');
        updateCodeStatus('错误', 'error');
        showToast(error.message, 'error');
    } finally {
        state.isGenerating = false;
        elements.btnGenerate.disabled = false;
        elements.btnGenerate.querySelector('.btn-text').style.display = 'inline';
        elements.btnGenerate.querySelector('.btn-loading').style.display = 'none';
    }
}

// Clear all
function clearAll() {
    elements.inputPrompt.value = '';
    elements.codeEditor.value = '';
    state.mermaidCode = '';
    state.history = [];
    updateStatus('已清空', 'ready');
    updateCodeStatus('就绪', 'ready');

    if (window.mermaidRender) {
        window.mermaidRender.clear();
    }
}

// Copy code
async function copyCode() {
    const code = elements.codeEditor.value;
    if (!code) {
        showToast('没有可复制的代码', 'warning');
        return;
    }

    try {
        await navigator.clipboard.writeText(code);
        showToast('代码已复制到剪贴板', 'success');
    } catch (error) {
        showToast('复制失败', 'error');
    }
}

// Settings
function openSettings() {
    elements.settingsModal.style.display = 'block';
    elements.settingApiKey.value = state.apiKey;
    elements.settingTheme.value = state.theme;
}

function closeSettings() {
    elements.settingsModal.style.display = 'none';
}

function saveSettings() {
    state.apiKey = elements.settingApiKey.value.trim();
    state.theme = elements.settingTheme.value;

    if (state.apiKey) {
        localStorage.setItem('api_key', state.apiKey);
    } else {
        localStorage.removeItem('api_key');
    }

    localStorage.setItem('theme', state.theme);

    // Apply theme
    if (window.components) {
        window.components.setTheme(state.theme);
    }

    closeSettings();
    showToast('设置已保存', 'success');
}

// Load config from server
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();

        state.serverAuthEnabled = config.auth?.enabled || false;

        if (config.auth && config.auth.enabled) {
            elements.apiConfig.textContent = 'API 认证: 已启用';
        } else {
            elements.apiConfig.textContent = 'API 认证: 未启用';
        }
    } catch (error) {
        console.error('Failed to load config:', error);
    }
}

// Debounce function for code editor
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Handle code editor changes
const handleCodeChange = debounce(() => {
    const code = elements.codeEditor.value;
    if (code && code !== state.mermaidCode) {
        state.mermaidCode = code;
        if (window.mermaidRender) {
            window.mermaidRender.render(code);
        }
    }
}, 600);

// Keyboard shortcuts
function handleKeydown(e) {
    // Ctrl+Enter: Generate
    if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (!state.isGenerating) {
            generateFlowchart();
        }
    }
}

// Event Listeners
function initEventListeners() {
    // Generate button
    elements.btnGenerate.addEventListener('click', generateFlowchart);

    // Clear button
    elements.btnClear.addEventListener('click', clearAll);

    // Copy button
    elements.btnCopy.addEventListener('click', copyCode);

    // Code editor changes
    elements.codeEditor.addEventListener('input', handleCodeChange);

    // Settings
    elements.btnSettings.addEventListener('click', openSettings);
    elements.btnCloseSettings.addEventListener('click', closeSettings);
    elements.btnSaveSettings.addEventListener('click', saveSettings);

    // Close modal on backdrop click
    elements.settingsModal.querySelector('.modal-backdrop').addEventListener('click', closeSettings);

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeydown);

    // Ctrl+Enter to generate
    elements.inputPrompt.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            if (!state.isGenerating) {
                generateFlowchart();
            }
        }
    });
}

// Initialize app
function init() {
    initMermaid();
    initEventListeners();
    loadConfig();
    updateStatus('就绪', 'ready');
}

// Start when DOM is ready
document.addEventListener('DOMContentLoaded', init);

// Export for global access
window.app = {
    state,
    generateFlowchart,
    clearAll,
    copyCode,
    showToast,
    updateStatus
};