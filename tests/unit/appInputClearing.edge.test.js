'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '../../public/js/app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const exposedSource = `${appSource}\n;globalThis.__appTest = {
    restoreFromHistory,
    handleLogin,
    handleLogout,
    handleRegister,
    clearAuth,
    startNewSession,
    apiFetch,
    state,
    elements
};`;

function createClassList() {
    const values = new Set();
    return {
        add(...names) {
            names.forEach(name => values.add(name));
        },
        remove(...names) {
            names.forEach(name => values.delete(name));
        },
        toggle(name, force) {
            if (force === true) {
                values.add(name);
                return true;
            }
            if (force === false) {
                values.delete(name);
                return false;
            }
            if (values.has(name)) {
                values.delete(name);
                return false;
            }
            values.add(name);
            return true;
        },
        contains(name) {
            return values.has(name);
        }
    };
}

function createElement(id = '') {
    const children = [];
    const listeners = new Map();
    const element = {
        id,
        value: '',
        hidden: false,
        textContent: '',
        innerHTML: '',
        className: '',
        dataset: {},
        style: {},
        disabled: false,
        children,
        classList: createClassList(),
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        querySelector(selector) {
            return createElement(`${id}:${selector}`);
        },
        querySelectorAll() {
            return [];
        },
        appendChild(child) {
            children.push(child);
            child.parentNode = element;
            return child;
        },
        contains(target) {
            return target === element || children.includes(target);
        },
        reset() {
            element.resetCalled = true;
        },
        remove() {
            element.removed = true;
            if (element.parentNode) {
                const index = element.parentNode.children.indexOf(element);
                if (index >= 0) element.parentNode.children.splice(index, 1);
            }
        },
        _listeners: listeners
    };
    return element;
}

function jsonResponse(status, data) {
    return {
        status,
        ok: status >= 200 && status < 300,
        async json() {
            return data;
        }
    };
}

function createHarness(fetchImpl) {
    const ids = [
        'input-prompt', 'code-editor', 'btn-generate', 'btn-clear', 'btn-copy',
        'status-text', 'code-status', 'toast-container', 'api-config', 'login-mask',
        'login-form', 'register-form', 'login-username', 'login-password',
        'register-username', 'register-password', 'login-message', 'history-drawer',
        'btn-toggle-drawer', 'btn-new-session', 'btn-close-drawer', 'history-list',
        'user-badge', 'btn-logout'
    ];
    const dom = new Map(ids.map(id => [id, createElement(id)]));
    const loginTabs = [createElement('login-tab-login'), createElement('login-tab-register')];
    loginTabs[0].dataset.tab = 'login';
    loginTabs[1].dataset.tab = 'register';

    const documentListeners = new Map();
    const document = {
        getElementById(id) {
            if (!dom.has(id)) dom.set(id, createElement(id));
            return dom.get(id);
        },
        querySelector() {
            return null;
        },
        querySelectorAll(selector) {
            return selector === '.login-tab' ? loginTabs : [];
        },
        createElement(tagName) {
            return createElement(tagName);
        },
        addEventListener(type, handler) {
            documentListeners.set(type, handler);
        }
    };

    const storage = new Map();
    const localStorage = {
        getItem(key) {
            return storage.has(key) ? storage.get(key) : null;
        },
        setItem(key, value) {
            storage.set(key, String(value));
        },
        removeItem(key) {
            storage.delete(key);
        }
    };

    const fetchCalls = [];
    const fetch = async (url, options = {}) => {
        fetchCalls.push({ url, options });
        if (!fetchImpl) throw new Error(`Unexpected fetch: ${url}`);
        return fetchImpl(url, options, fetchCalls.length - 1);
    };

    const renderCalls = [];
    let clearCalls = 0;
    const window = {
        mermaidRender: {
            render(code) {
                renderCalls.push(code);
            },
            clear() {
                clearCalls += 1;
            }
        }
    };

    let timerId = 0;
    const context = {
        window,
        document,
        localStorage,
        fetch,
        mermaid: { initialize() {} },
        setTimeout() {
            timerId += 1;
            return timerId;
        },
        clearTimeout() {},
        console: { log() {}, error() {}, warn() {} },
        navigator: { clipboard: { async writeText() {} } }
    };

    vm.runInNewContext(exposedSource, context, { filename: appPath });

    return {
        ...context.__appTest,
        localStorage,
        storage,
        fetchCalls,
        renderCalls,
        get clearCalls() {
            return clearCalls;
        },
        jsonResponse
    };
}

function lastToast(harness) {
    const toasts = harness.elements.toastContainer.children;
    return toasts[toasts.length - 1];
}

function submitEvent() {
    return { preventDefault() {} };
}

describe('app input clearing boundaries', () => {
    it('clears prompt before the same-session restore early return', async () => {
        const harness = createHarness();
        harness.state.sessionId = 'A';
        harness.elements.inputPrompt.value = '未提交内容';

        await harness.restoreFromHistory('A');

        assert.equal(harness.elements.inputPrompt.value, '');
        assert.equal(harness.fetchCalls.length, 0);
        assert.equal(harness.state.sessionId, 'A');
    });

    it('clears prompt and restores code when switching to an existing session', async () => {
        const mermaid = 'flowchart TD\n A-->B';
        const harness = createHarness(async () => jsonResponse(200, {
            exists: true,
            sessionId: 'B',
            lastMermaid: mermaid
        }));
        harness.state.sessionId = 'A';
        harness.elements.inputPrompt.value = '未提交内容';

        await harness.restoreFromHistory('B');

        assert.equal(harness.elements.inputPrompt.value, '');
        assert.equal(harness.state.sessionId, 'B');
        assert.equal(harness.elements.codeEditor.value, mermaid);
        assert.deepEqual(harness.renderCalls, [mermaid]);
    });

    it('clears prompt and reloads sessions when the target does not exist', async () => {
        const harness = createHarness(async (url) => {
            if (url === '/api/session/check') {
                return jsonResponse(200, { exists: false, sessionId: 'B', lastMermaid: null });
            }
            if (url === '/api/sessions') {
                return jsonResponse(200, { sessions: [] });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        harness.state.sessionId = 'A';
        harness.elements.inputPrompt.value = '未提交内容';

        await harness.restoreFromHistory('B');

        assert.equal(harness.elements.inputPrompt.value, '');
        assert.equal(harness.state.sessionId, 'A');
        assert.deepEqual(harness.fetchCalls.map(call => call.url), [
            '/api/session/check',
            '/api/sessions'
        ]);
        assert.match(lastToast(harness).textContent, /未找到该会话/);
    });

    it('clears prompt and shows an error toast on an HTTP error', async () => {
        const harness = createHarness(async () => jsonResponse(500, { message: '服务错误' }));
        harness.state.sessionId = 'A';
        harness.elements.inputPrompt.value = '未提交内容';

        await harness.restoreFromHistory('B');

        assert.equal(harness.elements.inputPrompt.value, '');
        assert.equal(harness.state.sessionId, 'A');
        assert.equal(lastToast(harness).textContent, '服务错误');
        assert.match(lastToast(harness).className, /error/);
    });

    it('clears prompt and shows an error toast on a network rejection', async () => {
        const harness = createHarness(async () => {
            throw new Error('network down');
        });
        harness.state.sessionId = 'A';
        harness.elements.inputPrompt.value = '未提交内容';

        await harness.restoreFromHistory('B');

        assert.equal(harness.elements.inputPrompt.value, '');
        assert.equal(harness.state.sessionId, 'A');
        assert.equal(lastToast(harness).textContent, '恢复会话失败');
        assert.match(lastToast(harness).className, /error/);
    });

    it('preserves prompt and avoids fetch while generation is in progress', async () => {
        const harness = createHarness();
        harness.state.isGenerating = true;
        harness.state.sessionId = 'A';
        harness.elements.inputPrompt.value = '正在编辑';

        await harness.restoreFromHistory('B');

        assert.equal(harness.elements.inputPrompt.value, '正在编辑');
        assert.equal(harness.fetchCalls.length, 0);
        assert.match(lastToast(harness).textContent, /生成中/);
    });

    it('clears a stale prompt after successful login and loads the app', async () => {
        const harness = createHarness(async (url) => {
            if (url === '/api/auth/login') {
                return jsonResponse(200, { token: 'new-token', username: 'alice' });
            }
            if (url === '/api/config') {
                return jsonResponse(200, { llm: { model: 'test-model' } });
            }
            if (url === '/api/sessions') {
                return jsonResponse(200, { sessions: [] });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        harness.storage.set('pd_token', 'old-token');
        harness.elements.inputPrompt.value = '上一用户内容';
        harness.elements.loginUsername.value = 'alice';
        harness.elements.loginPassword.value = 'secret';

        await harness.handleLogin(submitEvent());

        assert.equal(harness.elements.inputPrompt.value, '');
        assert.equal(harness.storage.get('pd_token'), 'new-token');
        assert.equal(harness.state.user, 'alice');
        assert.equal(harness.elements.loginMask.hidden, true);
        assert.deepEqual(harness.fetchCalls.map(call => call.url), [
            '/api/auth/login',
            '/api/config',
            '/api/sessions'
        ]);
    });

    it('preserves the current draft when login returns 401', async () => {
        const harness = createHarness(async () => jsonResponse(401, {
            message: '用户名或密码错误'
        }));
        harness.elements.inputPrompt.value = '当前草稿';
        harness.elements.loginUsername.value = 'alice';
        harness.elements.loginPassword.value = 'wrong';

        await harness.handleLogin(submitEvent());

        assert.equal(harness.elements.inputPrompt.value, '当前草稿');
        assert.ok(harness.elements.loginMessage.textContent);
    });

    it('clearAuth clears prompt and login state when apiFetch receives 401', async () => {
        const harness = createHarness(async () => jsonResponse(401, {}));
        harness.storage.set('pd_token', 'expired-token');
        harness.state.user = 'alice';
        harness.state.sessionId = 'A';
        harness.elements.inputPrompt.value = '敏感内容';
        harness.elements.loginMask.hidden = true;

        await assert.rejects(
            harness.apiFetch('/api/protected'),
            /登录已失效，请重新登录/
        );

        assert.equal(harness.elements.inputPrompt.value, '');
        assert.equal(harness.storage.has('pd_token'), false);
        assert.equal(harness.state.user, null);
        assert.equal(harness.state.sessionId, null);
        assert.equal(harness.elements.loginMask.hidden, false);
    });

    it('clears prompt and local auth even when logout rejects', async () => {
        const harness = createHarness(async () => {
            throw new Error('network down');
        });
        harness.storage.set('pd_token', 'token');
        harness.state.user = 'alice';
        harness.state.sessionId = 'A';
        harness.elements.inputPrompt.value = '未提交内容';
        harness.elements.loginMask.hidden = true;

        await harness.handleLogout();

        assert.equal(harness.elements.inputPrompt.value, '');
        assert.equal(harness.storage.has('pd_token'), false);
        assert.equal(harness.state.user, null);
        assert.equal(harness.state.sessionId, null);
        assert.equal(harness.elements.loginMask.hidden, false);
    });

    it('startNewSession clears the prompt and resets the session', () => {
        const harness = createHarness();
        harness.state.sessionId = 'A';
        harness.state.mermaidCode = 'flowchart TD\n A-->B';
        harness.state.history = [{ role: 'user', content: 'old' }];
        harness.elements.inputPrompt.value = '未提交内容';
        harness.elements.codeEditor.value = harness.state.mermaidCode;

        harness.startNewSession();

        assert.equal(harness.elements.inputPrompt.value, '');
        assert.equal(harness.elements.codeEditor.value, '');
        assert.equal(harness.state.sessionId, null);
        assert.equal(harness.state.mermaidCode, '');
        assert.equal(harness.state.history.length, 0);
    });

    it('startNewSession preserves prompt while generation is in progress', () => {
        const harness = createHarness();
        harness.state.isGenerating = true;
        harness.state.sessionId = 'A';
        harness.elements.inputPrompt.value = '正在编辑';

        harness.startNewSession();

        assert.equal(harness.elements.inputPrompt.value, '正在编辑');
        assert.equal(harness.state.sessionId, 'A');
        assert.match(lastToast(harness).textContent, /生成中/);
    });
});
