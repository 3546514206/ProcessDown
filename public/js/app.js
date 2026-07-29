/**
 * Main Application Logic
 * Handles user input, API calls, and state management
 */

// State
const state = {
    mermaidCode: '',
    history: [],
    theme: localStorage.getItem('theme') || 'dark',
    zoom: 1,
    isGenerating: false,
    // In-memory only, never localStorage: a browser refresh loses it on
    // purpose, and the next generation starts a brand-new session
    sessionId: null
};

// Mirrors the server-side UUID_PATTERN in sessionStore.js so the client can
// fail fast on obviously-wrong input before hitting the network.
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    apiConfig: document.getElementById('api-config'),
    btnCopySession: document.getElementById('btn-copy-session'),
    sessionInput: document.getElementById('session-input'),
    btnRestoreSession: document.getElementById('btn-restore-session')
};

// Initialize Mermaid
function initMermaid() {
    mermaid.initialize({
        startOnLoad: false,
        theme: state.theme === 'light' ? 'default' : 'dark',
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

// Lazily create a session before the first generation. state.isGenerating
// already blocks concurrent clicks, so this cannot race.
async function ensureSession() {
    if (state.sessionId) return;

    const response = await fetch('/api/session', {
        method: 'POST',
        // Required even with an empty body: the server rejects non-JSON
        // POSTs under /api/ with 415
        headers: {
            'Content-Type': 'application/json'
        }
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || '会话创建失败');
    }
    state.sessionId = data.sessionId;
    updateSessionDisplay();
}

// Reflect state.sessionId in the UI. The single input doubles as the display:
// a real id is written back into it so the user can copy/eyeball it; null
// clears it so the placeholder ("paste an id to restore") shows through.
function updateSessionDisplay() {
    if (state.sessionId) {
        elements.sessionInput.value = state.sessionId;
        elements.btnCopySession.disabled = false;
    } else {
        elements.sessionInput.value = '';
        elements.btnCopySession.disabled = true;
    }
}

// Copy the current sessionId to the clipboard (mirrors copyCode).
async function copySessionId() {
    if (!state.sessionId) {
        showToast('尚无会话可复制', 'warning');
        return;
    }
    try {
        await navigator.clipboard.writeText(state.sessionId);
        showToast('会话 ID 已复制到剪贴板', 'success');
    } catch (error) {
        showToast('复制失败', 'error');
    }
}

// Restore a previous session by id. Format is checked client-side first to
// avoid a round-trip for obviously-wrong input; the server re-checks and is
// the source of truth. On success, the last assistant diagram is re-rendered.
async function restoreSession() {
    // Block restore while a generation is in flight: restore overwrites
    // state.sessionId/mermaidCode while generate appends to the old id,
    // silently misfiling the just-generated diagram into the previous session.
    if (state.isGenerating) {
        showToast('生成中，请稍候', 'warning');
        return;
    }
    const input = elements.sessionInput.value.trim();
    if (!input) {
        showToast('请输入会话 ID', 'warning');
        return;
    }
    if (!SESSION_ID_PATTERN.test(input)) {
        showToast('UUID 格式不正确', 'error');
        return;
    }

    try {
        const response = await fetch('/api/session/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: input })
        });
        const data = await response.json();
        if (!response.ok) {
            showToast(data.message || '会话检查失败', 'error');
            return;
        }

        if (data.exists) {
            state.sessionId = data.sessionId;
            updateSessionDisplay();
            // Re-render the last diagram so the canvas reflects continuity
            if (data.lastMermaid) {
                state.mermaidCode = data.lastMermaid;
                elements.codeEditor.value = data.lastMermaid;
                if (window.mermaidRender) {
                    window.mermaidRender.render(data.lastMermaid);
                }
            }
            showToast('已恢复会话', 'success');
        } else {
            showToast('未找到该会话，可能已过期或从未创建', 'warning');
        }
    } catch (error) {
        showToast('恢复会话失败', 'error');
    }
}

// Generate flowchart
async function generateFlowchart() {
    const prompt = elements.inputPrompt.value.trim();

    if (!prompt) {
        showToast('请输入流程描述', 'warning');
        return;
    }

    state.isGenerating = true;
    elements.btnGenerate.disabled = true;
    elements.btnRestoreSession.disabled = true;
    elements.btnCopySession.disabled = true;
    elements.btnGenerate.querySelector('.btn-text').style.display = 'none';
    elements.btnGenerate.querySelector('.btn-loading').style.display = 'inline';

    updateStatus('生成中...', 'loading');
    updateCodeStatus('生成中...', 'loading');

    let responseData = null;

    try {
        await ensureSession();

        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt: prompt,
                mermaid: state.mermaidCode || undefined,
                sessionId: state.sessionId
            })
        });

        const data = await response.json();
        responseData = data;

        if (!response.ok) {
            throw new Error(data.message || '生成失败');
        }

        state.mermaidCode = data.mermaid;
        state.history = data.history || [];

        elements.codeEditor.value = data.mermaid;

        updateStatus('生成成功', 'ready');
        updateCodeStatus('已生成', 'ready');
        showToast('流程图已生成', 'success');

        if (window.mermaidRender) {
            window.mermaidRender.render(data.mermaid);
        }

    } catch (error) {
        console.error('Generation error:', error);
        updateStatus('生成失败', 'error');
        updateCodeStatus('错误', 'error');

        const msg = error.message || '生成失败';
        const hint = responseData?.hint || '';
        showToast(hint ? `${msg}。${hint}` : msg, 'error');
    } finally {
        state.isGenerating = false;
        elements.btnGenerate.disabled = false;
        elements.btnRestoreSession.disabled = false;
        // Re-sync the session box after generation. Covers two paths: (1) the
        // user typed a pending id into the input without restoring -
        // ensureSession returned early on the existing sessionId, leaving the
        // box showing that pending id, so write the real sessionId back; (2)
        // generation failed before a session was created - sessionId is null
        // and this clears the box and disables copy. This also re-derives the
        // copy button's disabled state, subsuming the old manual line.
        updateSessionDisplay();
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

function reinitMermaid() {
    mermaid.initialize({
        startOnLoad: false,
        theme: state.theme === 'light' ? 'default' : 'dark',
        securityLevel: 'loose',
        flowchart: {
            useMaxWidth: true,
            htmlLabels: true
        }
    });

    if (state.mermaidCode && window.mermaidRender) {
        window.mermaidRender.render(state.mermaidCode);
    }
}

// Load config from server
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();

        if (config.llm?.model) {
            elements.apiConfig.textContent = `模型: ${config.llm.model}`;
        } else {
            elements.apiConfig.textContent = '就绪';
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
    if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (!state.isGenerating) {
            generateFlowchart();
        }
    }
}

// Event Listeners
function initEventListeners() {
    elements.btnGenerate.addEventListener('click', generateFlowchart);
    elements.btnClear.addEventListener('click', clearAll);
    elements.btnCopy.addEventListener('click', copyCode);
    elements.btnCopySession.addEventListener('click', copySessionId);
    elements.btnRestoreSession.addEventListener('click', restoreSession);
    elements.codeEditor.addEventListener('input', handleCodeChange);
    document.addEventListener('keydown', handleKeydown);
    elements.inputPrompt.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            if (!state.isGenerating) {
                generateFlowchart();
            }
        }
    });
    // Plain Enter (no modifier keys) in the session input triggers restore.
    // Ctrl+Enter is intentionally NOT handled here so it bubbles to the
    // document handler and stays the generate shortcut - handling it in both
    // would race restoreSession against generateFlowchart on the same
    // keypress. Shift/Alt/Meta+Enter are excluded too, so an in-progress
    // key combo doesn't accidentally fire restore.
    elements.sessionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            restoreSession();
        }
    });
}

// Initialize app
function init() {
    initMermaid();
    initEventListeners();
    loadConfig();
    updateStatus('就绪', 'ready');
    updateSessionDisplay();
}

// Start when DOM is ready
document.addEventListener('DOMContentLoaded', init);

window.app = {
    state,
    generateFlowchart,
    clearAll,
    copyCode,
    showToast,
    updateStatus,
    reinitMermaid
};
