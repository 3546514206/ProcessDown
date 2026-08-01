/**
 * Main Application Logic
 * Handles user auth, API calls, history drawer, and state management.
 *
 * 登录态：token 存 localStorage('pd_token')，每次请求带 Authorization: Bearer。
 * 会话 id 仍在内存（state.sessionId），浏览器刷新后通过左侧抽屉从历史恢复。
 */

// State
const state = {
    mermaidCode: '',
    history: [],
    theme: localStorage.getItem('theme') || 'dark',
    zoom: 1,
    isGenerating: false,
    user: null,
    // In-memory only: 标识当前正在编辑的会话。null 表示尚未创建，首次生成时懒申请。
    sessionId: null
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
    // 登录态失效/登出时清空输入框，避免跨用户残留——这是会话切换与用户/token 切换两条入口的共同汇聚点
    elements.inputPrompt.value = '';
}

/**
 * 统一的 fetch 封装：自动带 Bearer token；遇 401 清登录态并弹登录遮罩。
 * 用 401 作为“登录失效”的唯一信号，避免每个调用点重复处理。
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
        // apiFetch 已对 401 弹了遮罩；网络错误也退回登录遮罩
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
        // 注册成功即签发 token，省去再登录一步
        setToken(data.token);
        state.user = data.username;
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
        // 即使网络失败也强制本地登出，避免卡在失效 token 上
    }
    clearAuth();
    state.mermaidCode = '';
    state.history = [];
    state.sessionId = null;
    elements.inputPrompt.value = '';
    elements.codeEditor.value = '';
    if (window.mermaidRender) {
        window.mermaidRender.clear();
    }
    elements.historyList.innerHTML = '<p class="drawer-empty">暂无历史会话</p>';
    closeDrawer();
    showLoginMask();
    updateStatus('已登出', 'ready');
    updateCodeStatus('就绪', 'ready');
}

// ---- History drawer -------------------------------------------------------

function toggleDrawer() {
    const open = elements.drawer.classList.toggle('open');
    elements.btnToggleDrawer.classList.toggle('active', open);
}

// 收起抽屉：显式移除 open（而非 toggle），避免在已收起时误触发打开
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
        // 加载失败不阻断主功能，仅提示
        console.error('Load sessions failed:', e);
    }
}

function renderHistoryList(sessions) {
    if (!sessions.length) {
        elements.historyList.innerHTML = '<p class="drawer-empty">暂无历史会话</p>';
        return;
    }
    elements.historyList.innerHTML = '';
    for (const s of sessions) {
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
        elements.historyList.appendChild(item);
    }
}

function formatTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 点击历史会话项：校验存在并恢复上一张图与当前 sessionId。
async function restoreFromHistory(sessionId) {
    if (state.isGenerating) {
        showToast('生成中，请稍候', 'warning');
        return;
    }
    // 重复点 active 项不算切换会话：不动输入框/画布，避免覆盖用户当前会话的未提交内容
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
            // 切换会话一律清空输入框：上一会话的 prompt 不属于当前会话，不应跨会话残留
            elements.inputPrompt.value = '';
            if (data.lastMermaid) {
                state.mermaidCode = data.lastMermaid;
                elements.codeEditor.value = data.lastMermaid;
                if (window.mermaidRender) {
                    window.mermaidRender.render(data.lastMermaid);
                }
            } else {
                // 会话存在但无图：清空画布，准备继续对话
                state.mermaidCode = '';
                elements.codeEditor.value = '';
                if (window.mermaidRender) {
                    window.mermaidRender.clear();
                }
            }
            renderHistoryListActive();
            updateStatus('已恢复会话', 'ready');
            updateCodeStatus('已恢复', 'ready');
            showToast('已恢复会话', 'success');
        } else {
            showToast('未找到该会话，可能已过期', 'warning');
            await loadSessions();
        }
    } catch (e) {
        showToast('恢复会话失败', 'error');
    }
}

// 仅刷新列表中的 active 高亮，不重新请求
function renderHistoryListActive() {
    const items = elements.historyList.querySelectorAll('.history-item');
    items.forEach(item => {
        item.classList.toggle('active', item.dataset.sessionId === state.sessionId);
    });
}

// 开始新会话：清空当前编辑/预览，下次生成时 ensureSession 申请新 id。
function startNewSession() {
    if (state.isGenerating) {
        showToast('生成中，请稍候', 'warning');
        return;
    }
    state.sessionId = null;
    state.mermaidCode = '';
    state.history = [];
    elements.inputPrompt.value = '';
    elements.codeEditor.value = '';
    if (window.mermaidRender) {
        window.mermaidRender.clear();
    }
    renderHistoryListActive();
    updateStatus('就绪', 'ready');
    updateCodeStatus('就绪', 'ready');
    showToast('已开始新会话', 'info');
}

// ---- Session & generation -------------------------------------------------

// Lazily create a session before the first generation. state.isGenerating
// already blocks concurrent clicks, so this cannot race.
async function ensureSession() {
    if (state.sessionId) return;

    const response = await apiFetch('/api/session', {
        method: 'POST'
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || '会话创建失败');
    }
    state.sessionId = data.sessionId;
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
    elements.btnGenerate.querySelector('.btn-text').style.display = 'none';
    elements.btnGenerate.querySelector('.btn-loading').style.display = 'inline';

    updateStatus('生成中...', 'loading');
    updateCodeStatus('生成中...', 'loading');

    let responseData = null;

    try {
        await ensureSession();

        const response = await apiFetch('/api/generate', {
            method: 'POST',
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

        // 生成后刷新抽屉：新会话/新轮次应出现在历史列表顶部
        loadSessions();

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

// 登录后加载应用：配置 + 历史会话
async function loadApp() {
    updateStatus('就绪', 'ready');
    updateCodeStatus('就绪', 'ready');
    loadConfig();
    await loadSessions();
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

    // 登录/注册
    elements.loginForm.addEventListener('submit', handleLogin);
    elements.registerForm.addEventListener('submit', handleRegister);
    elements.loginTabs.forEach(tab => {
        tab.addEventListener('click', () => switchLoginTab(tab.dataset.tab));
    });
    elements.btnLogout.addEventListener('click', handleLogout);

    // 历史抽屉
    elements.btnToggleDrawer.addEventListener('click', toggleDrawer);
    elements.btnCloseDrawer.addEventListener('click', closeDrawer);
    elements.btnNewSession.addEventListener('click', startNewSession);

    // 点击抽屉外部（主页面区域）自动收起：抽屉打开时，点击不在抽屉内、
    // 也不在切换按钮上（切换按钮的点击交给 toggleDrawer 处理，避免开即关）。
    document.addEventListener('click', (e) => {
        if (!elements.drawer.classList.contains('open')) return;
        if (elements.drawer.contains(e.target)) return;
        if (elements.btnToggleDrawer.contains(e.target)) return;
        closeDrawer();
    });
}

// Initialize app
async function init() {
    initMermaid();
    initEventListeners();
    // 先尝试恢复登录态；checkAuth 内部决定是进入应用还是弹登录遮罩
    await checkAuth();
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
    reinitMermaid,
    apiFetch
};
