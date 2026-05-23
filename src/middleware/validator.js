/**
 * Request Validator Middleware
 * Validates request body size and input length
 */

const logger = require('../utils/logger');

// Max request body size (1MB)
const MAX_BODY_SIZE = 1024 * 1024;

// Max prompt length (5000 chars)
const MAX_PROMPT_LENGTH = 5000;

function validatorMiddleware(req, res, next) {
    // Check Content-Type for API routes
    if (req.path.startsWith('/api/') && req.method === 'POST') {
        const contentType = req.headers['content-type'] || '';

        if (!contentType.includes('application/json')) {
            return res.status(415).json({
                error: 'Unsupported Media Type',
                message: 'Content-Type must be application/json'
            });
        }
    }

    // Check body size
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > MAX_BODY_SIZE) {
        logger.warn('Request body too large', req.path, 'size:', contentLength);
        return res.status(413).json({
            error: 'Payload Too Large',
            message: 'Request body exceeds 1MB limit'
        });
    }

    // Validate prompt length in body
    if (req.method === 'POST' && req.path === '/api/generate') {
        // Body will be parsed by JSON parser middleware, validate after
        // This is handled in the route handler after body parsing
    }

    next();
}

/**
 * Validate generate request body
 */
function validateGenerateRequest(body) {
    const errors = [];

    if (!body) {
        errors.push('Request body is required');
        return { valid: false, errors };
    }

    if (!body.prompt && !body.mermaid) {
        errors.push('Either "prompt" or "mermaid" field is required');
    }

    if (body.prompt && typeof body.prompt !== 'string') {
        errors.push('"prompt" must be a string');
    }

    if (body.mermaid && typeof body.mermaid !== 'string') {
        errors.push('"mermaid" must be a string');
    }

    if (body.prompt && body.prompt.length > MAX_PROMPT_LENGTH) {
        errors.push(`"prompt" exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
    }

    if (body.mermaid && body.mermaid.length > MAX_PROMPT_LENGTH) {
        errors.push(`"mermaid" exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    validatorMiddleware,
    validateGenerateRequest,
    MAX_PROMPT_LENGTH
};