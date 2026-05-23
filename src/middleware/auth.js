/**
 * Authentication Middleware
 * Validates API auth key from X-API-Key header
 */

const logger = require('../utils/logger');

function authMiddleware(config) {
    return (req, res, next) => {
        const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

        if (pathname === '/api/health') {
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