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

// 空会话示例 chip 的高级提示词：与 index.html 里 .example-chip 的
// data-example-key 一一对应。按钮上只显示短名，点击直接把完整提示词
// 填入输入框并发送，让新用户零门槛看到高完成度的图。
const EXAMPLE_PROMPTS = {
    'c4-ecommerce': '用 C4Container 画一个大型跨境电商平台的容器级架构图：外部角色包含买家、卖家、平台运营和第三方支付方；系统边界内至少包含 Web 前端、移动 App、API 网关、用户中心、商品服务、订单服务、库存服务、支付服务、搜索服务、推荐服务、消息队列、Redis 缓存、MySQL 主从数据库、对象存储等 12 个以上容器，为每个容器标注技术栈（如 Node.js、Kafka、Elasticsearch），并画出买家下单、卖家管理商品、支付回调、库存扣减等核心关系链，形成一张可直接用于架构评审的全景图。',
    'mindmap-genai': '用 mindmap 画一棵生成式 AI 技术全景思维导图：根节点为生成式 AI，一级分支至少 6 个，包括大语言模型、多模态模型、提示词工程、RAG 检索增强、智能体 Agent、训练与微调、安全与对齐、应用生态；每个一级分支下再展开 3 到 5 个二级要点（如大语言模型下覆盖 GPT 系列、开源模型、上下文窗口、推理优化），二级要点下再补充关键技术与代表产品名词，全图不少于 50 个节点，形成层次分明、覆盖面完整的技术知识树。',
    'git-enterprise-flow': '用 gitGraph 画一个规范的企业级 Git 分支演进图：从 main 主干的初始提交开始，先后拉出 develop 集成分支、feature/login、feature/payment、feature/search 三个功能分支、release/2.1.0 预发布分支，以及线上紧急修复用的 hotfix/2.0.1 分支。展示至少 15 次提交，包含各功能分支向 develop 的合并、develop 向 release 的合并、release 与 hotfix 回归 main 并打上 v2.0.1 和 v2.1.0 版本标签、从 main 摘取提交的 cherry-pick 操作，完整呈现主干开发工作流的分支全景。',
    'seq-spring-bean': '用 sequenceDiagram 画一张 Spring IoC 容器启动与获取 bean 的完整时序图：参与者包含客户端、ApplicationContext、BeanDefinitionRegistry、BeanFactory、BeanPostProcessor、目标 Bean 共 6 个。时序覆盖容器启动时加载配置并注册 BeanDefinition、客户端 getBean 触发懒加载、反射构造实例、属性注入 @Autowired、Aware 接口回调、BeanPostProcessor 前置处理、InitializingBean 的 afterPropertiesSet 与 @PostConstruct 初始化、后置处理生成 AOP 代理后返回代理对象。要求用 alt 区分“单例已存在直接返回”与“首次创建”两条分支，用 loop 表达属性注入时的循环依赖检查，用 note over 标注各扩展点（如 @PostConstruct 的位置），全程用 activate/deactivate 表达生命线并开启 autonumber，形成一张可直接用于源码讲解的 bean 生命周期全景图。'
};

const chat = {
    messages: [],          // [{role:'user'|'assistant', content, thinking?}]
    isStreaming: false,
    currentMermaid: '',    // 最新一张图的 mermaid（供预览/导出）
    el: {},
    _abortController: null,
    _renderTimer: null,
    _thinkStartTime: 0,
    _activeCodePre: null,  // 当前流式中那条 AI 消息的 <textarea> 引用，setStreaming(true) 时上锁
    _diagramSaveTimer: null,
    _diagramSavePending: null,  // {sessionId, code} - 节流的待保存草稿
    _pendingWelcomeKey: null,  // 本轮 chip 触发的 example key, sendMessage 消费后清空, 流式期间透传给后端

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
        // 启动即排空待重发队列：否则上次会话遗留的失败保存要等用户下一次编辑
        // （_dispatchDiagramSave 内部才会 drain）才有机会重发
        this._drainPendingSaves();
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
                const key = chip.dataset.exampleKey;
                const prompt = EXAMPLE_PROMPTS[key];
                if (!prompt) return;  // key 拼错时静默不发送，避免误导性兜底
                // 标记本轮为"chip 触发"：sendMessage 会把这个 key 透传给后端，
                // 后端从 prompts/welcome/<key>.md 抽出预制代码注入 LLM，让首屏
                // 示例零翻车。关键：UI 上 textarea 仍只填入 prompt 文本（用户看
                // 到的就是普通输入），预制代码绝不显示在界面——流式渲染的输出由
                // LLM 沿用预制代码生成，UI 体验与正常生成无差别。
                this._pendingWelcomeKey = key;
                this.el.textarea.value = prompt;
                this.sendMessage();
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
    appendAiMessage(roundPrompt) {
        this.hideWelcome();
        const root = document.createElement('div');
        root.className = 'message message-ai';
        // 该轮对应的 user 指令，供"重新生成"使用：按钮是 per-round 的可供性，
        // 必须重放本轮指令，而不是全局最后一条 user 消息
        root._prompt = roundPrompt || '';

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

        // 代码块（<details> 默认展开：AI 输出的代码是用户主要消费对象，省一次点击）
        const details = document.createElement('details');
        details.open = true;
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
        // 代码面板用 <textarea> 而非 <pre>：原生支持光标/选择/粘贴/撤销/移动键盘，
        // readonly 属性作为唯一的"编辑门"——浏览器本身就是守卫，无需 JS 状态机。
        // 流式期间 readOnly=true 防用户误编辑；finalize/clearAuth 时移除
        const codePre = document.createElement('textarea');
        codePre.className = 'code-pre';
        codePre.readOnly = true;
        codePre.spellcheck = false;
        codePre.wrap = 'off';
        // 高度自适应是即时的、与 _onCodeEdited 的 600ms 节流相互独立（后者管渲染与
        // 落盘，高度不该跟着节流），故在同一个 input 监听里先于它直调
        codePre.addEventListener('input', () => { this._fitCodeHeight(codePre); this._onCodeEdited(codePre); });
        // details 折叠时 textarea 不渲染、scrollHeight 恒为 0，赋值点无法测量；
        // 展开瞬间才是真正的测量时机
        details.addEventListener('toggle', () => { if (details.open) this._fitCodeHeight(codePre); });
        details.appendChild(summary);
        details.appendChild(codePre);

        // 操作行（流式结束后显示）
        const actionRow = document.createElement('div');
        actionRow.className = 'action-row';
        actionRow.style.display = 'none';

        // 查看此图：把该轮 mermaid 渲染到预览区（历史消息切换）。
        // 读 codePre.value 而非 root._mermaid：用户编辑后 textarea 才是所见即所得的
        // 真源，_mermaid 是未编辑的 LLM 原始输出，回落只在 value 为空时（如中断轮）
        const liveCode = () => (codePre.value || root._mermaid || '');
        const viewBtn = document.createElement('button');
        viewBtn.className = 'action-btn';
        viewBtn.textContent = '查看此图';
        viewBtn.addEventListener('click', () => {
            const code = liveCode();
            if (code) {
                this.currentMermaid = code;
                this.renderMermaid(code);
            }
        });
        actionRow.appendChild(viewBtn);

        const copyCodeBtn = document.createElement('button');
        copyCodeBtn.className = 'action-btn';
        copyCodeBtn.textContent = '复制代码';
        // 同样读 liveCode：中断轮 _mermaid 为空但 textarea 里有已流式累积的内容，
        // 复制空串会让按钮说谎（toast 提示已复制，剪贴板却是空的）
        copyCodeBtn.addEventListener('click', () => this.copyText(liveCode()));
        actionRow.appendChild(copyCodeBtn);

        const regenBtn = document.createElement('button');
        regenBtn.className = 'action-btn';
        regenBtn.textContent = '重新生成';
        regenBtn.addEventListener('click', () => {
            // 用本轮的 user 指令重新生成；缺失（老 DOM/异常）时回落到最后一条 user
            const prompt = root._prompt
                || (([...this.messages].reverse().find(m => m.role === 'user') || {}).content);
            if (prompt) {
                this.el.textarea.value = prompt;
                // 种子图也用本轮的：否则会拿预览区里别的轮次的图当上下文
                this.currentMermaid = liveCode();
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
        // 早返路径清空：流式期间点击 chip B 想"换下一张"会被 isStreaming 拦住，
        // 空 prompt 也直接 return——两条路径都不能留下 stale _pendingWelcomeKey，
        // 否则后续用户改 textarea 文本再发送会把 stale 透传给后端"作弊"——
        // 这是"用户自主输入禁止作弊"约束的客户端兜底
        if (this.isStreaming) { this._pendingWelcomeKey = null; return; }
        const prompt = this.el.textarea.value.trim();
        if (!prompt) { this._pendingWelcomeKey = null; return; }

        // chip 触发的本轮 welcomeKey：取出后立即清空，避免下一轮（用户输入）
        // 误带上同一 key 偷跑预制代码——这是"用户自主输入禁止作弊"约束的关键。
        const welcomeKey = this._pendingWelcomeKey;
        this._pendingWelcomeKey = null;

        this.appendUserMessage(prompt);
        // 新一轮开始前先 flush 上一轮的挂起 PATCH：flow 是 _onCodeEdited -> 600ms 防抖 ->
        // _dispatchDiagramSave。旧轮编辑晚于本轮 sendMessage 但早于 600ms 时，timer
        // 仍挂起；不 flush 的话本轮 finalizeAiMessage + 服务端 saveDiagram 写完新 LLM
        // 输出后，那个迟来的 PATCH 会用旧轮编辑覆盖 diagram.json，新一轮的图被静默顶掉
        this._flushPendingDiagramSave();
        // 新一轮开始：锁掉所有旧轮次的代码框。diagram.json 是"会话级当前图"单一覆盖层，
        // 若旧轮次仍可编辑，改旧轮会静默覆盖最新轮的落盘内容——把可编辑画布唯一化到
        // 最新一轮，UI 与存储模型才一致
        this.el.messages.querySelectorAll('textarea.code-pre').forEach(t => { t.readOnly = true; });
        this.el.textarea.value = '';
        this.el.textarea.style.height = 'auto';
        this.setStreaming(true);
        if (window.app) window.app.updateStatus('生成中...', 'loading');

        const aiRefs = this.appendAiMessage(prompt);
        this._activeCodePre = aiRefs.codePre;
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
            welcomeKey,
            onThinking: (delta) => {
                aiRefs.thinkBlock.hidden = false;
                aiRefs.thinkContent.textContent += delta;
                this.autoScroll();
            },
            onContent: (delta) => {
                // 流式累积到 textarea.value。codePre 在流式期间 readOnly=true，
                // 不会有用户光标，但保留 selectionStart/End 防御性赋值以免任何
                // 残留 caret 位置出现跳变
                aiRefs.codePre.value += delta;
                this._fitCodeHeight(aiRefs.codePre);
                this.scheduleRender(aiRefs.codePre.value);
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
                // 出错后解锁编辑：与 onAbort / finalizeAiMessage 对称，否则这一轮的
                // textarea 永远 readOnly，用户没法把已流出的半截代码改好再保存。
                // 同时只在"一个字都没流出来"时才隐藏代码面板——有残片就留着给用户改，
                // 隐藏它会让上面这次解锁变成空动作
                aiRefs.codePre.readOnly = false;
                if (!aiRefs.codePre.value.trim()) {
                    aiRefs.root.querySelector('.code-details').style.display = 'none';
                }
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
                // abort 后开放编辑：与 finalize 对称，避免中断后 textarea 永远锁死。
                // 中断时 _mermaid 尚未设置（finalize 没跑），UI 上按钮"查看此图"会无响应，
                // 用户可以继续手写修复并触发保存——这是有意的 graceful degrade
                aiRefs.codePre.readOnly = false;
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
        // 流式开启：把"在生成中"那条 AI 消息的 textarea 上锁，避免用户误编辑被
        // 后续 delta 覆盖（也保护 _pendingDiagramSave 不会被脏数据污染）。
        // finalizeAiMessage 与 onAbort 都会解锁，这里只管上锁
        if (on && this._activeCodePre) {
            this._activeCodePre.readOnly = true;
        }
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
        // 最终代码：用净化后 mermaid 覆盖流式累积的原始文本；同时解除 readOnly，
        // 立即开放编辑（与 abort 路径对称）。先写 value 再解锁，避免任何中间态
        if (mermaid) {
            aiRefs.codePre.value = mermaid;
            this._fitCodeHeight(aiRefs.codePre);
            aiRefs.codePre.readOnly = false;
            this.currentMermaid = mermaid;
            this.renderMermaid(mermaid);
        } else {
            // 即使 mermaid 为空（LLM 提取失败），也要解锁以保留用户手动写
            aiRefs.codePre.readOnly = false;
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

    /**
     * 代码框高度自适应：随内容行数长高，超过 480px（与 CSS max-height 对齐）后内部
     * 滚动，替代旧的 resize: vertical 手动拉伸。wrap="off" 下 scrollHeight 只反映
     * 真实行数，横向滚动不干扰测量。先复位 auto 再量，否则上一次钳制过的显式高度
     * 会让测量值停在 480。+2 补 border：scrollHeight 不含 border，而 box-sizing:
     * border-box 下显式 height 含上下各 1px border，不补则可视内容区少 2px，
     * 内容未超上限时也会出现"可滚 2px"的假滚动条（钳制值 480 同样含 border，
     * 与 CSS max-height 一致）。details 折叠时元素不渲染、scrollHeight 为 0，此时
     * 跳过（保持 auto，留默认高度），展开时由 toggle 监听补测。流式逐 delta 调用
     * 无需 debounce：折叠状态下是空操作，展开状态也只多一次强制回流，量级远小于
     * 渲染本身
     */
    _fitCodeHeight(codePre) {
        codePre.style.height = 'auto';
        const h = codePre.scrollHeight;
        if (h) codePre.style.height = Math.min(h + 2, 480) + 'px';
    },

    /**
     * 用户在 AI 消息的代码 <textarea> 里输入——三个同步动作：
     *   1) 更新 currentMermaid，让后续"重新生成"用编辑后的代码作为种子
     *   2) 重用 scheduleRender（已存在的 600ms 防抖、silent:true），边输入边预览；
     *      silent 必不可少：输入到一半可能是无效 mermaid，预览不该弹错
     *   3) 调度 _scheduleDiagramSave，把编辑后内容节流持久化到 diagram.json
     *
     * 流式期间 readonly 锁住了编辑入口，事件不会触发；防御性再做 sessionId 守卫
     * 防止刚切会话的瞬间被旧 textarea 的 input 事件污染
     */
    _onCodeEdited(codePre) {
        const code = codePre.value;
        this.currentMermaid = code;
        this.scheduleRender(code);
        const sessionId = window.app && window.app.state ? window.app.state.sessionId : null;
        // 空内容不落盘：防抖竞态（恢复瞬间的清空、误全选删除）产生的空 PATCH 会让
        // diagram.json 的 code 变成 ''，恢复时 lastMermaid='' 触发 mermaidRender.clear()，
        // 预览被无声抹掉。保留上一次的 diagram.json 是更安全的一侧
        if (sessionId && code.trim()) this._scheduleDiagramSave(sessionId, code);
    },

    /**
     * 节流保存到后端 diagram.json：600ms 与 scheduleRender 同节奏，让"输入→预览→落盘"
     * 感受一致。失败入 localStorage 待重发队列 pd_pending_saves（FIFO），下一次
     * PATCH 成功或页面加载时排空
     */
    _scheduleDiagramSave(sessionId, code) {
        this._diagramSavePending = { sessionId, code, ts: Date.now() };
        if (this._diagramSaveTimer) return;
        this._diagramSaveTimer = setTimeout(() => {
            this._diagramSaveTimer = null;
            const pending = this._diagramSavePending;
            this._diagramSavePending = null;
            if (pending) this._dispatchDiagramSave(pending);
        }, 600);
    },

    async _dispatchDiagramSave({ sessionId, code }) {
        // 先排空待重发队列里的旧失败项，避免堆积
        this._drainPendingSaves();
        try {
            const res = await fetch(`/api/session/${sessionId}/diagram`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    ...(localStorage.getItem('pd_token') ? { 'Authorization': `Bearer ${localStorage.getItem('pd_token')}` } : {})
                },
                body: JSON.stringify({ code })
            });
            // 401 交由 apiFetch 的逻辑处理——这里静默丢弃由其他防御层接管。
            // 401/403 不入队：登录态已失效，重发只会无限 401 循环
            if (!res.ok && res.status !== 401 && res.status !== 403) {
                this._enqueuePendingSave({ sessionId, code, ts: Date.now() });
            }
        } catch (e) {
            // 网络层失败：把本次入队，等下次成功或页面加载时重发
            this._enqueuePendingSave({ sessionId, code, ts: Date.now() });
        }
    },

    _enqueuePendingSave(item) {
        try {
            const raw = localStorage.getItem('pd_pending_saves');
            const arr = raw ? JSON.parse(raw) : [];
            arr.push(item);
            // 上限保护：异常输入轰炸场景不无限增长
            if (arr.length > 50) arr.splice(0, arr.length - 50);
            localStorage.setItem('pd_pending_saves', JSON.stringify(arr));
        } catch (e) {
            // localStorage 不可用（隐私模式/超额）静默丢
        }
    },

    _drainPendingSaves() {
        try {
            const raw = localStorage.getItem('pd_pending_saves');
            if (!raw) return;
            const arr = JSON.parse(raw);
            localStorage.removeItem('pd_pending_saves');
            if (!Array.isArray(arr) || !arr.length) return;
            // 顺序重发，每条独立失败/成功互不影响；任何新条目会自然落到下一轮 dispatch
            (async () => {
                for (const item of arr) {
                    try {
                        const res = await fetch(`/api/session/${item.sessionId}/diagram`, {
                            method: 'PATCH',
                            headers: {
                                'Content-Type': 'application/json',
                                ...(localStorage.getItem('pd_token') ? { 'Authorization': `Bearer ${localStorage.getItem('pd_token')}` } : {})
                            },
                            body: JSON.stringify({ code: item.code })
                        });
                        // 非 2xx 也算失败，重新入队（401/403 除外，见 _dispatchDiagramSave）
                        if (!res.ok && res.status !== 401 && res.status !== 403) {
                            this._enqueuePendingSave(item);
                        }
                    } catch (e) {
                        // 仍失败：push 回去待下次成功 PATCH 或下次启动时再试
                        // 注意是 push 到队尾（_enqueuePendingSave 内部 arr.push），
                        // 不是队首——drain 本轮不再回头重试这条
                        this._enqueuePendingSave(item);
                    }
                }
            })();
        } catch (e) {
            // localStorage 不可用/格式坏，静默丢
        }
    },

    /**
     * 立即 flush 一次挂起的 diagram 保存：在会话切换 / 新会话 / 登出前调用。
     * 清掉防抖计时器并同步 fire-and-forget 一次 PATCH，失败不影响主流程
     * （下次生成会覆盖 diagram.json，审计轨迹 history.json 不受牵连）
     */
    _flushPendingDiagramSave() {
        if (this._diagramSaveTimer) {
            clearTimeout(this._diagramSaveTimer);
            this._diagramSaveTimer = null;
        }
        const pending = this._diagramSavePending;
        this._diagramSavePending = null;
        if (pending) this._dispatchDiagramSave(pending);
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
        this._flushPendingDiagramSave();
        this.messages = [];
        this.currentMermaid = '';
        this._activeCodePre = null;
        // 跨会话边界清空：防止"上一会话流式期间点击了 chip B 但被 isStreaming 拦住"
        // 把 stale welcomeKey 带进新会话——clear 后用户在新会话里键入任意 prompt 都
        // 必须老老实实走 LLM 真生成路径
        this._pendingWelcomeKey = null;
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
    // lastMermaid 来自后端 checkSession：diagram.json（用户编辑）优先于 history
    // 最后一条 assistant。不消费它，用户的编辑在恢复时就会被 LLM 原文顶掉。
    // 只有最后一轮开放编辑：diagram.json 是会话级覆盖层，多个可编辑框会互相覆盖。
    renderHistory(history, lastMermaid) {
        this.clear();
        if (!history || !history.length) {
            this.showWelcome();
            return;
        }
        let lastAssistantIdx = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'assistant') { lastAssistantIdx = i; break; }
        }
        let pendingPrompt = '';
        for (let i = 0; i < history.length; i++) {
            const m = history[i];
            if (m.role === 'user') {
                pendingPrompt = m.content || '';
                this.appendUserMessage(m.content);
            } else if (m.role === 'assistant') {
                const isLast = (i === lastAssistantIdx);
                // 最后一轮展示 diagram.json 的编辑后内容（若有），其余轮次展示历史原文
                const shown = (isLast && typeof lastMermaid === 'string' && lastMermaid)
                    ? lastMermaid
                    : (m.content || '');
                const ai = this.appendAiMessage(pendingPrompt);
                pendingPrompt = '';
                ai.caret.remove();
                ai.actionRow.style.display = 'flex';
                ai.root._mermaid = shown;
                ai.codePre.value = shown;
                this._fitCodeHeight(ai.codePre);
                // 仅最后一轮可编辑，旧轮次保持 readOnly（默认值）
                ai.codePre.readOnly = !isLast;
                this.messages.push({ role: 'assistant', content: m.content || '' });
                if (isLast && shown) {
                    this.currentMermaid = shown;
                    this.renderMermaid(shown);
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
    async streamGenerate({ prompt, sessionId, currentMermaid, welcomeKey, onThinking, onContent, onDone, onError, onAbort }) {
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
                    sessionId: sessionId || undefined,
                    // chip 触发时才传：后端命中白名单注入预制代码；用户输入时不传,
                    // 严格走原 LLM 真生成路径
                    welcomeKey: welcomeKey || undefined,
                    // 上送当前全站主题，让 LLM 生成适配该模式（深/浅底）的配色。
                    // 防御式取值：jsdom 冒烟测试等环境可能没有 app 模块
                    theme: (window.app && window.app.getSiteTheme) ? window.app.getSiteTheme() : 'light'
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
                // finalized 后（done/error/abort 已跑）丢弃残留 content：abort 时
                // textarea 已解锁 readOnly，尾包 delta 会追加到用户正在编辑的内容里
                else if (evt.type === 'content' && evt.delta !== undefined) { if (!finalized) onContent && onContent(evt.delta); }
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
