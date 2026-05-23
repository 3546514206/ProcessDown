/**
 * Error Handler Middleware
 * Catches and formats errors, hides details in production
 */

const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
    // Log the error
    logger.error('Unhandled error:', err.message, 'stack:', err.stack);

    // Determine if we're in production
    const isProduction = process.env.NODE_ENV === 'production';

    // Don't expose details in production
    if (isProduction) {
        return res.status(500).json({
            error: 'Internal Server Error',
            message: 'An unexpected error occurred. Please try again later.'
        });
    }

    // Development: show more details
    res.status(err.status || 500).json({
        error: err.name || 'Error',
        message: err.message,
        stack: err.stack
    });
}

module.exports = errorHandler;