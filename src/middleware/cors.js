/**
 * CORS Middleware
 * Configures Cross-Origin Resource Sharing with whitelist
 */

const logger = require('../utils/logger');

function corsMiddleware(config) {
    return (req, res, next) => {
        // Skip CORS for same-origin requests
        const origin = req.headers.origin;

        if (!origin) {
            return next();
        }

        // Check if origin is in allowed list
        const allowedOrigins = config.cors.origins || [];

        if (allowedOrigins.length === 0) {
            // No origins configured, deny all cross-origin requests
            logger.warn('CORS blocked: no allowed origins configured', origin);
            return res.status(403).json({
                error: 'Forbidden',
                message: 'CORS not configured for this origin.'
            });
        }

        // Normalize origin comparison
        const normalizedOrigin = origin.toLowerCase();
        const isAllowed = allowedOrigins.some(allowed => {
            const normalizedAllowed = allowed.toLowerCase();
            return normalizedOrigin === normalizedAllowed ||
                   normalizedOrigin.endsWith(normalizedAllowed.replace(/^\*/, ''));
        });

        if (!isAllowed) {
            logger.warn('CORS blocked: origin not in whitelist', origin, 'allowed:', allowedOrigins);
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Origin not allowed by CORS policy.'
            });
        }

        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

        // Handle preflight
        if (req.method === 'OPTIONS') {
            return res.status(204).end();
        }

        next();
    };
}

module.exports = corsMiddleware;