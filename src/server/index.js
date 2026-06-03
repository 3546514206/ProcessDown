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
const corsMiddleware = require('../middleware/cors');
const rateLimitMiddleware = require('../middleware/rateLimit');
const { validatorMiddleware } = require('../middleware/validator');
const errorHandler = require('../middleware/errorHandler');
const createApiRouter = require('../routes/api');

// Load configuration
const config = getConfig();

// Set log level from config
logger.setLevel(config.logging.level);

// Create middleware chain
const auth = authMiddleware(config);
const cors = corsMiddleware(config);
const rateLimit = rateLimitMiddleware(config);
const validator = validatorMiddleware;

// API router
const api = createApiRouter(config);

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
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            // Prevent excessive body size already handled by validator
        });
        req.on('end', () => {
            try {
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
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    return;
                }
            }

            // API routing
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