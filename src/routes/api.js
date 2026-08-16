/**
 * API Routes
 * Handles all /api endpoints
 *
 * 用户作用域：/api/session、/api/session/check、/api/generate、/api/sessions
 * 均基于 req.user（由 authUser 中间件注入）派生该用户的 SessionStore，
 * 指向 run/users/<username>/sessions/。register/login/health/config 不需要登录。
 */

const path = require('path');
const logger = require('../utils/logger');
const GeneratorService = require('../services/generator');
const ExportService = require('../services/export');
const { SessionStore } = require('../services/sessionStore');
const { UserStore } = require('../services/userStore');
const { validateGenerateRequest } = require('../middleware/validator');
const { extractMermaidCode, autoFixMermaidCode } = require('../services/extractor');

function createRouter(config) {
    const generator = new GeneratorService(config);
    const exportService = new ExportService(config);
    const userStore = new UserStore(config);

    // 每用户 SessionStore 缓存：避免每次请求都触发构造函数里的 mkdirSync。
    // 用户数有限，Map 不会膨胀；SessionStore 构造本身幂等，重复创建也无副作用。
    const sessionStores = new Map();
    function sessionStoreFor(req) {
        const username = req.user;
        let store = sessionStores.get(username);
        if (!store) {
            store = new SessionStore({
                session: {
                    dir: path.join(config.users.dir, username, 'sessions'),
                    maxHistory: config.session.maxHistory,
                    ttlDays: config.session.ttlDays
                }
            });
            sessionStores.set(username, store);
        }
        return store;
    }

    return {
        /**
         * POST /api/auth/register
         * 注册新用户并直接签发 token（省去注册后立刻登录的一步）。
         */
        register(req, res) {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method Not Allowed', message: 'Use POST to register' }));
                return;
            }
            const { username, password } = req.body || {};
            const result = userStore.register(username, password);
            if (result.error) {
                const { code, message } = REGISTER_ERRORS[result.error];
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: result.error, message }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, token: result.token, username: result.username }));
        },

        /**
         * POST /api/auth/login
         * 校验密码后轮换 token 返回。用户名/密码错误统一 401，不区分是否存在，
         * 避免用户名枚举。
         */
        login(req, res) {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method Not Allowed', message: 'Use POST to login' }));
                return;
            }
            const { username, password } = req.body || {};
            const result = userStore.login(username, password);
            if (result.error) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid_credentials', message: '用户名或密码错误' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, token: result.token, username: result.username }));
        },

        /**
         * POST /api/auth/logout
         * 清空当前用户的 profile.token，使已下发 token 立即失效。幂等。
         */
        logout(req, res) {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method Not Allowed', message: 'Use POST to logout' }));
                return;
            }
            userStore.logout(req.user);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        },

        /**
         * GET /api/auth/me
         * 探活当前 token：authUser 通过即说明 token 有效，回显用户名。
         * 前端启动时用它判断登录态。
         */
        me(req, res) {
            if (req.method !== 'GET') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method Not Allowed', message: 'Use GET for /api/auth/me' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, username: req.user }));
        },

        /**
         * GET /api/sessions
         * 列出当前用户所有历史会话（summary 取首轮提示词前 30 字，按更新时间倒序）。
         * 供左侧抽屉渲染。
         */
        listSessions(req, res) {
            if (req.method !== 'GET') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method Not Allowed', message: 'Use GET for /api/sessions' }));
                return;
            }
            const sessions = userStore.listSessions(req.user);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, sessions }));
        },

        /**
         * POST /api/session
         * Create a new session and return its id. The frontend lazily requests
         * one before the first generation and keeps it in memory only, so a
         * browser refresh means a brand-new session.
         */
        createSession(req, res) {
            // Creation is a side effect, so explicitly reject non-POST. (The
            // older handlers don't check the method; that's legacy, not a
            // pattern worth repeating here.)
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Method Not Allowed',
                    message: 'Use POST to create a session'
                }));
                return;
            }

            try {
                const sessionStore = sessionStoreFor(req);
                const sessionId = sessionStore.create();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, sessionId }));
            } catch (error) {
                logger.error('Create session error:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Session Creation Failed',
                    message: error.message
                }));
            }
        },

        /**
         * POST /api/session/check
         * Probe whether a session exists so the frontend can offer to restore
         * it. Read-only for unknown ids: exists() touches the filesystem only
         * via stat, and history is read solely when exists is true (so an
         * unknown id never triggers readHistory's transparent recreation).
         * Caveat: when the session exists but history.json is corrupt,
         * readHistory's recovery path backs up and resets the file - a write
         * side effect during this nominally read-only probe. Accepted because
         * the corrupt file cannot serve history anyway, and the backup
         * preserves the original bytes for forensics.
         * lastMermaid (last assistant content) is returned for the frontend
         * to re-render the previous diagram on restore.
         */
        checkSession(req, res) {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Method Not Allowed',
                    message: 'Use POST to check a session'
                }));
                return;
            }

            const body = req.body || {};
            const { sessionId: rawId } = body;

            if (typeof rawId !== 'string' || !rawId.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Validation Error',
                    message: '"sessionId" field is required'
                }));
                return;
            }

            // Trim once so the shape check, exists probe, and response echo
            // all see the same value - matches the frontend, which trims
            // before sending.
            const sessionId = rawId.trim();

            const sessionStore = sessionStoreFor(req);

            // Shape check before any filesystem touch - never let an untrusted
            // id near the disk even though exists() also guards internally.
            if (!sessionStore.isValidId(sessionId)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Validation Error',
                    message: 'Invalid sessionId format'
                }));
                return;
            }

            const historyExists = sessionStore.exists(sessionId);
            // 先读 diagram.json：diagram-only 的会话（PATCH 先于首次 /api/generate 落盘——
            // 流式 onDone 尚未 append 时用户已在改代码）也得被认作"存在"，否则恢复路径
            // 走 exists=false → "未找到该会话"，用户的编辑无声丢失。readDiagram 在缺失
            // 或损坏时返回 null，不抛
            const diagram = sessionStore.readDiagram(sessionId);
            const exists = historyExists || !!diagram;

            let lastMermaid = null;
            let history = null;
            if (exists) {
                if (historyExists) {
                    history = sessionStore.readHistory(sessionId);
                    // 旧会话里残留的不兼容写法（如 gitGraph LR:，早于 extractor 某次增强）
                    // 会让前端 mermaid.render 失败。对每条 assistant content 跑 extract+autoFix，
                    // 与 generate 链路保持单一真源--前端 renderHistory 渲染的是净化后的内容
                    // （此前只净化 lastMermaid，但前端走 history 分支，净化未到达渲染路径）。
                    // 不写盘：checkSession 只读，仅净化返回值。extract 对非 mermaid 内容返回
                    // null 时保留原文，避免丢数据。frontmatter 不剥离（bundle 11.16.1 原生支持）。
                    history = history.map(h => {
                        if (h.role === 'assistant' && h.content) {
                            const extracted = extractMermaidCode(h.content);
                            if (extracted) return { ...h, content: autoFixMermaidCode(extracted).code };
                        }
                        return h;
                    });
                }
                // diagram.json 是可编辑覆盖层（LLM 或人工编辑），优先于 history 的最后一条
                // assistant content。typeof === 'string' 而非 truthy：保留空串的"清空覆盖层"
                // 语义，否则 PATCH { code: '' } 在恢复时被 falsy 短路退回到 history，覆盖
                // 层的清空动作对用户不可见
                if (diagram && typeof diagram.code === 'string') {
                    lastMermaid = diagram.code;
                } else if (history) {
                    for (let i = history.length - 1; i >= 0; i--) {
                        if (history[i].role === 'assistant') {
                            lastMermaid = history[i].content;
                            break;
                        }
                    }
                }
            }

            // history 已被 readHistory 截断到 maxHistory（默认 20 条=10 轮），
            // 供前端 renderHistory 重建完整对话；体积受 maxHistory 约束。
            // lastMermaid 从 diagram.json 派生（用户编辑优先），否则从净化后的 history 派生，
            // 无需再单独 extract+autoFix。
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, exists, sessionId, lastMermaid, history }));
        },

        /**
         * PATCH /api/session/:id/diagram
         * 写入"当前规范图表"覆盖层。前端用户在 AI 消息的代码 textarea 里手动改完后
         * 触发（带 600ms 防抖）。仅写 diagram.json，history.json 不动--那是审计轨迹，
         * 任何一方的内容都不应被客户端编辑悄然改写。isValidId 守卫保证 id 不会越权访问
         * 其他用户的会话目录，code 必须是字符串且长度有上界。
         */
        patchDiagram(req, res) {
            if (req.method !== 'PATCH') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Method Not Allowed',
                    message: 'Use PATCH to update the diagram'
                }));
                return;
            }

            // 生产路径上 server/index.js 的 /^\/api\/session\/[^/]+\/diagram$/ 已经卡过一次
            // 形状，下面这段 4 段校验只有直接调 handler 时（单测、将来新增的调用点）才可能
            // 命中。保留它是廉价的纵深防御：handler 单独看也不会把 pathParts[2] 当成
            // undefined 一路传给 isValidId
            const pathParts = req.url.split('?')[0].split('/').filter(Boolean);
            // /api/session/<id>/diagram -> 期望 4 段
            if (pathParts.length !== 4 || pathParts[0] !== 'api' || pathParts[1] !== 'session' || pathParts[3] !== 'diagram') {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not Found' }));
                return;
            }
            const sessionId = pathParts[2];
            const body = req.body || {};

            const sessionStore = sessionStoreFor(req);
            if (!sessionStore.isValidId(sessionId)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Validation Error',
                    message: 'Invalid sessionId format'
                }));
                return;
            }

            if (typeof body.code !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Validation Error',
                    message: '"code" must be a string'
                }));
                return;
            }

            // 200KB 与 mermaid 源码实际体积对齐：超过此值基本可断为异常输入。
            // 历史保留更宽（maxHistory 20 条≈几百 KB），单图覆盖层不需要那么宽。
            if (body.code.length > 200000) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Validation Error',
                    message: '"code" exceeds maximum size of 200KB'
                }));
                return;
            }

            try {
                // 注意：saveDiagram 内的 mkdirSync(recursive) 会真的建出
                // run/users/<u>/sessions/<id>/，所以对一个从未生成过的合法 uuid 发 PATCH
                // 也会落下一个只含 diagram.json 的目录。这不是漏洞，只是与 POST /api/session
                // 同一档的"已登录用户自污染"：username 白名单 + isValidId 已把写入死锁在
                // 该用户自己的 sessions/ 下，越权与路径穿越都不可能。
                // 之所以不加"会话必须已存在"的前置校验：编辑先于首次落盘的时序是合法的
                // （流式 onDone 尚未 append，用户已在改代码），拦下来会丢用户的编辑。
                sessionStore.saveDiagram(sessionId, body.code);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, sessionId, savedAt: Date.now() }));
            } catch (e) {
                logger.error('Save diagram error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Save Failed',
                    message: e.message
                }));
            }
        },

        /**
         * POST /api/generate
         * Generate Mermaid diagram from natural language
         */
        async generate(req, res) {
            try {
                const body = req.body;

                // Validate request
                const validation = validateGenerateRequest(body);
                if (!validation.valid) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Validation Error',
                        message: validation.errors.join(', ')
                    }));
                    return;
                }

                const { prompt, mermaid: currentMermaid, sessionId } = body;

                // sessionId is optional: without it we run a pure single-turn
                // generation (keeps curl and legacy clients working). Only
                // resolve the per-user store when a sessionId is present, so a
                // sessionId-less request has no filesystem side effect (no user
                // dir created). When present it must pass the uuid-shape check
                // - the validation lives here rather than in validator.js
                // because the uuid rules belong to SessionStore.
                let sessionStore = null;
                if (sessionId !== undefined) {
                    sessionStore = sessionStoreFor(req);
                    if (!sessionStore.isValidId(sessionId)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: 'Validation Error',
                            message: 'Invalid sessionId format'
                        }));
                        return;
                    }
                }

                // A valid-but-unknown id (e.g. cleaned up after a server
                // restart) is transparently recreated with empty history
                const history = sessionStore ? sessionStore.readHistory(sessionId) : [];

                // Generate Mermaid code with multi-turn context
                const generatedCode = await generator.generate(prompt, currentMermaid, history);

                let responseHistory = [];
                if (sessionStore) {
                    try {
                        sessionStore.append(sessionId, prompt, generatedCode);
                        // diagram.json 与 history.json 并行：history 是审计轨迹，diagram 是
                        // 当前规范图表（LLM 或人工编辑）。两边都写保证 checkSession 后续能
                        // 从 diagram 派生出 lastMermaid
                        sessionStore.saveDiagram(sessionId, generatedCode);
                        responseHistory = sessionStore.readHistory(sessionId).slice(-10);
                    } catch (e) {
                        // The diagram is already generated; a failed disk write
                        // (e.g. full disk) is not worth a 500
                        logger.error('Failed to persist session history:', e.message);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    mermaid: generatedCode,
                    history: responseHistory
                }));

            } catch (error) {
                logger.error('Generate error:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(llmErrorResponse(error, 'Generation Failed')));
            }
        },

        /**
         * POST /api/generate/stream
         * 流式生成：SSE 响应，逐 delta 推 thinking/content，结束推 done。
         * 请求体与 /api/generate 一致；校验失败返回 400 JSON（保持与非流式一致），
         * 通过校验后升级为 text/event-stream，后续错误以 error 事件送达。
         * 客户端断开时 AbortController 中止上游 LLM 请求，避免空跑。
         */
        async generateStream(req, res) {
            const body = req.body;
            const validation = validateGenerateRequest(body);
            if (!validation.valid) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Validation Error', message: validation.errors.join(', ') }));
                return;
            }

            const { prompt, mermaid: currentMermaid, sessionId } = body;

            let sessionStore = null;
            if (sessionId !== undefined) {
                sessionStore = sessionStoreFor(req);
                if (!sessionStore.isValidId(sessionId)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Validation Error', message: 'Invalid sessionId format' }));
                    return;
                }
            }

            const history = sessionStore ? sessionStore.readHistory(sessionId) : [];

            // 升级为 SSE。X-Accel-Buffering: no 让 Nginx 反代不缓冲，保证流式
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });

            const send = (obj) => {
                if (res.writableEnded) return false;
                res.write(`data: ${JSON.stringify(obj)}\n\n`);
                return true;
            };

            // 客户端断开 -> 中止上游 LLM 流，generator 抛 ABORTED，下面 catch 静默收尾
            const controller = new AbortController();
            req.on('close', () => controller.abort());

            try {
                await generator.generateStream(prompt, currentMermaid, history, {
                    onThinking: (delta) => send({ type: 'thinking', delta }),
                    onContent: (delta) => send({ type: 'content', delta }),
                    onDone: ({ mermaid, fixes, extracted }) => {
                        if (sessionStore) {
                            try {
                                sessionStore.append(sessionId, prompt, mermaid);
                                // 与 /api/generate 同源：diagram.json 让用户在流式结束后
                                // 直接编辑覆盖，无需等到下一轮生成
                                sessionStore.saveDiagram(sessionId, mermaid);
                            } catch (e) {
                                logger.error('Failed to persist session history:', e.message);
                            }
                        }
                        send({ type: 'done', mermaid, fixes, extracted });
                    }
                }, controller.signal);

                if (!res.writableEnded) {
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
            } catch (error) {
                if (error && error.code === 'ABORTED') {
                    // 客户端已断开，无需再写
                    if (!res.writableEnded) res.end();
                    return;
                }
                logger.error('Generate stream error:', error.message);
                const resp = llmErrorResponse(error, 'Generation Failed');
                send({ type: 'error', message: resp.message, hint: resp.hint });
                if (!res.writableEnded) {
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
            }
        },

        /**
         * GET /api/config
         * Get non-sensitive server configuration
         */
        config(req, res) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                server: {
                    port: config.server.port,
                    timeout: config.server.timeout
                },
                cors: {
                    enabled: config.cors.enabled,
                    origins: config.cors.origins
                },
                rateLimit: {
                    enabled: config.rateLimit.enabled,
                    maxRequests: config.rateLimit.maxRequests,
                    windowMs: config.rateLimit.windowMs
                },
                llm: {
                    model: config.llm.model,
                    temperature: config.llm.temperature,
                    maxTokens: config.llm.maxTokens
                },
                auth: {
                    enabled: config.auth.enabled
                }
            }));
        },

        /**
         * GET /api/health
         * Health check endpoint. LLM reachability probe is opt-in
         * (HEALTH_CHECK_LLM=true) because probing a slow air-gapped LLM
         * on every check is impractical.
         */
        async health(req, res) {
            const body = {
                status: 'ok',
                timestamp: new Date().toISOString()
            };
            if (config.health.checkLlm) {
                body.llm = await generator.checkLlm();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        },

        /**
         * POST /api/regenerate
         * Regenerate from existing Mermaid with instruction
         */
        async regenerate(req, res) {
            try {
                const body = req.body;

                if (!body.mermaid || !body.instruction) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Validation Error',
                        message: '"mermaid" and "instruction" fields are required'
                    }));
                    return;
                }

                const regeneratedCode = await generator.regenerate(body.mermaid, body.instruction);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    mermaid: regeneratedCode
                }));

            } catch (error) {
                logger.error('Regenerate error:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(llmErrorResponse(error, 'Regeneration Failed')));
            }
        },

        /**
         * POST /api/export/png
         * Export SVG to PNG on the server side
         */
        async exportPng(req, res) {
            try {
                const body = req.body || {};

                if (!body.svg) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Validation Error',
                        message: '"svg" field is required'
                    }));
                    return;
                }

                if (body.svg.length > 500000) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Validation Error',
                        message: 'SVG exceeds maximum size of 500KB'
                    }));
                    return;
                }

                const scale = Math.min(Math.max(parseInt(body.scale) || 1, 1), 3);
                const bgType = body.bg || 'dark';
                const bgColor = exportService.parseBackgroundColor(bgType);

                const pngBuffer = await exportService.svgToPng(body.svg, scale, bgColor);

                res.writeHead(200, {
                    'Content-Type': 'image/png',
                    'Content-Length': pngBuffer.length,
                    'Content-Disposition': `attachment; filename="flowchart-${Date.now()}-${scale}x.png"`
                });
                res.end(pngBuffer);

            } catch (error) {
                logger.error('Export PNG error:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Export Failed',
                    message: error.message
                }));
            }
        }
    };
}

// 根据错误特征生成用户可读的响应：网络/LLM 服务错误与输入错误区分开，
// 避免网络故障时误导读图“输入不对”。原始 error.message 仍由 logger 记录，
// 回传客户端的 message 做了脱敏（不暴露内网 LLM 地址等细节）。
function llmErrorResponse(error, errorLabel) {
    const msg = (error && error.message) || '';
    let message = msg;
    let hint = '';
    if (/Request failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|Request timeout/i.test(msg)) {
        message = 'LLM 服务连接失败';
        hint = '请检查 LLM_API_BASE_URL（地址/端口）与 LLM 服务是否在运行';
    } else if (/API error|Failed to parse API response/i.test(msg)) {
        message = 'LLM 服务返回异常';
        hint = '请检查 API Key、模型名或 LLM 服务状态';
    } else if (/Could not extract Mermaid/i.test(msg)) {
        hint = '请确保输入的是流程图描述（如“用户登录流程”），而非对话内容';
    }
    return { error: errorLabel, message, hint };
}

// register 错误码 -> HTTP 状态与提示的映射。集中一处便于审阅与扩展。
const REGISTER_ERRORS = {
    invalid_username: { code: 400, message: '用户名需为 3-32 位字母数字、下划线或连字符' },
    invalid_password: { code: 400, message: '密码至少 6 位' },
    user_exists: { code: 409, message: '用户名已存在' }
};

module.exports = createRouter;
