/**
 * API Routes
 * Handles all /api endpoints
 */

const url = require('url');
const logger = require('../utils/logger');
const GeneratorService = require('../services/generator');
const { validateGenerateRequest } = require('../middleware/validator');

function createRouter(config) {
    const generator = new GeneratorService(config);

    // Store conversation history per session (in-memory, use Redis for production)
    const conversations = new Map();

    function getConversationId(req) {
        return req.ip || 'default';
    }

    return {
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

                const { prompt, mermaid: currentMermaid } = body;

                // Get or create conversation
                const convId = getConversationId(req);
                if (!conversations.has(convId)) {
                    conversations.set(convId, []);
                }

                const convHistory = conversations.get(convId);

                // Generate Mermaid code
                const generatedCode = await generator.generate(prompt, currentMermaid);

                // Add to conversation history
                convHistory.push({
                    role: 'user',
                    content: prompt
                });
                convHistory.push({
                    role: 'assistant',
                    content: generatedCode
                });

                // Limit history size
                if (convHistory.length > 20) {
                    convHistory.splice(0, convHistory.length - 20);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    mermaid: generatedCode,
                    history: convHistory.slice(-10) // Return last 10 messages for context
                }));

            } catch (error) {
                logger.error('Generate error:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Generation Failed',
                    message: error.message
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
         * Health check endpoint
         */
        health(req, res) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                timestamp: new Date().toISOString()
            }));
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
        }
    };
}

module.exports = createRouter;