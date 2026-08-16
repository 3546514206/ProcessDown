'use strict';

// R2 regression tests for the auth wiring R1 left uncovered (crosscheck
// section 7). Two concerns:
//   R2-1: /api/export/png and /api/regenerate are now behind authUser. In R1
//         the "画图需先登录" requirement was only partially met (generate was
//         protected, these two were not). Tests pin the PROTECTED_USER_ROUTES
//         membership to the source and exercise the real authUser + router
//         dispatch for both the 401-no-token and valid-token-reaches-handler
//         paths.
//   R2-4: auth.js skips /api/auth/* so setting API_AUTH_KEY no longer breaks
//         browser register/login, while non-auth routes still require X-API-Key.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { UserStore } = require('../../src/services/userStore');
const authUserMiddleware = require('../../src/middleware/authUser');
const authMiddleware = require('../../src/middleware/auth');

// Patch GeneratorService.generate before requiring createRouter so router
// construction never reaches the network (matches auth.test.js pattern).
const GeneratorService = require('../../src/services/generator');
const originalGenerate = GeneratorService.prototype.generate;
GeneratorService.prototype.generate = async () => 'flowchart TD\n A-->B';
const createRouter = require('../../src/routes/api');

after(() => {
    GeneratorService.prototype.generate = originalGenerate;
});

function mockReq(method, { headers = {}, body = {}, user } = {}) {
    return { method, headers, body, user };
}

// Like the existing mockRes but tracks headersSent, which is how server/index.js
// decides whether authUser already rejected the request (and the handler must
// be skipped). Native http.ServerResponse sets headersSent=true on writeHead.
function mockRes() {
    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        headersSent: false,
        writeHead(code, h) {
            res.statusCode = code;
            if (h) Object.assign(res.headers, h);
            res.headersSent = true;
        },
        end(data) {
            res.body = data;
            res.headersSent = true;
        }
    };
    return res;
}

function makeConfig(tempDir) {
    return {
        users: { dir: tempDir },
        session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
        llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.3, maxTokens: 100, timeout: 30 },
        server: { port: 3000, timeout: 30 },
        cors: { enabled: true, origins: ['*'] },
        rateLimit: { enabled: false, maxRequests: 100, windowMs: 60000 },
        auth: { enabled: false, tokenTtlDays: 7 },
        health: { checkLlm: false }
    };
}

// PROTECTED_USER_ROUTES is a module-internal const in server/index.js (not
// exported) and the server bootstraps + binds a port on require, so we cannot
// import it. Instead we pin membership to the source text. If someone removes
// a route from the set, this extraction drops it and the wiring test fails.
function readProtectedRoutes() {
    const src = fs.readFileSync(path.join(__dirname, '../../src/server/index.js'), 'utf-8');
    const m = src.match(/PROTECTED_USER_ROUTES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, 'PROTECTED_USER_ROUTES set literal not found in src/server/index.js');
    return new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
}

describe('R2-1: /api/export/png and /api/regenerate are protected by authUser', () => {
    let protectedRoutes;
    let tempDir;
    let router;
    let authUser;
    let token;

    before(() => {
        protectedRoutes = readProtectedRoutes();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r2-protected-'));
        const config = makeConfig(tempDir);
        router = createRouter(config);
        // A separate UserStore over the same tempDir mirrors how server/index.js
        // wires them: same config => same on-disk store.
        const userStore = new UserStore({ users: { dir: tempDir }, auth: { tokenTtlDays: 7 } });
        authUser = authUserMiddleware(userStore);
        token = userStore.register('alice', 'secret123').token;
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    // Mirrors server/index.js's dispatch for these routes: protected routes
    // run authUser first; if it rejects (headersSent), the handler is skipped.
    async function dispatch(pathname, req, res) {
        if (protectedRoutes.has(pathname)) {
            authUser(req, res, () => {});
            if (res.headersSent) return;
        }
        if (pathname === '/api/export/png') {
            await router.exportPng(req, res);
        } else if (pathname === '/api/regenerate') {
            await router.regenerate(req, res);
        }
    }

    it('PROTECTED_USER_ROUTES includes both routes (wiring pinned to source)', () => {
        assert.ok(protectedRoutes.has('/api/export/png'), '/api/export/png must be protected');
        assert.ok(protectedRoutes.has('/api/regenerate'), '/api/regenerate must be protected');
    });

    // diagram 路径含 :id 动态段，Set 无法承载，对应 PROTECTED_USER_ROUTE_PATTERNS 正则列表。
    // 这里直接对源文本做断言，保证正则始终覆盖 /api/session/:id/diagram。
    // 必须跳过注释里第一次出现的 PROTECTED_USER_ROUTE_PATTERNS，定位到 const 声明的 [。
    // 按数组字面量的中括号闭合进行栈式扫描，避开嵌套 /.../ 字面量
    it('PROTECTED_USER_ROUTE_PATTERNS covers /api/session/:id/diagram (wiring pinned to source)', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/server/index.js'), 'utf-8');
        const start = src.indexOf('const PROTECTED_USER_ROUTE_PATTERNS');
        assert.ok(start >= 0, 'PROTECTED_USER_ROUTE_PATTERNS declaration not found');
        const open = src.indexOf('[', start);
        assert.ok(open >= 0, 'opening [ not found');
        let depth = 0;
        let close = -1;
        for (let i = open; i < src.length; i++) {
            if (src[i] === '[') depth++;
            else if (src[i] === ']') {
                depth--;
                if (depth === 0) { close = i; break; }
            }
        }
        assert.ok(close > open, 'matching ] not found');
        const block = src.slice(open, close + 1);
        // block 是形如 "[\n    /^\/api\/session\/[^/]+\/diagram$/\n]" 的文本。源里的
        // 字面量 `[^/]+` 含 `/`，与 assert.match 的正则 `[^/]+` 互相吞噬，故改用子串包含
        assert.ok(block.includes('/api/session/[^/]+/diagram') || block.includes('\\/api\\/session\\/[^/]+\\/diagram'),
            'diagram route regex pattern must be present in the protected list');
    });

    it('returns 401 for /api/export/png with no Bearer token (handler not reached)', async () => {
        const res = mockRes();
        await dispatch('/api/export/png', mockReq('POST', { body: {} }), res);
        assert.strictEqual(res.statusCode, 401);
        // If protection regressed, the handler would return 400 "svg required"
        // for the empty body - not authUser's 401 Unauthorized.
        assert.strictEqual(JSON.parse(res.body).error, 'Unauthorized');
    });

    it('reaches /api/export/png with a valid token (handler returns 400 for missing svg, not 401)', async () => {
        const res = mockRes();
        await dispatch(
            '/api/export/png',
            mockReq('POST', { headers: { authorization: `Bearer ${token}` }, body: {} }),
            res
        );
        assert.notStrictEqual(res.statusCode, 401);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).message, '"svg" field is required');
    });

    it('returns 401 for /api/regenerate with no Bearer token (handler not reached)', async () => {
        const res = mockRes();
        await dispatch('/api/regenerate', mockReq('POST', { body: {} }), res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(JSON.parse(res.body).error, 'Unauthorized');
    });

    it('reaches /api/regenerate with a valid token (handler returns 400 for missing fields, not 401)', async () => {
        const res = mockRes();
        await dispatch(
            '/api/regenerate',
            mockReq('POST', { headers: { authorization: `Bearer ${token}` }, body: {} }),
            res
        );
        assert.notStrictEqual(res.statusCode, 401);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).message, '"mermaid" and "instruction" fields are required');
    });
});

describe('R2-4: auth.js skips /api/auth/* so API_AUTH_KEY does not break login', () => {
    let tempDir;
    let router;
    let auth;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r2-authskip-'));
        router = createRouter(makeConfig(tempDir));
        // API_AUTH_KEY enabled: this is the config that previously 401'd login
        // because apiFetch does not send X-API-Key.
        auth = authMiddleware({ auth: { enabled: true, apiKey: 'service-key' } });
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    function reqTo(url, method = 'POST', body = {}) {
        return { url, method, headers: { host: 'localhost:3000' }, body };
    }

    it('lets /api/auth/register through with no X-API-Key', () => {
        let nextCalled = false;
        auth(reqTo('/api/auth/register'), mockRes(), () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
    });

    it('lets /api/auth/login through with no X-API-Key', () => {
        let nextCalled = false;
        auth(reqTo('/api/auth/login'), mockRes(), () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
    });

    it('still requires X-API-Key for non-auth routes (/api/generate) when API_AUTH_KEY is set', () => {
        // Confirms R2-4 narrowed the skip to /api/auth/* and did not disable
        // the API-Key layer for the rest of the API.
        let nextCalled = false;
        const res = mockRes();
        auth(reqTo('/api/generate'), res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res.statusCode, 401);
    });

    it('end-to-end: register returns 200 with no X-API-Key when API_AUTH_KEY is set', () => {
        const req = reqTo('/api/auth/register', 'POST', { username: 'alice', password: 'secret123' });
        const res = mockRes();
        auth(req, res, () => {});
        if (!res.headersSent) router.register(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(JSON.parse(res.body).token, 'register should succeed and return a token');
    });

    it('end-to-end: login returns 200 with no X-API-Key when API_AUTH_KEY is set', () => {
        // Seed a registered user directly via the handler (auth skip already
        // proven above), then run login through auth + handler.
        router.register(mockReq('POST', { body: { username: 'bob', password: 'secret123' } }), mockRes());
        const req = reqTo('/api/auth/login', 'POST', { username: 'bob', password: 'secret123' });
        const res = mockRes();
        auth(req, res, () => {});
        if (!res.headersSent) router.login(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(JSON.parse(res.body).token, 'login should succeed and return a token');
    });
});
