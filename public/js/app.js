/**
 * Main Application Logic
 * 负责鉴权、历史抽屉、状态栏、配置加载。聊天与生成逻辑见 chat.js。
 *
 * 登录态：token 存 localStorage('pd_token')，每次请求带 Authorization: Bearer。
 * 会话 id 在内存 state.sessionId，首次生成前由 chat 触发 ensureSession 懒申请。
 */

// State
const state = {
    // 全站唯一主题状态（localStorage['site-theme']，'dark' | 'light'，默认
    // light）：UI 配色（data-theme）、画布背景（components.setTheme）、mermaid
    // 主题（initMermaid）、导出底色（export.js）全部由它派生，无独立开关。
    siteTheme: 'light',
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
    btnLogout: document.getElementById('btn-logout'),
    btnSiteTheme: document.getElementById('btn-site-theme')
};

// Initialize Mermaid
function initMermaid() {
    // mermaid v11 只接受 base 主题名：深色站配 'dark'、浅色站配 'default'，
    // 与画布背景/导出底色同源（state.siteTheme）
    const mermaidTheme = state.siteTheme === 'light' ? 'default' : 'dark';
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

// ---- Site theme 全站深/浅色主题 --------------------------------------------
// 顶栏按钮是全站唯一主题开关：data-theme（UI 配色）+ components.setTheme
// （画布背景，内部再触发 reinitMermaid 用新 mermaid 主题重渲染当前图表）。
// index.html 头部有同步内联脚本在首帧前写入 data-theme 防闪烁（含旧 'theme'
// 键的一次性迁移），这里负责按钮态同步与切换。

const SITE_THEME_KEY = 'site-theme';

function readSiteTheme() {
    // 隐私模式等场景 localStorage 访问可能抛异常：回退默认浅色
    try {
        return localStorage.getItem(SITE_THEME_KEY) === 'dark' ? 'dark' : 'light';
    } catch (e) {
        return 'light';
    }
}

// 运行时真源：applySiteTheme 总是先写 state 再动 DOM，而持久化可能失败
// （隐私模式/配额满，见 toggleSiteTheme 的吞错）。运行期读点（画布背景类、
// 导出底色）必须走这里；readSiteTheme 只服务引导时读存储（init 与迁移场景），
// 否则存储写失败后界面已浅色、导出却仍按存储里的 'dark' 出深底图。
function getSiteTheme() {
    return state.siteTheme;
}

function applySiteTheme(theme) {
    state.siteTheme = theme;
    document.documentElement.dataset.theme = theme;
    // 按钮态同步对缺件降级：按钮或任一图标 SVG 缺失时（异常 DOM / 部分加载），
    // 上面两行已让主题本身生效，直接返回。不守卫的话这里的 TypeError 会顺着
    // init -> initEventListeners -> checkAuth 把登录链路整体炸掉。
    const btn = elements.btnSiteTheme;
    const moon = btn && btn.querySelector('.icon-moon');
    const sun = btn && btn.querySelector('.icon-sun');
    if (!btn || !moon || !sun) return;
    // 图标反映当前态：深色显示月亮、浅色显示太阳；title 提示点击后的去向
    const isDark = theme === 'dark';
    btn.title = isDark ? '切换浅色主题' : '切换深色主题';
    moon.style.display = isDark ? '' : 'none';
    sun.style.display = isDark ? 'none' : '';
}

function toggleSiteTheme() {
    const next = state.siteTheme === 'dark' ? 'light' : 'dark';
    try {
        localStorage.setItem(SITE_THEME_KEY, next);
    } catch (e) {
        // 持久化失败（隐私模式）不阻断：本次会话内切换仍应生效
    }
    applySiteTheme(next);
    // 画布背景跟随，并在主题变化时经 components.setTheme -> reinitMermaid
    // 用新 mermaid 主题重渲染当前图表；导出底色读同一状态（export.js），自然跟随
    if (window.components) {
        window.components.setTheme(next);
    }
}

// ---- Auth helpers ---------------------------------------------------------

function getToken() {
    return localStorage.getItem('pd_token');
}

function setToken(token) {
    localStorage.setItem('pd_token', token);
}

function clearAuth() {
    // 登出前 flush：把当前会话任何待保存的编辑立即 PATCH 到 diagram.json，
    // 避免 token 失效/被清后本地编辑丢失。失败 best-effort 不影响登出流程
    if (window.chat && window.chat._flushPendingDiagramSave) {
        window.chat._flushPendingDiagramSave();
    }
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
    // 切会话前 flush：把当前会话任何待保存的编辑立即 PATCH 到 diagram.json，
    // 再切 state.sessionId，否则新会话的 input 事件会被旧 sessionId 污染。
    // 失败 best-effort（失败场景：下一轮 generate 会覆盖 diagram.json，审计轨迹不受影响）
    if (window.chat && window.chat._flushPendingDiagramSave) {
        window.chat._flushPendingDiagramSave();
    }
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
                // history 已在后端净化（extract+autoFix）；lastMermaid 是 diagram.json
                // 优先派生的"当前图"（含用户编辑），必须传给 renderHistory，否则用户的
                // 编辑在恢复时会被 history 里的 LLM 原文覆盖
                window.chat.renderHistory(data.history || [], data.lastMermaid);
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
    // flush：保留当前会话任何未落盘的编辑
    if (window.chat && window.chat._flushPendingDiagramSave) {
        window.chat._flushPendingDiagramSave();
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
    // 流式生成中 currentMermaid 停留在上一轮完整图：此时重渲染会用旧图
    // 非静默顶掉预览区正在流式更新的半成品。只重设主题不渲染--后续 600ms
    // 节流的 silent 渲染与流完成后的 finalize 渲染自然以新主题落地。
    if (window.chat && window.chat.isStreaming) return;
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
    // 缺件守卫：与 applySiteTheme 的承诺一致，否则 HTML/JS 版本错配时这里的
    // TypeError 会炸掉 initEventListeners，登录遮罩永不出现
    if (elements.btnSiteTheme) {
        elements.btnSiteTheme.addEventListener('click', toggleSiteTheme);
    }

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
    // 全站主题：内联脚本已设过 data-theme，这里同步按钮图标态并纳入 state
    applySiteTheme(readSiteTheme());
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
    readSiteTheme,
    getSiteTheme,
    apiFetch,
    ensureSession,
    loadSessions,
    showLoginMask
};
