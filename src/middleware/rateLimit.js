/**
 * Rate Limiting Middleware
 * Simple in-memory rate limiter
 */

const logger = require('../utils/logger');

function rateLimitMiddleware(config) {
    // In-memory store for rate limiting (use Redis in production for scaling)
    const requests = new Map();

    // Cleanup old entries periodically
    setInterval(() => {
        const now = Date.now();
        for (const [key, data] of requests.entries()) {
            if (now - data.windowStart > config.rateLimit.windowMs) {
                requests.delete(key);
            }
        }
    }, 10000);

    return (req, res, next) => {
        if (!config.rateLimit.enabled) {
            return next();
        }

        // Use IP as key for rate limiting
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();

        if (!requests.has(ip)) {
            requests.set(ip, { count: 0, windowStart: now });
        }

        const clientData = requests.get(ip);

        // Reset window if expired
        if (now - clientData.windowStart > config.rateLimit.windowMs) {
            clientData.count = 0;
            clientData.windowStart = now;
        }

        clientData.count++;

        // Set rate limit headers
        res.setHeader('X-RateLimit-Limit', config.rateLimit.maxRequests);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, config.rateLimit.maxRequests - clientData.count));

        if (clientData.count > config.rateLimit.maxRequests) {
            logger.warn('Rate limit exceeded', ip, 'count:', clientData.count);
            return res.status(429).json({
                error: 'Too Many Requests',
                message: 'Rate limit exceeded. Please try again later.',
                retryAfter: Math.ceil((clientData.windowStart + config.rateLimit.windowMs - now) / 1000)
            });
        }

        next();
    };
}

module.exports = rateLimitMiddleware;