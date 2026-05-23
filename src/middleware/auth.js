/**
 * Authentication Middleware
 * Validates API auth key from X-API-Key header
 */

const logger = require('../utils/logger');

function authMiddleware(config) {
    return (req, res, next) => {
        // Skip auth check for health endpoint
        if (req.path === '/api/health') {
            return next();
        }

        // If auth is disabled (no API_AUTH_KEY configured), allow all
        if (!config.auth.enabled) {
            return next();
        }

        const apiKey = req.headers['x-api-key'];

        if (!apiKey) {
            logger.warn('Request rejected: missing API key', req.path);
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'API key is required. Please provide X-API-Key header.'
            });
        }

        if (apiKey !== config.auth.apiKey) {
            logger.warn('Request rejected: invalid API key', req.path);
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Invalid API key.'
            });
        }

        next();
    };
}

module.exports = authMiddleware;