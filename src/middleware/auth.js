/**
 * Authentication Middleware
 * Validates API auth key from X-API-Key header
 */

const logger = require('../utils/logger');

function authMiddleware(config) {
    return (req, res, next) => {
        const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

        // health 与 /api/auth/* 绕过 API-Key 层：登录端点若要求 X-API-Key，
        // 浏览器 apiFetch 不送该头 -> 登录全链路断。/api/auth/me、/api/auth/logout
        // 仍受 authUser（PROTECTED_USER_ROUTES）保护，这里跳过不影响其登录校验。
        if (pathname === '/api/health' || pathname.startsWith('/api/auth/')) {
            return next();
        }

        if (!config.auth.enabled) {
            return next();
        }

        const apiKey = req.headers['x-api-key'];

        if (!apiKey) {
            logger.warn('Request rejected: missing API key', pathname);
            if (res.status && typeof res.status === 'function') {
                return res.status(401).json({
                    error: 'Unauthorized',
                    message: 'API key is required. Please provide X-API-Key header.'
                });
            }
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                message: 'API key is required. Please provide X-API-Key header.'
            }));
            return;
        }

        if (apiKey !== config.auth.apiKey) {
            logger.warn('Request rejected: invalid API key', pathname);
            if (res.status && typeof res.status === 'function') {
                return res.status(401).json({
                    error: 'Unauthorized',
                    message: 'Invalid API key.'
                });
            }
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Unauthorized',
                message: 'Invalid API key.'
            }));
            return;
        }

        next();
    };
}

module.exports = authMiddleware;