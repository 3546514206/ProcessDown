/**
 * Main Application Logic
 * 负责鉴权、历史抽屉、状态栏、配置加载。聊天与生成逻辑见 chat.js。
 *
 * 登录态：token 存 localStorage('pd_token')，每次请求带 Authorization: Bearer。
 * 会话 id 在内存 state.sessionId，首次生成前由 chat 触发 ensureSession 懒申请。
 */

// State
const state = {
    theme: localStorage.getItem('theme') || 'dark',
    user: null,
    // In-memory only：当前会话 id。null 表示尚未创建，首次生成时懒申请。
    sessionId: null
};

// DOM Elements（仅保留鉴权/抽屉/状态相关；聊天区元素归 chat.js 管理）
const elements = {
    statusText: document.getElementById('status-text'),
    toastContainer: document.getElementById('toast-container'),
    apiConfig: document.getElementById('api-config'),
    // 登录遮罩
    loginMask: document.getElementById('login-mask'),
    loginForm: document.getElementById('login-form'),
    registerForm: document.getElementById('register-form'),
    loginUsername: document.getElementById('login-username'),
    loginPassword: document.getElementById('login-password'),
    registerUsername: document.getElementById('register-username'),
    registerPassword: document.getElementById('register-password'),
    loginMessage: document.getElementById('login-message'),
    loginTabs: document.querySelectorAll('.login-tab'),
    // 历史抽屉
    drawer: document.getElementById('history-drawer'),
    btnToggleDrawer: document.getElementById('btn-toggle-drawer'),
    btnNewSession: document.getElementById('btn-new-session'),
    btnCloseDrawer: document.getElementById('btn-close-drawer'),
    historyList: document.getElementById('history-list'),
    // 顶栏
    userBadge: document.getElementById('user-badge'),
    btnLogout: document.getElementById('btn-logout')
};

// Initialize Mermaid
function initMermaid() {
    // mermaid v11 只接受 base 主题名（dark/default/forest/neutral/base），
    // state.theme='transparent' 是项目自定义的预览背景，不是 mermaid theme——
    // 直接传 'transparent' 会让 mermaid 抛错，进而阻断 initEventListeners。
    // 这里统一兜底：透明背景配 light mermaid 主题（白底更易读）。
    const mermaidTheme = state.theme === 'light' || state.theme === 'transparent'
        ? 'default'
        : 'dark';
    mermaid.initialize({
        startOnLoad: false,
        theme: mermaidTheme,
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
    setTimeout(() => toast.remove(), 4000);
}

function updateStatus(text, type = 'ready') {
    elements.statusText.textContent = text;
    elements.statusText.className = `status-${type}`;
}

// ---- Auth helpers ---------------------------------------------------------

function getToken() {
    return localStorage.getItem('pd_token');
}

function setToken(token) {
    localStorage.setItem('pd_token', token);
}

function clearAuth() {
    localStorage.removeItem('pd_token');
    state.user = null;
    state.sessionId = null;
    if (window.chat) window.chat.clear();
}

/**
 * 统一 fetch 封装：自动带 Bearer token；遇 401 清登录态弹登录遮罩。
 */
async function apiFetch(url, options = {}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
        clearAuth();
        showLoginMask();
        throw new Error('登录已失效，请重新登录');
    }
    return res;
}

function showLoginMask() {
    elements.loginMask.hidden = false;
    elements.userBadge.textContent = '';
}

function hideLoginMask() {
    elements.loginMask.hidden = true;
    elements.loginMessage.textContent = '';
}

function switchLoginTab(tab) {
    const isLogin = tab === 'login';
    elements.loginForm.hidden = !isLogin;
    elements.registerForm.hidden = isLogin;
    elements.loginTabs.forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    elements.loginMessage.textContent = '';
}

// 启动时探活 token：有效则进入应用，无效则弹登录遮罩。
async function checkAuth() {
    const token = getToken();
    if (!token) {
        showLoginMask();
        return;
    }
    try {
        const res = await apiFetch('/api/auth/me');
        if (res.ok) {
            const data = await res.json();
            state.user = data.username;
            hideLoginMask();
            elements.userBadge.textContent = state.user;
            await loadApp();
        } else {
            clearAuth();
            showLoginMask();
        }
    } catch (e) {
        if (!elements.loginMask.hidden) return;
        showLoginMask();
    }
}

async function handleLogin(event) {
    event.preventDefault();
    const username = elements.loginUsername.value.trim();
    const password = elements.loginPassword.value;
    if (!username || !password) {
        elements.loginMessage.textContent = '请输入用户名和密码';
        return;
    }
    try {
        const res = await apiFetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) {
            elements.loginMessage.textContent = data.message || '登录失败';
            return;
        }
        setToken(data.token);
        state.user = data.username;
        if (window.chat) window.chat.clear();
        hideLoginMask();
        elements.userBadge.textContent = state.user;
        elements.loginForm.reset();
        await loadApp();
    } catch (e) {
        elements.loginMessage.textContent = e.message || '登录失败';
    }
}

async function handleRegister(event) {
    event.preventDefault();
    const username = elements.registerUsername.value.trim();
    const password = elements.registerPassword.value;
    if (!username || !password) {
        elements.loginMessage.textContent = '请输入用户名和密码';
        return;
    }
    try {
        const res = await apiFetch('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) {
            elements.loginMessage.textContent = data.message || '注册失败';
            return;
        }
        setToken(data.token);
        state.user = data.username;
        if (window.chat) window.chat.clear();
        hideLoginMask();
        elements.userBadge.textContent = state.user;
        elements.registerForm.reset();
        await loadApp();
    } catch (e) {
        elements.loginMessage.textContent = e.message || '注册失败';
    }
}

async function handleLogout() {
    try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
        // 即使网络失败也强制本地登出
    }
    clearAuth();
    if (window.mermaidRender) window.mermaidRender.clear();
    elements.historyList.innerHTML = '<p class="drawer-empty">暂无历史会话</p>';
    closeDrawer();
    showLoginMask();
    updateStatus('已登出', 'ready');
}

// ---- History drawer -------------------------------------------------------

function toggleDrawer() {
    const open = elements.drawer.classList.toggle('open');
    elements.btnToggleDrawer.classList.toggle('active', open);
}

function closeDrawer() {
    elements.drawer.classList.remove('open');
    elements.btnToggleDrawer.classList.remove('active');
}

async function loadSessions() {
    try {
        const res = await apiFetch('/api/sessions');
        const data = await res.json();
        if (res.ok) {
            renderHistoryList(data.sessions || []);
        }
    } catch (e) {
        console.error('Load sessions failed:', e);
    }
}

function renderHistoryList(sessions) {
    if (!sessions.length) {
        elements.historyList.innerHTML = '<p class="drawer-empty">暂无历史会话</p>';
        return;
    }
    elements.historyList.innerHTML = '';

    // 按 updatedAt 分组：今天 / 昨天 / 更早（纯渲染层，不动后端）
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = startOfToday.getTime() - 86400000;
    const groups = { today: [], yesterday: [], earlier: [] };
    for (const s of sessions) {
        if (s.updatedAt >= startOfToday.getTime()) groups.today.push(s);
        else if (s.updatedAt >= startOfYesterday) groups.yesterday.push(s);
        else groups.earlier.push(s);
    }
    const labels = { today: '今天', yesterday: '昨天', earlier: '更早' };

    for (const key of ['today', 'yesterday', 'earlier']) {
        if (!groups[key].length) continue;
        const header = document.createElement('div');
        header.className = 'drawer-group-title';
        header.textContent = labels[key];
        elements.historyList.appendChild(header);
        for (const s of groups[key]) {
            elements.historyList.appendChild(buildHistoryItem(s));
        }
    }
}

function buildHistoryItem(s) {
    const item = document.createElement('div');
    item.className = 'history-item';
    if (s.sessionId === state.sessionId) {
        item.classList.add('active');
    }
    item.dataset.sessionId = s.sessionId;
    const summary = document.createElement('div');
    summary.className = 'history-summary';
    summary.textContent = s.summary || '（空会话）';
    const time = document.createElement('div');
    time.className = 'history-time';
    time.textContent = formatTime(s.updatedAt);
    item.appendChild(summary);
    item.appendChild(time);
    item.addEventListener('click', () => restoreFromHistory(s.sessionId));
    return item;
}

function formatTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 点击历史会话项：校验存在并用后端净化的 history 重建完整聊天对话 + 渲染最后一张图。
async function restoreFromHistory(sessionId) {
    if (window.chat && window.chat.isStreaming) {
        showToast('生成中，请稍候', 'warning');
        return;
    }
    if (state.sessionId === sessionId) return;
    try {
        const res = await apiFetch('/api/session/check', {
            method: 'POST',
            body: JSON.stringify({ sessionId })
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.message || '恢复失败', 'error');
            return;
        }
        if (data.exists) {
            state.sessionId = data.sessionId;
            if (window.chat) {
                // history 已在后端净化（extract+autoFix）；renderHistory 重建对话并
                // 渲染最后一张图。空 history 时 renderHistory 内部 clear + 显示欢迎态。
                window.chat.renderHistory(data.history || []);
            }
            renderHistoryListActive();
            updateStatus('已恢复会话', 'ready');
            showToast('已恢复会话', 'success');
        } else {
            showToast('未找到该会话，可能已过期', 'warning');
            await loadSessions();
        }
    } catch (e) {
        showToast('恢复会话失败', 'error');
    }
}

function renderHistoryListActive() {
    const items = elements.historyList.querySelectorAll('.history-item');
    items.forEach(item => {
        item.classList.toggle('active', item.dataset.sessionId === state.sessionId);
    });
}

// 开始新会话：清空聊天区，下次生成时 ensureSession 申请新 id。
function startNewSession() {
    if (window.chat && window.chat.isStreaming) {
        showToast('生成中，请稍候', 'warning');
        return;
    }
    state.sessionId = null;
    if (window.chat) window.chat.clear();
    if (window.mermaidRender) window.mermaidRender.clear();
    renderHistoryListActive();
    updateStatus('就绪', 'ready');
    showToast('已开始新会话', 'info');
}

// ---- Session -------------------------------------------------------------

// 首次生成前懒申请会话 id。chat.sendMessage 调用。
async function ensureSession() {
    if (state.sessionId) return;
    const response = await apiFetch('/api/session', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || '会话创建失败');
    }
    state.sessionId = data.sessionId;
}

function reinitMermaid() {
    initMermaid();
    if (window.chat && window.chat.currentMermaid) {
        window.chat.renderMermaid(window.chat.currentMermaid);
    }
}

async function loadConfig() {
    try {
        const response = await apiFetch('/api/config');
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

async function loadApp() {
    updateStatus('就绪', 'ready');
    loadConfig();
    await loadSessions();
}

// Keyboard shortcuts（全局：Ctrl+K 新建会话）
function handleKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        startNewSession();
    }
}

function initEventListeners() {
    elements.loginForm.addEventListener('submit', handleLogin);
    elements.registerForm.addEventListener('submit', handleRegister);
    elements.loginTabs.forEach(tab => {
        tab.addEventListener('click', () => switchLoginTab(tab.dataset.tab));
    });
    elements.btnLogout.addEventListener('click', handleLogout);

    elements.btnToggleDrawer.addEventListener('click', toggleDrawer);
    elements.btnCloseDrawer.addEventListener('click', closeDrawer);
    elements.btnNewSession.addEventListener('click', startNewSession);

    document.addEventListener('keydown', handleKeydown);

    // 点击抽屉外部收起
    document.addEventListener('click', (e) => {
        if (!elements.drawer.classList.contains('open')) return;
        if (elements.drawer.contains(e.target)) return;
        if (elements.btnToggleDrawer.contains(e.target)) return;
        closeDrawer();
    });
}

async function init() {
    // mermaid 初始化与按钮事件绑定解耦：之前 initMermaid 抛错时
    // initEventListeners 不会跑，导致登录/登出/抽屉/Ctrl+K 全部失效。
    // mermaid 失败不应让基础交互失效——把异常隔离在 try 里。
    try {
        initMermaid();
    } catch (e) {
        console.error('Mermaid init failed:', e);
    }
    // 按钮/表单监听必须无条件跑，是应用可用性的兜底
    initEventListeners();
    await checkAuth();
}

document.addEventListener('DOMContentLoaded', init);

window.app = {
    state,
    showToast,
    updateStatus,
    reinitMermaid,
    apiFetch,
    ensureSession,
    loadSessions,
    showLoginMask
};
