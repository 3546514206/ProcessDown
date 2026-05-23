/**
 * CORS Middleware
 * Configures Cross-Origin Resource Sharing with whitelist
 */

const logger = require('../utils/logger');

function corsMiddleware(config) {
    return (req, res, next) => {
        const origin = req.headers.origin;
        const host = req.headers.host || '';

        if (!origin) {
            return next();
        }

        const originUrl = `http://${host}`;
        const isSameOrigin = origin === originUrl || origin === `https://${host}`;

        if (isSameOrigin) {
            return next();
        }

        const allowedOrigins = config.cors.origins || [];

        if (allowedOrigins.length === 0) {
            return next();
        }

        const normalizedOrigin = origin.toLowerCase();
        const isAllowed = allowedOrigins.some(allowed => {
            const normalizedAllowed = allowed.toLowerCase();
            return normalizedOrigin === normalizedAllowed ||
                   normalizedOrigin.endsWith(normalizedAllowed.replace(/^\*/, ''));
        });

        if (!isAllowed) {
            logger.warn('CORS blocked: origin not in whitelist', origin, 'allowed:', allowedOrigins);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Forbidden',
                message: 'Origin not allowed by CORS policy.'
            }));
            return;
        }

        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        next();
    };
}

module.exports = corsMiddleware;