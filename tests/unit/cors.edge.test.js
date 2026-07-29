'use strict';

// R2-3 regression: CORS Access-Control-Allow-Headers must include Authorization.
// In R1 the header list was 'Content-Type, X-API-Key' only, so a cross-domain
// deployment's preflight would reject the Bearer header and break login. These
// tests pin that Authorization is present (for both normal and OPTIONS
// preflight requests) against an allowed cross-origin request.

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const corsMiddleware = require('../../src/middleware/cors');

// cors.js uses res.setHeader (not writeHead) to attach the CORS headers, so
// this mock supports both setHeader/getHeader and the writeHead/end pair used
// for the 403 blocked path and the 204 preflight path.
function mockRes() {
    const headers = {};
    const res = {
        statusCode: 200,
        body: null,
        headersSent: false,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        getHeader(k) { return headers[k.toLowerCase()]; },
        writeHead(code, h) {
            res.statusCode = code;
            if (h) for (const k in h) headers[k.toLowerCase()] = h[k];
            res.headersSent = true;
        },
        end(data) {
            res.body = data;
            res.headersSent = true;
        }
    };
    return res;
}

describe('R2-3: CORS Allow-Headers includes Authorization', () => {
    // An allowed cross-origin: origin is in the whitelist and differs from the
    // request host, so the middleware actually attaches CORS headers (same-origin
    // and un-whitelisted origins short-circuit before setting them).
    const config = { cors: { origins: ['http://example.com'] } };
    let cors;

    before(() => {
        cors = corsMiddleware(config);
    });

    function crossOriginReq(method = 'GET') {
        return {
            method,
            url: '/api/auth/login',
            headers: { origin: 'http://example.com', host: 'api.local' }
        };
    }

    it('sets Access-Control-Allow-Headers containing Authorization for an allowed cross-origin request', () => {
        const res = mockRes();
        cors(crossOriginReq('GET'), res, () => {});
        const allowHeaders = res.getHeader('access-control-allow-headers');
        assert.ok(allowHeaders, 'Allow-Headers must be set for an allowed cross-origin request');
        assert.ok(allowHeaders.includes('Authorization'), 'Allow-Headers must contain Authorization');
    });

    it('includes Authorization in the OPTIONS preflight response (204)', () => {
        const res = mockRes();
        cors(crossOriginReq('OPTIONS'), res, () => {});
        assert.strictEqual(res.statusCode, 204, 'preflight must short-circuit with 204');
        const allowHeaders = res.getHeader('access-control-allow-headers');
        assert.ok(allowHeaders && allowHeaders.includes('Authorization'),
            'preflight Allow-Headers must contain Authorization');
    });

    it('preserves Content-Type and X-API-Key alongside Authorization in Allow-Headers', () => {
        const res = mockRes();
        cors(crossOriginReq('GET'), res, () => {});
        const allowHeaders = res.getHeader('access-control-allow-headers');
        assert.ok(allowHeaders.includes('Content-Type'), 'Content-Type must remain in Allow-Headers');
        assert.ok(allowHeaders.includes('X-API-Key'), 'X-API-Key must remain in Allow-Headers');
        assert.ok(allowHeaders.includes('Authorization'), 'Authorization must be added');
    });
});
