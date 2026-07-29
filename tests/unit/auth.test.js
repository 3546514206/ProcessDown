'use strict';

// Tests for the user-auth layer: the authUser middleware (Bearer token
// extraction -> req.user) and the /api/auth/* + /api/sessions route handlers.
// The middleware is tested in isolation against a real UserStore; the route
// handlers are tested through the router with req.user mocked (mirroring how
// authUser would have set it in the live server).

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { UserStore } = require('../../src/services/userStore');
const authUserMiddleware = require('../../src/middleware/authUser');

// Patch GeneratorService so createRouter construction never reaches the network.
const GeneratorService = require('../../src/services/generator');
const originalGenerate = GeneratorService.prototype.generate;
GeneratorService.prototype.generate = async () => 'flowchart TD\n A-->B';

const createRouter = require('../../src/routes/api');

// Restore the prototype once at the very end of the file (node:test runs a
// top-level after() after all describes). Per-describe restores broke the
// mock for later describes, letting generate hit the real LLM.
after(() => {
    GeneratorService.prototype.generate = originalGenerate;
});

function mockReq(method, { headers = {}, body = {}, user } = {}) {
    return { method, headers, body, user };
}

function mockRes() {
    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        writeHead(code, headers) {
            res.statusCode = code;
            res.headers = { ...res.headers, ...headers };
        },
        end(data) { res.body = data; }
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

describe('authUser middleware', () => {
    let tempDir;
    let userStore;
    let middleware;
    let token;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-authuser-'));
        userStore = new UserStore({ users: { dir: tempDir }, auth: { tokenTtlDays: 7 } });
        middleware = authUserMiddleware(userStore);
        token = userStore.register('alice', 'secret123').token;
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('sets req.user and calls next() for a valid Bearer token', () => {
        let nextCalled = false;
        const req = mockReq('POST', { headers: { authorization: `Bearer ${token}` } });
        const res = mockRes();
        middleware(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(req.user, 'alice');
    });

    it('returns 401 when Authorization header is missing', () => {
        const req = mockReq('POST', { headers: {} });
        const res = mockRes();
        middleware(req, res, () => {});
        assert.strictEqual(res.statusCode, 401);
        assert.ok(JSON.parse(res.body).message);
    });

    it('returns 401 for a non-Bearer scheme', () => {
        const req = mockReq('POST', { headers: { authorization: `Basic ${token}` } });
        const res = mockRes();
        middleware(req, res, () => {});
        assert.strictEqual(res.statusCode, 401);
    });

    it('returns 401 for an invalid token', () => {
        const req = mockReq('POST', { headers: { authorization: 'Bearer alice.deadbeef' } });
        const res = mockRes();
        middleware(req, res, () => {});
        assert.strictEqual(res.statusCode, 401);
    });

    it('returns 401 for a logged-out token', () => {
        userStore.logout('alice');
        const req = mockReq('POST', { headers: { authorization: `Bearer ${token}` } });
        const res = mockRes();
        middleware(req, res, () => {});
        assert.strictEqual(res.statusCode, 401);
    });
});

describe('/api/auth/* route handlers', () => {
    let tempDir;
    let config;
    let router;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-auth-routes-'));
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
        config = makeConfig(tempDir);
        router = createRouter(config);
    });

    describe('POST /api/auth/register', () => {
        it('registers and returns a token', () => {
            const res = mockRes();
            router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), res);
            assert.strictEqual(res.statusCode, 200);
            const body = JSON.parse(res.body);
            assert.ok(body.success);
            assert.ok(body.token.startsWith('alice.'));
            assert.strictEqual(body.username, 'alice');
        });

        it('returns 400 for an invalid username', () => {
            const res = mockRes();
            router.register(mockReq('POST', { body: { username: 'ab', password: 'secret123' } }), res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(JSON.parse(res.body).error, 'invalid_username');
        });

        it('returns 400 for a short password', () => {
            const res = mockRes();
            router.register(mockReq('POST', { body: { username: 'alice', password: '12345' } }), res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(JSON.parse(res.body).error, 'invalid_password');
        });

        it('returns 409 for a duplicate username', () => {
            router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), mockRes());
            const res = mockRes();
            router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), res);
            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(JSON.parse(res.body).error, 'user_exists');
        });

        it('returns 405 for non-POST', () => {
            const res = mockRes();
            router.register(mockReq('GET', { body: {} }), res);
            assert.strictEqual(res.statusCode, 405);
        });
    });

    describe('POST /api/auth/login', () => {
        it('logs in and returns a token', () => {
            router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), mockRes());
            const res = mockRes();
            router.login(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), res);
            assert.strictEqual(res.statusCode, 200);
            const body = JSON.parse(res.body);
            assert.ok(body.token.startsWith('alice.'));
        });

        it('returns 401 for wrong password', () => {
            router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), mockRes());
            const res = mockRes();
            router.login(mockReq('POST', { body: { username: 'alice', password: 'wrong' } }), res);
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(JSON.parse(res.body).error, 'invalid_credentials');
        });
    });

    describe('GET /api/auth/me', () => {
        it('echoes the authenticated username', () => {
            const res = mockRes();
            router.me(mockReq('GET', { user: 'alice' }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(JSON.parse(res.body).username, 'alice');
        });

        it('returns 405 for non-GET', () => {
            const res = mockRes();
            router.me(mockReq('POST', { user: 'alice' }), res);
            assert.strictEqual(res.statusCode, 405);
        });
    });

    describe('POST /api/auth/logout', () => {
        it('clears the session and returns success', () => {
            // Register to establish a token, then logout via the handler
            const reg = mockRes();
            router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), reg);
            const res = mockRes();
            router.logout(mockReq('POST', { user: 'alice' }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.ok(JSON.parse(res.body).success);
        });
    });

    describe('GET /api/sessions', () => {
        it('lists the user sessions with summaries', async () => {
            // Register, then seed a session via generate (which persists history)
            router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), mockRes());
            const genReq = mockReq('POST', {
                body: { prompt: '画一个登录流程', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
                user: 'alice'
            });
            // generate is async: must await so append lands before listSessions reads
            await router.generate(genReq, mockRes());

            const res = mockRes();
            router.listSessions(mockReq('GET', { user: 'alice' }), res);
            assert.strictEqual(res.statusCode, 200);
            const body = JSON.parse(res.body);
            assert.strictEqual(body.sessions.length, 1);
            assert.strictEqual(body.sessions[0].sessionId, '550e8400-e29b-41d4-a716-446655440000');
            assert.strictEqual(body.sessions[0].summary, '画一个登录流程');
        });

        it('returns an empty list for a user with no sessions', () => {
            router.register(mockReq('POST', { body: { username: 'bob', password: 'secret123' } }), mockRes());
            const res = mockRes();
            router.listSessions(mockReq('GET', { user: 'bob' }), res);
            assert.deepStrictEqual(JSON.parse(res.body).sessions, []);
        });

        it('returns 405 for non-GET', () => {
            const res = mockRes();
            router.listSessions(mockReq('POST', { user: 'alice' }), res);
            assert.strictEqual(res.statusCode, 405);
        });
    });
});

describe('auth round-trip: register -> me -> sessions -> logout', () => {
    let tempDir;
    let router;
    let userStore;
    let middleware;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-auth-roundtrip-'));
        const config = makeConfig(tempDir);
        router = createRouter(config);
        // A separate UserStore/middleware instance mirrors how server/index.js
        // wires them: same config => same on-disk store.
        userStore = new UserStore({ users: { dir: tempDir }, auth: { tokenTtlDays: 7 } });
        middleware = authUserMiddleware(userStore);
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('full flow works end-to-end through middleware + handlers', () => {
        // 1. register
        const regRes = mockRes();
        router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), regRes);
        const token = JSON.parse(regRes.body).token;

        // 2. middleware accepts the token and sets req.user
        const meReq = mockReq('GET', { headers: { authorization: `Bearer ${token}` } });
        const meRes = mockRes();
        let nextCalled = false;
        middleware(meReq, meRes, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(meReq.user, 'alice');

        // 3. me handler echoes it
        router.me(meReq, meRes);
        assert.strictEqual(JSON.parse(meRes.body).username, 'alice');

        // 4. logout invalidates the token
        const outRes = mockRes();
        router.logout(mockReq('POST', { user: 'alice' }), outRes);
        assert.ok(JSON.parse(outRes.body).success);

        // 5. middleware now rejects the same token
        const reReq = mockReq('GET', { headers: { authorization: `Bearer ${token}` } });
        const reRes = mockRes();
        middleware(reReq, reRes, () => {});
        assert.strictEqual(reRes.statusCode, 401);
    });
});
