'use strict';

// Edge-case supplements for the auth route handlers + authUser middleware (R1).
// auth.test.js covers happy paths and the required branches. This file fills
// the gaps the developer's suite missed:
//   - register/login missing-field & non-string bodies
//   - the login & logout 405 method checks (never tested)
//   - authUser header-shape boundaries (case, empty, non-string, no headers)
//   - cross-user session isolation (user A cannot reach user B's sessions)
// Tests here intentionally avoid overlapping with existing cases.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { UserStore } = require('../../src/services/userStore');
const authUserMiddleware = require('../../src/middleware/authUser');

// Patch GeneratorService.generate before requiring createRouter so router
// construction never reaches the network.
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

describe('authUser middleware - header shape boundaries', () => {
    let tempDir;
    let middleware;
    let token;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-authuser-edge-'));
        const userStore = new UserStore({ users: { dir: tempDir }, auth: { tokenTtlDays: 7 } });
        middleware = authUserMiddleware(userStore);
        token = userStore.register('alice', 'secret123').token;
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it('rejects a lowercase "bearer" scheme (prefix match is case-sensitive)', () => {
        const res = mockRes();
        middleware(mockReq('POST', { headers: { authorization: `bearer ${token}` } }), res, () => {});
        assert.strictEqual(res.statusCode, 401);
    });

    it('rejects "Bearer " with an empty token', () => {
        const res = mockRes();
        middleware(mockReq('POST', { headers: { authorization: 'Bearer ' } }), res, () => {});
        assert.strictEqual(res.statusCode, 401);
    });

    it('rejects a whitespace-only token after "Bearer "', () => {
        const res = mockRes();
        middleware(mockReq('POST', { headers: { authorization: 'Bearer    ' } }), res, () => {});
        assert.strictEqual(res.statusCode, 401);
    });

    it('rejects when the authorization header is not a string', () => {
        const res = mockRes();
        middleware(mockReq('POST', { headers: { authorization: 12345 } }), res, () => {});
        assert.strictEqual(res.statusCode, 401);
    });

    it('rejects when req.headers is undefined (defensive)', () => {
        const res = mockRes();
        middleware({ method: 'POST', headers: undefined }, res, () => {});
        assert.strictEqual(res.statusCode, 401);
    });

    it('trims internal whitespace around a valid token (e.g. "Bearer  <token>")', () => {
        let nextCalled = false;
        const req = mockReq('POST', { headers: { authorization: `Bearer  ${token}` } });
        middleware(req, mockRes(), () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(req.user, 'alice');
    });
});

describe('POST /api/auth/register - missing/non-string fields', () => {
    let tempDir;
    let router;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-reg-route-edge-'));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
        router = createRouter(makeConfig(tempDir));
    });

    it('returns 400 invalid_username when username is missing', () => {
        const res = mockRes();
        router.register(mockReq('POST', { body: { password: 'secret123' } }), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).error, 'invalid_username');
    });

    it('returns 400 invalid_password when password is missing', () => {
        const res = mockRes();
        router.register(mockReq('POST', { body: { username: 'alice' } }), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).error, 'invalid_password');
    });

    it('returns 400 invalid_username when body is undefined', () => {
        const res = mockRes();
        router.register({ method: 'POST', body: undefined }, res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).error, 'invalid_username');
    });

    it('returns 400 for non-string username/password in the body', () => {
        let res = mockRes();
        router.register(mockReq('POST', { body: { username: 123, password: 'secret123' } }), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).error, 'invalid_username');

        res = mockRes();
        router.register(mockReq('POST', { body: { username: 'alice', password: 123456 } }), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).error, 'invalid_password');
    });
});

describe('POST /api/auth/login - method and missing-field handling', () => {
    let tempDir;
    let router;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-login-route-edge-'));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
        router = createRouter(makeConfig(tempDir));
    });

    it('returns 405 for non-POST', () => {
        const res = mockRes();
        router.login(mockReq('GET', { body: {} }), res);
        assert.strictEqual(res.statusCode, 405);
    });

    it('returns 401 invalid_credentials for a non-existent user', () => {
        const res = mockRes();
        router.login(mockReq('POST', { body: { username: 'ghosts', password: 'secret123' } }), res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(JSON.parse(res.body).error, 'invalid_credentials');
    });

    it('returns 401 invalid_credentials when both fields are missing', () => {
        // username is undefined -> isValidUsername false -> rejected before
        // scryptSync, so this path is safe (unlike the non-string-password case).
        const res = mockRes();
        router.login(mockReq('POST', { body: {} }), res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(JSON.parse(res.body).error, 'invalid_credentials');
    });

    it('returns 401 invalid_credentials when password is non-string for an existing user', () => {
        // login() guards `typeof password !== 'string'` (symmetric with
        // register), so a non-string password for an existing user is rejected
        // with 401 invalid_credentials instead of reaching scryptSync and
        // throwing a TypeError that the outer try/catch would turn into a 500.
        router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), mockRes());
        const res = mockRes();
        router.login(mockReq('POST', { body: { username: 'alice', password: null } }), res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(JSON.parse(res.body).error, 'invalid_credentials');
    });
});

describe('POST /api/auth/logout - method handling', () => {
    let tempDir;
    let router;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-logout-route-edge-'));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
        router = createRouter(makeConfig(tempDir));
    });

    it('returns 405 for non-POST', () => {
        const res = mockRes();
        router.logout(mockReq('GET', { user: 'alice' }), res);
        assert.strictEqual(res.statusCode, 405);
    });

    it('succeeds (idempotent) even when req.user has no active session', () => {
        // logout always returns 200 success regardless of whether a session
        // existed - must not leak whether the username is registered.
        const res = mockRes();
        router.logout(mockReq('POST', { user: 'alice' }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(JSON.parse(res.body).success);
    });
});

describe('cross-user session isolation', () => {
    // The headline security property of the user feature: one user must never
    // read or overwrite another user's sessions. The developer's report asserts
    // this as a design consequence of sessionStoreFor(req) deriving the dir
    // from req.user, but no test exercised it. These do.
    let tempDir;
    let router;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-isolation-'));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
        router = createRouter(makeConfig(tempDir));
    });

    it('user A cannot probe user B\'s session via /api/session/check', async () => {
        router.register(mockReq('POST', { body: { username: 'bob', password: 'secret123' } }), mockRes());
        router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), mockRes());
        const bobId = '550e8400-e29b-41d4-a716-446655440000';
        await router.generate(
            mockReq('POST', { body: { prompt: 'bob-secret-chart', sessionId: bobId }, user: 'bob' }),
            mockRes()
        );

        // Alice asks for the same id: must report exists=false and must NOT
        // leak bob's last assistant content.
        const res = mockRes();
        router.checkSession(mockReq('POST', { body: { sessionId: bobId }, user: 'alice' }), res);
        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.exists, false, 'alice must not see bob\'s session');
        assert.strictEqual(body.lastMermaid, null);
        // And bob's folder is untouched (no side effect from alice's probe).
        assert.ok(fs.existsSync(path.join(tempDir, 'bob', 'sessions', bobId, 'history.json')));
    });

    it('user A\'s session list does not include user B\'s sessions', async () => {
        router.register(mockReq('POST', { body: { username: 'bob', password: 'secret123' } }), mockRes());
        router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), mockRes());
        const bobId = '550e8400-e29b-41d4-a716-446655440000';
        await router.generate(
            mockReq('POST', { body: { prompt: 'bob-private', sessionId: bobId }, user: 'bob' }),
            mockRes()
        );

        const res = mockRes();
        router.listSessions(mockReq('GET', { user: 'alice' }), res);
        const body = JSON.parse(res.body);
        assert.deepStrictEqual(body.sessions, [], 'alice must see zero sessions');
    });

    it('user A generating into user B\'s sessionId does not corrupt B\'s history', async () => {
        router.register(mockReq('POST', { body: { username: 'bob', password: 'secret123' } }), mockRes());
        router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), mockRes());
        const bobId = '550e8400-e29b-41d4-a716-446655440000';
        await router.generate(
            mockReq('POST', { body: { prompt: 'bob-original', sessionId: bobId }, user: 'bob' }),
            mockRes()
        );
        const bobHistoryPath = path.join(tempDir, 'bob', 'sessions', bobId, 'history.json');
        const bobHistoryBefore = fs.readFileSync(bobHistoryPath, 'utf-8');

        // Alice reuses the same id; this must create a SEPARATE session under
        // alice's own dir, never touch bob's file.
        await router.generate(
            mockReq('POST', { body: { prompt: 'alice-intrusion', sessionId: bobId }, user: 'alice' }),
            mockRes()
        );

        assert.strictEqual(
            fs.readFileSync(bobHistoryPath, 'utf-8'), bobHistoryBefore,
            'bob\'s history must be untouched'
        );
        const aliceHistoryPath = path.join(tempDir, 'alice', 'sessions', bobId, 'history.json');
        assert.ok(fs.existsSync(aliceHistoryPath), 'alice should have her own copy under her dir');
        const aliceHistory = JSON.parse(fs.readFileSync(aliceHistoryPath, 'utf-8'));
        assert.strictEqual(aliceHistory[0].content, 'alice-intrusion');
    });

    it('createSession is scoped to req.user and never lands in another user\'s dir', () => {
        router.register(mockReq('POST', { body: { username: 'alice', password: 'secret123' } }), mockRes());
        const res = mockRes();
        router.createSession(mockReq('POST', { user: 'alice' }), res);
        const sessionId = JSON.parse(res.body).sessionId;

        assert.ok(
            fs.existsSync(path.join(tempDir, 'alice', 'sessions', sessionId, 'history.json')),
            'session must land under alice\'s dir'
        );
        assert.strictEqual(
            fs.existsSync(path.join(tempDir, 'bob')), false,
            'no bob directory should be created'
        );
    });
});
