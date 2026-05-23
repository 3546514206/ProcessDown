/**
 * Error Handler Middleware
 * Catches and formats errors, hides details in production
 */

const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
    logger.error('Unhandled error:', err.message, 'stack:', err.stack);

    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction) {
        if (res.status && typeof res.status === 'function') {
            return res.status(500).json({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred. Please try again later.'
            });
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Internal Server Error',
            message: 'An unexpected error occurred. Please try again later.'
        }));
        return;
    }

    const statusCode = err.status || 500;
    if (res.status && typeof res.status === 'function') {
        res.status(statusCode).json({
            error: err.name || 'Error',
            message: err.message,
            stack: err.stack
        });
    } else {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: err.name || 'Error',
            message: err.message,
            stack: err.stack
        }));
    }
}

module.exports = errorHandler;