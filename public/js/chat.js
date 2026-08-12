/**
 * Chat Module
 * 聊天对话区逻辑：消息渲染、输入框、发送/停止、预览/代码 Tab、滚动、欢迎态。
 *
 * 流式 seam：streamGenerate() 在 Round 3 用 mock 模拟流式，Round 4 替换为真实
 * /api/generate/stream 的 fetch + ReadableStream。UI 层（caret/append/scroll/
 * 节流渲染）与数据源解耦，mock 验证布局后无缝切换。
 *
 * 挂在 window.chat，供 app.js 在登录后 init。
 */

const chat = {
    messages: [],          // [{role:'user'|'assistant', content, thinking?}]
    isStreaming: false,
    currentMermaid: '',    // 最新一张图的 mermaid（供预览/导出）
    el: {},
    _abortController: null,
    _renderTimer: null,
    _thinkStartTime: 0,

    init() {
        this.el = {
            messages: document.getElementById('chat-messages'),
            welcome: document.getElementById('welcome-state'),
            textarea: document.getElementById('chat-textarea'),
            send: document.getElementById('chat-send'),
            scrollBtn: document.getElementById('scroll-bottom-btn'),
            status: document.getElementById('status-text')
        };

        this.bindInput();
        this.bindScroll();
        this.bindExampleChips();
        this.showWelcome();
    },

    // ---- 输入框 ----
    bindInput() {
        // 自适应高度：1 行起，最高 160px 后内部滚动
        this.el.textarea.addEventListener('input', () => {
            this.el.textarea.style.height = 'auto';
            this.el.textarea.style.height = Math.min(this.el.textarea.scrollHeight, 160) + 'px';
        });
        // Enter 发送 / Shift+Enter 换行 / Ctrl+Enter 也发送
        this.el.textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                // Enter 或 Ctrl+Enter 都发送（Shift+Enter 换行放行）
                e.preventDefault();
                this.sendMessage();
            }
        });
        this.el.send.addEventListener('click', () => {
            if (this.isStreaming) this.stopGenerate();
            else this.sendMessage();
        });
    },

    // ---- 滚动 ----
    bindScroll() {
        this.el.messages.addEventListener('scroll', () => this.toggleScrollBtn());
        this.el.scrollBtn.addEventListener('click', () => {
            this.el.messages.scrollTop = this.el.messages.scrollHeight;
            this.el.scrollBtn.hidden = true;
        });
    },

    isNearBottom() {
        const m = this.el.messages;
        return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
    },

    autoScroll() {
        if (this.isNearBottom()) {
            this.el.messages.scrollTop = this.el.messages.scrollHeight;
        }
    },

    toggleScrollBtn() {
        this.el.scrollBtn.hidden = this.isNearBottom();
    },

    // ---- 欢迎态 ----
    showWelcome() {
        this.el.welcome.hidden = false;
    },

    hideWelcome() {
        this.el.welcome.hidden = true;
    },

    // ---- 示例 chip ----
    bindExampleChips() {
        document.querySelectorAll('.example-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                this.el.textarea.value = chip.dataset.prompt;
                this.el.textarea.focus();
                this.el.textarea.dispatchEvent(new Event('input'));
            });
        });
    },

    // ---- 消息渲染 ----
    appendUserMessage(text) {
        this.hideWelcome();
        const div = document.createElement('div');
        div.className = 'message message-user';
        div.textContent = text;
        this.el.messages.appendChild(div);
        this.messages.push({ role: 'user', content: text });
        this.autoScroll();
    },

    /**
     * 追加一条 AI 消息骨架，返回各部位引用供流式更新。
     * 结构：think-block(可选) + code-details(<details>) + action-row + stream-caret
     */
    appendAiMessage() {
        this.hideWelcome();
        const root = document.createElement('div');
        root.className = 'message message-ai';

        // 思考块（默认隐藏，有 thinking 内容时显示）
        const thinkBlock = document.createElement('div');
        thinkBlock.className = 'think-block streaming';
        thinkBlock.hidden = true;
        const thinkHeader = document.createElement('div');
        thinkHeader.className = 'think-header';
        thinkHeader.innerHTML = '<svg class="think-chevron" viewBox="0 0 24 24" width="12" height="12"><path d="M7 10l5 5 5-5z"/></svg><span class="think-label">思考过程</span>';
        const thinkContent = document.createElement('div');
        thinkContent.className = 'think-content';
        thinkBlock.appendChild(thinkHeader);
        thinkBlock.appendChild(thinkContent);
        // 点击 header 折叠/展开
        thinkHeader.addEventListener('click', () => thinkBlock.classList.toggle('collapsed'));

        // 代码块（<details> 默认折叠，零 JS 展开）
        const details = document.createElement('details');
        details.className = 'code-details';
        const summary = document.createElement('summary');
        summary.innerHTML = '<svg class="think-chevron" viewBox="0 0 24 24" width="12" height="12"><path d="M7 10l5 5 5-5z"/></svg><span>Mermaid 代码</span>';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'code-copy-btn';
        copyBtn.textContent = '复制';
        copyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.copyText(this.currentMermaid);
        });
        summary.appendChild(copyBtn);
        const codePre = document.createElement('pre');
        codePre.className = 'code-pre';
        details.appendChild(summary);
        details.appendChild(codePre);

        // 操作行（流式结束后显示）
        const actionRow = document.createElement('div');
        actionRow.className = 'action-row';
        actionRow.style.display = 'none';

        // 查看此图：把该轮 mermaid 渲染到预览区（历史消息切换）
        const viewBtn = document.createElement('button');
        viewBtn.className = 'action-btn';
        viewBtn.textContent = '查看此图';
        viewBtn.addEventListener('click', () => {
            if (root._mermaid) {
                this.currentMermaid = root._mermaid;
                this.renderMermaid(root._mermaid);
            }
        });
        actionRow.appendChild(viewBtn);

        const copyCodeBtn = document.createElement('button');
        copyCodeBtn.className = 'action-btn';
        copyCodeBtn.textContent = '复制代码';
        copyCodeBtn.addEventListener('click', () => this.copyText(root._mermaid || ''));
        actionRow.appendChild(copyCodeBtn);

        const regenBtn = document.createElement('button');
        regenBtn.className = 'action-btn';
        regenBtn.textContent = '重新生成';
        regenBtn.addEventListener('click', () => {
            // 用上一条 user 指令重新生成
            const lastUser = [...this.messages].reverse().find(m => m.role === 'user');
            if (lastUser) {
                this.el.textarea.value = lastUser.content;
                this.sendMessage();
            }
        });
        actionRow.appendChild(regenBtn);

        // 流式光标
        const caret = document.createElement('span');
        caret.className = 'stream-caret';

        root.appendChild(thinkBlock);
        root.appendChild(details);
        root.appendChild(actionRow);
        root.appendChild(caret);
        this.el.messages.appendChild(root);
        this.autoScroll();
        return { root, thinkBlock, thinkContent, thinkLabel: thinkHeader.querySelector('.think-label'), codePre, actionRow, caret };
    },

    // ---- 发送 ----
    async sendMessage() {
        if (this.isStreaming) return; // isStreaming 守卫防重复
        const prompt = this.el.textarea.value.trim();
        if (!prompt) return;

        this.appendUserMessage(prompt);
        this.el.textarea.value = '';
        this.el.textarea.style.height = 'auto';
        this.setStreaming(true);
        if (window.app) window.app.updateStatus('生成中...', 'loading');

        const aiRefs = this.appendAiMessage();
        this._thinkStartTime = Date.now();

        // 首次生成前懒申请会话 id
        try {
            if (window.app && window.app.ensureSession) await window.app.ensureSession();
        } catch (e) {
            this.setStreaming(false);
            if (window.app) window.app.showToast('会话创建失败: ' + e.message, 'error');
            return;
        }

        const sessionId = window.app && window.app.state ? window.app.state.sessionId : null;
        this.streamGenerate({
            prompt,
            sessionId,
            currentMermaid: this.currentMermaid,
            onThinking: (delta) => {
                aiRefs.thinkBlock.hidden = false;
                aiRefs.thinkContent.textContent += delta;
                this.autoScroll();
            },
            onContent: (delta) => {
                aiRefs.codePre.textContent += delta;
                this.scheduleRender(aiRefs.codePre.textContent);
                this.autoScroll();
            },
            onDone: ({ mermaid, fixes, extracted }) => {
                this.finalizeAiMessage(aiRefs, mermaid, fixes);
                if (extracted === false && window.app) {
                    window.app.showToast('未能识别为 Mermaid 代码，请检查或重新生成', 'warning');
                }
                if (window.app && window.app.loadSessions) window.app.loadSessions();
            },
            onError: (msg, hint) => {
                this._clearRenderTimer();
                aiRefs.caret.remove();
                aiRefs.actionRow.style.display = 'none';
                aiRefs.root.querySelector('.code-details').style.display = 'none';
                const err = document.createElement('div');
                err.className = 'render-error';
                err.textContent = (hint ? msg + '。' + hint : msg);
                aiRefs.root.appendChild(err);
                if (window.app) window.app.showToast((hint ? msg + '。' + hint : msg), 'error');
                this.setStreaming(false);
                if (window.app) window.app.updateStatus('生成失败', 'error');
            },
            onAbort: () => {
                // 停止生成：移除光标，保留已生成的部分代码，复位状态
                this._clearRenderTimer();
                aiRefs.caret.remove();
                if (!aiRefs.thinkBlock.hidden) {
                    aiRefs.thinkBlock.classList.add('collapsed');
                    aiRefs.thinkBlock.classList.remove('streaming');
                }
                aiRefs.actionRow.style.display = 'flex';
                this.setStreaming(false);
                if (window.app) window.app.updateStatus('已停止', 'ready');
            }
        });
    },

    stopGenerate() {
        if (this._abortController) this._abortController.abort();
    },

    setStreaming(on) {
        this.isStreaming = on;
        const send = this.el.send;
        send.classList.toggle('streaming', on);
        send.querySelector('.icon-send').style.display = on ? 'none' : 'inline';
        send.querySelector('.icon-stop').style.display = on ? 'inline' : 'none';
        send.title = on ? '停止生成' : '发送 (Enter / Ctrl+Enter)';
    },

    finalizeAiMessage(aiRefs, mermaid, fixes) {
        aiRefs.caret.remove();
        aiRefs.actionRow.style.display = 'flex';
        aiRefs.root._mermaid = mermaid || '';
        // 思考块：流式结束后自动折叠 + 标注用时
        if (!aiRefs.thinkBlock.hidden) {
            aiRefs.thinkBlock.classList.add('collapsed');
            aiRefs.thinkBlock.classList.remove('streaming');
            const secs = Math.max(1, Math.round((Date.now() - this._thinkStartTime) / 1000));
            aiRefs.thinkLabel.textContent = `思考过程 · 已思考 ${secs}s`;
        }
        // 最终代码：用净化后 mermaid 覆盖流式累积的原始文本
        if (mermaid) {
            aiRefs.codePre.textContent = mermaid;
            this.currentMermaid = mermaid;
            this.renderMermaid(mermaid);
        }
        this.messages.push({ role: 'assistant', content: mermaid || '' });
        this.setStreaming(false);
        if (window.app) window.app.updateStatus('生成成功', 'ready');
    },

    // ---- mermaid 渲染（节流）----
    _clearRenderTimer() {
        if (this._renderTimer) {
            clearTimeout(this._renderTimer);
            this._renderTimer = null;
        }
    },

    scheduleRender(code) {
        // 每次更新为最新累积文本：定时器触发时渲染的是最新代码，而非调度时刻的陈旧快照
        this._pendingCode = code;
        if (this._renderTimer) return;
        this._renderTimer = setTimeout(() => {
            this._renderTimer = null;
            if (window.mermaidRender) window.mermaidRender.render(this._pendingCode, { silent: true });
        }, 600);
    },

    renderMermaid(code) {
        this._clearRenderTimer();
        if (window.mermaidRender) window.mermaidRender.render(code);
    },

    copyText(text) {
        navigator.clipboard.writeText(text).then(
            () => window.app && window.app.showToast('已复制', 'success'),
            () => window.app && window.app.showToast('复制失败', 'error')
        );
    },

    // ---- 清空（新会话/登出/会话切换）----
    clear() {
        this._clearRenderTimer();
        this.messages = [];
        this.currentMermaid = '';
        // 清空输入框，杜绝跨会话/跨用户的草稿残留（旧 app.js 的 inputPrompt 清空守卫等价）
        if (this.el.textarea) {
            this.el.textarea.value = '';
            this.el.textarea.style.height = 'auto';
        }
        // 保留 welcome 与 scrollBtn，移除所有 .message
        this.el.messages.querySelectorAll('.message').forEach(m => m.remove());
        if (window.mermaidRender) window.mermaidRender.clear();
        this.showWelcome();
    },

    // ---- 历史恢复 ----
    // 用完整历史重建聊天对话。每轮 AI 消息展示代码块（默认折叠），仅最后一轮的
    // mermaid 渲染到预览区，避免对每轮都跑 mermaid.render 造成卡顿。
    renderHistory(history) {
        this.clear();
        if (!history || !history.length) {
            this.showWelcome();
            return;
        }
        let lastAssistantIdx = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'assistant') { lastAssistantIdx = i; break; }
        }
        for (let i = 0; i < history.length; i++) {
            const m = history[i];
            if (m.role === 'user') {
                this.appendUserMessage(m.content);
            } else if (m.role === 'assistant') {
                const ai = this.appendAiMessage();
                ai.caret.remove();
                ai.actionRow.style.display = 'flex';
                ai.root._mermaid = m.content || '';
                ai.codePre.textContent = m.content || '';
                this.messages.push({ role: 'assistant', content: m.content || '' });
                if (i === lastAssistantIdx && m.content) {
                    this.currentMermaid = m.content;
                    this.renderMermaid(m.content);
                }
            }
        }
        this.hideWelcome();
        this.autoScroll();
    },

    /**
     * 流式生成：fetch /api/generate/stream + ReadableStream 解析 SSE。
     * 因需带 Bearer，不能用 EventSource，用 fetch + reader 手动解析。
     * 回调：onThinking(delta)/onContent(delta)/onDone({mermaid,fixes})/onError(msg,hint)/onAbort()。
     * 停止生成：外部调 stopGenerate() -> AbortController.abort() -> reader 抛出 -> onAbort。
     */
    async streamGenerate({ prompt, sessionId, currentMermaid, onThinking, onContent, onDone, onError, onAbort }) {
        this._abortController = new AbortController();
        const token = localStorage.getItem('pd_token');

        let res;
        try {
            res = await fetch('/api/generate/stream', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                body: JSON.stringify({
                    prompt,
                    mermaid: currentMermaid || undefined,
                    sessionId: sessionId || undefined
                }),
                signal: this._abortController.signal
            });
        } catch (e) {
            this._abortController = null;
            if (e.name === 'AbortError') { onAbort && onAbort(); return; }
            onError && onError('网络错误: ' + e.message, '');
            return;
        }

        // 401：登录失效。此处刻意不调 clearAuth()/chat.clear()（与 apiFetch 不同）：
        // 流式期间 token 过期时保留已生成的聊天 DOM，历史已落盘可恢复；仅清登录态弹遮罩。
        if (res.status === 401) {
            this._abortController = null;
            localStorage.removeItem('pd_token');
            if (window.app) {
                window.app.state.user = null;
                window.app.state.sessionId = null;
                window.app.showLoginMask && window.app.showLoginMask();
            }
            onError && onError('登录已失效，请重新登录', '');
            return;
        }

        // 非 2xx 非 SSE：校验错误等返回 JSON
        if (!res.ok) {
            this._abortController = null;
            try {
                const data = await res.json();
                onError && onError(data.message || `请求失败 (${res.status})`, '');
            } catch (e) {
                onError && onError(`请求失败 (${res.status})`, '');
            }
            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let aborted = false;
        let finalized = false;
        // 捕获当前 controller 引用：finally 仅当仍是同一个时才置 null，
        // 避免清掉新流（理论上慢代理分段下可能存在的竞态）覆盖的 controller
        const controller = this._abortController;

        // finish 包装终态回调，确保 done/error/abort 互斥且 finalized 置位。
        // 幂等守卫：终态事件后连接再断开（reader 抛错）不会二次触发回调。
        const finish = (fn) => { if (finalized) return; finalized = true; if (fn) fn(); };

        const handleEvent = (raw) => {
            // 一个 SSE 事件块可能含多行，合并所有 data: 行
            let dataStr = '';
            for (const line of raw.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data:')) dataStr += trimmed.slice(5).trim();
            }
            if (!dataStr) return;
            if (dataStr === '[DONE]') return; // 流结束标记
            try {
                const evt = JSON.parse(dataStr);
                if (evt.type === 'thinking' && evt.delta !== undefined) onThinking && onThinking(evt.delta);
                else if (evt.type === 'content' && evt.delta !== undefined) onContent && onContent(evt.delta);
                else if (evt.type === 'done') finish(() => onDone && onDone({ mermaid: evt.mermaid, fixes: evt.fixes || [], extracted: evt.extracted }));
                else if (evt.type === 'error') finish(() => onError && onError(evt.message || '生成失败', evt.hint || ''));
            } catch (e) {
                // 半截 JSON（跨 chunk），跳过等下一段
            }
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                // SSE 事件以空行（\n\n）分隔
                let idx;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const raw = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    if (raw.trim()) handleEvent(raw);
                }
            }
            // 冲刷残留缓冲
            if (buffer.trim()) handleEvent(buffer);
        } catch (e) {
            if (e.name === 'AbortError') {
                aborted = true;
                finish(() => onAbort && onAbort());
            } else {
                finish(() => onError && onError('流式连接中断: ' + e.message, ''));
            }
        } finally {
            // 兜底：连接被干净关闭但未收到 done/error（如反代 proxy_read_timeout 切断），
            // 不兜底则 isStreaming 卡 true、光标不消失、用户被锁死无法继续发送
            if (!finalized && !aborted) {
                finish(() => onError && onError('连接已断开，请重试', ''));
            }
            if (this._abortController === controller) this._abortController = null;
            // 读取器可能未释放，确保取消（aborted 时尤其需要）
            if (aborted) { try { reader.cancel(); } catch (e) {} }
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    chat.init();
});

window.chat = chat;
