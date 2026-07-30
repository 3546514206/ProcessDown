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

            const exists = sessionStore.exists(sessionId);

            let lastMermaid = null;
            if (exists) {
                const history = sessionStore.readHistory(sessionId);
                for (let i = history.length - 1; i >= 0; i--) {
                    if (history[i].role === 'assistant') {
                        lastMermaid = history[i].content;
                        break;
                    }
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, exists, sessionId, lastMermaid }));
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

                if (body.mermaid.length > 5000 || body.instruction.length > 5000) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Validation Error',
                        message: 'Input exceeds maximum length of 5000 characters'
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
