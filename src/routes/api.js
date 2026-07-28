/**
 * API Routes
 * Handles all /api endpoints
 */

const url = require('url');
const logger = require('../utils/logger');
const GeneratorService = require('../services/generator');
const ExportService = require('../services/export');
const { SessionStore } = require('../services/sessionStore');
const { validateGenerateRequest } = require('../middleware/validator');

function createRouter(config) {
    const generator = new GeneratorService(config);
    const exportService = new ExportService(config);
    const sessionStore = new SessionStore(config);

    return {
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
                // generation (keeps curl and legacy clients working). When
                // present it must pass the uuid-shape check — the validation
                // lives here rather than in validator.js because the uuid
                // rules belong to SessionStore.
                if (sessionId !== undefined && !sessionStore.isValidId(sessionId)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Validation Error',
                        message: 'Invalid sessionId format'
                    }));
                    return;
                }

                // A valid-but-unknown id (e.g. cleaned up after a server
                // restart) is transparently recreated with empty history
                const history = sessionId ? sessionStore.readHistory(sessionId) : [];

                // Generate Mermaid code with multi-turn context
                const generatedCode = await generator.generate(prompt, currentMermaid, history);

                let responseHistory = [];
                if (sessionId) {
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
                res.end(JSON.stringify({
                    error: 'Generation Failed',
                    message: error.message,
                    hint: '请确保输入的是流程图描述（如"用户登录流程"），而非对话内容'
                }));
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
                res.end(JSON.stringify({
                    error: 'Regeneration Failed',
                    message: error.message
                }));
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

module.exports = createRouter;