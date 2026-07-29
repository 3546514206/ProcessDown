/**
 * Server Entry Point
 * Main HTTP server with middleware chain
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { getConfig } = require('../config/loader');
const logger = require('../utils/logger');
const authMiddleware = require('../middleware/auth');
const authUserMiddleware = require('../middleware/authUser');
const { UserStore } = require('../services/userStore');
const corsMiddleware = require('../middleware/cors');
const rateLimitMiddleware = require('../middleware/rateLimit');
const { validatorMiddleware } = require('../middleware/validator');
const errorHandler = require('../middleware/errorHandler');
const createApiRouter = require('../routes/api');
const { cleanupExpiredSessions } = require('../services/sessionStore');

// Load configuration
const config = getConfig();

// Set log level from config
logger.setLevel(config.logging.level);

// Create middleware chain
const auth = authMiddleware(config);
const cors = corsMiddleware(config);
const rateLimit = rateLimitMiddleware(config);
const validator = validatorMiddleware;

// 用户登录态鉴权：仅作用于需要登录的路由（见下方 PROTECTED_USER_ROUTES）。
// register/login/health/config 不在此列，故未登录也能注册/登录。
const userStore = new UserStore(config);
const authUser = authUserMiddleware(userStore);

// API router
const api = createApiRouter(config);

// 需要登录（Bearer token）的路由集合。与 auth.js 的 API-Key 层正交：
// API-Key 仍作用于全部 /api/（health 与 /api/auth/* 除外），本层在此基础上
// 要求用户登录态。regenerate/export/png 同属“画图”语义，纳入保护以闭合
// 需求 2（否则默认部署下可被 curl 白嫖 LLM 或打 CPU）。
const PROTECTED_USER_ROUTES = new Set([
    '/api/generate',
    '/api/regenerate',
    '/api/export/png',
    '/api/session',
    '/api/session/check',
    '/api/sessions',
    '/api/auth/me',
    '/api/auth/logout'
]);

// MIME types for static files
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Max request body size (1MB) - enforced in parseBody to defend against
// clients that omit Content-Length (validator only checks the header).
const MAX_BODY_SIZE = 1024 * 1024;

function serveStaticFile(filePath, res) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Server Error');
            }
            return;
        }

        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
    });
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let exceeded = false;
        req.on('data', chunk => {
            if (exceeded) return;
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                exceeded = true;
                const err = new Error('Request body exceeds 1MB limit');
                err.code = 'BODY_TOO_LARGE';
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (exceeded) return;
            try {
                // Concat as Buffer first so multi-byte UTF-8 (Chinese) split
                // across chunk boundaries is reassembled correctly.
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    // Log request
    logger.debug(`${req.method} ${parsedUrl.pathname}`);

    // Apply middleware
    try {
        // CORS (needs to be early for preflight)
        cors(req, res, () => {});

        if (res.headersSent) return;

        // Rate limit
        rateLimit(req, res, () => {});

        if (res.headersSent) return;

        // Auth (skip for static files)
        if (!req.url.startsWith('/api/')) {
            // Static file request - skip auth but continue
        } else {
            auth(req, res, () => {});
        }

        if (res.headersSent) return;

        // Validator for API routes
        if (req.url.startsWith('/api/')) {
            validator(req, res, () => {});
        }

        if (res.headersSent) return;

        // Route handling
        if (req.url.startsWith('/api/')) {
            // Parse JSON body for POST requests
            if (req.method === 'POST') {
                try {
                    req.body = await parseBody(req);
                } catch (e) {
                    const isTooLarge = e.code === 'BODY_TOO_LARGE';
                    res.writeHead(isTooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: isTooLarge ? 'Payload Too Large' : 'Invalid JSON',
                        message: e.message
                    }));
                    return;
                }
            }

            // API routing
            // 受保护路由先过用户登录态鉴权：失败则 authUser 已同步 res.end()，
            // headersSent 为真，这里直接 return，不会落到 switch。
            if (PROTECTED_USER_ROUTES.has(parsedUrl.pathname)) {
                authUser(req, res, () => {});
                if (res.headersSent) return;
            }

            switch (parsedUrl.pathname) {
                case '/api/generate':
                    await api.generate(req, res);
                    break;

                case '/api/regenerate':
                    await api.regenerate(req, res);
                    break;

                case '/api/config':
                    api.config(req, res);
                    break;

                case '/api/health':
                    api.health(req, res);
                    break;

                case '/api/session':
                    await api.createSession(req, res);
                    break;

                case '/api/session/check':
                    await api.checkSession(req, res);
                    break;

                case '/api/sessions':
                    api.listSessions(req, res);
                    break;

                case '/api/auth/register':
                    api.register(req, res);
                    break;

                case '/api/auth/login':
                    api.login(req, res);
                    break;

                case '/api/auth/logout':
                    api.logout(req, res);
                    break;

                case '/api/auth/me':
                    api.me(req, res);
                    break;

                case '/api/export/png':
                    await api.exportPng(req, res);
                    break;

                default:
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Not Found' }));
            }
        } else {
            // Static file serving
            let filePath = parsedUrl.pathname;

            // Root -> index.html
            if (filePath === '/') {
                filePath = '/index.html';
            }

            // Remove leading slash and normalize
            const cleanPath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
            const publicPath = path.join(process.cwd(), 'public', cleanPath);
            const publicDir = path.join(process.cwd(), 'public');

            // Security: ensure file is within public directory
            if (!publicPath.startsWith(publicDir)) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden');
                return;
            }

            serveStaticFile(publicPath, res);
        }
    } catch (error) {
        errorHandler(error, req, res, () => {});
    }
});

// Start server
const PORT = config.server.port;

const HOST = config.server.host || '0.0.0.0';

server.listen(PORT, HOST, () => {
    // 仅清理旧的全局会话目录 run/session/。run/users/ 下的用户账号与
    // 历史会话绝不自动清理（需永久保留）。
    cleanupExpiredSessions(config);
    logger.info(`🚀 ProcessDown server running on http://${HOST}:${PORT}`);
    logger.info(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`   Auth enabled: ${config.auth.enabled}`);
    logger.info(`   CORS origins: ${config.cors.origins.join(', ') || 'none'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('Shutting down gracefully...');
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

module.exports = server;