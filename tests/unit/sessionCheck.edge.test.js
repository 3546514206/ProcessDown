'use strict';

// Edge-case supplements for the session-restore feature added in R1.
// The developer's sessionStore.test.js / api.test.js already cover the
// happy paths and the explicitly required branches (exists/not-exists/
// empty-history/invalid-id; check exists/not-exists/invalid-format/
// non-POST/missing-field). This file focuses on boundaries those tests
// miss: non-string id types beyond null/number, empty & whitespace
// sessionId, multi-round "last assistant" semantics, user-only history,
// response echo, and the documented corrupt-file recovery side effect.
// Tests here intentionally avoid overlapping with existing cases.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Patch GeneratorService.generate before createRouter so constructing the
// router (which news a GeneratorService) never reaches the network. None of
// these tests call generate; the patch is purely defensive for construction.
const GeneratorService = require('../../src/services/generator');
const originalGenerate = GeneratorService.prototype.generate;
GeneratorService.prototype.generate = async () => 'flowchart TD\n A-->B';

const createRouter = require('../../src/routes/api');
const { SessionStore } = require('../../src/services/sessionStore');

function createMockReq(method = 'POST', body = {}) {
    return { method, body, user: 'testuser' };
}

function createMockRes() {
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

describe('SessionStore.exists() - edge cases', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-exists-edge-'));
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    beforeEach(() => {
        for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, entry.name), { recursive: true, force: true });
        }
        store = new SessionStore({ session: { dir: tempDir, maxHistory: 20, ttlDays: 7 } });
    });

    it('should return false for object/array/boolean/NaN ids (not just null and number)', () => {
        // The existing suite only checks null/123/undefined. isValidId guards
        // with `typeof sessionId === 'string'`, so every non-string must be
        // rejected uniformly - covers the rest of the type space.
        assert.strictEqual(store.exists({}), false);
        assert.strictEqual(store.exists([]), false);
        assert.strictEqual(store.exists(false), false);
        assert.strictEqual(store.exists(true), false);
        assert.strictEqual(store.exists(NaN), false);
    });

    it('should return false for UUID-shaped strings with non-hex characters', () => {
        // Length is correct but 'g'/'z' are outside hex - must not slip past
        // isValidId into a filesystem stat on a derived path.
        assert.strictEqual(store.exists('550e8400-e29b-41d4-a716-44665544000g'), false);
        assert.strictEqual(store.exists('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'), false);
    });

    it('should return false for a UUID with hyphens in the wrong positions', () => {
        // Right character set and length, wrong grouping - still invalid.
        assert.strictEqual(store.exists('550e8400e29b41d4a716446655440000'), false);
        assert.strictEqual(store.exists('550e-8400-e29b-41d4-a716446655440000'), false);
    });
});

describe('POST /api/session/check - edge cases', () => {
    let tempDir;
    let sessionsDir;
    let config;
    let router;
    let seedStore;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-check-edge-'));
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        GeneratorService.prototype.generate = originalGenerate;
    });
    beforeEach(() => {
        for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, entry.name), { recursive: true, force: true });
        }
        config = {
            session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
            // 用户会话目录指向 tempDir，路由据此派生 tempDir/testuser/sessions/
            users: { dir: tempDir },
            llm: {
                baseUrl: 'http://fake', apiKey: 'fake-key', model: 'fake-model',
                temperature: 0.7, maxTokens: 1000, timeout: 30000
            },
            server: { port: 3000, timeout: 30000 },
            cors: { enabled: true, origins: ['*'] },
            rateLimit: { enabled: false, maxRequests: 100, windowMs: 60000 },
            auth: { enabled: false, tokenTtlDays: 7 },
            health: { checkLlm: false }
        };
        router = createRouter(config);
        // A second SessionStore over the SAME user sessions dir lets us seed
        // history directly with distinct assistant contents, instead of going
        // through the mocked generate route (which always returns the same
        // string). Must match the dir the router derives for req.user.
        sessionsDir = path.join(tempDir, 'testuser', 'sessions');
        seedStore = new SessionStore({ session: { dir: sessionsDir, maxHistory: 20, ttlDays: 7 } });
    });

    it('should return 400 "sessionId field is required" for an empty string', () => {
        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: '' }), res);
        assert.strictEqual(res.statusCode, 400);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.error, 'Validation Error');
        assert.strictEqual(body.message, '"sessionId" field is required');
    });

    it('should return 400 for a whitespace-only sessionId (trim-empty)', () => {
        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: '   \t  ' }), res);
        assert.strictEqual(res.statusCode, 400);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.message, '"sessionId" field is required');
    });

    it('should return 400 when sessionId is null (non-string)', () => {
        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: null }), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).message, '"sessionId" field is required');
    });

    it('should return 400 when sessionId is a number (non-string)', () => {
        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: 12345 }), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).message, '"sessionId" field is required');
    });

    it('should return 400 when sessionId key is absent from the body', () => {
        const res = createMockRes();
        router.checkSession(createMockReq('POST', { unrelated: 'x' }), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).message, '"sessionId" field is required');
    });

    it('should return 400 when req.body itself is undefined', () => {
        // parseBody always sets req.body, but the handler defends with
        // `req.body || {}` - assert that path does not throw.
        const res = createMockRes();
        router.checkSession({ method: 'POST', body: undefined }, res);
        assert.strictEqual(res.statusCode, 400);
    });

    it('should return the LAST assistant content when multiple rounds exist', () => {
        // The single-round existing test cannot distinguish "last" from
        // "first" assistant. Three rounds with distinct contents pin down
        // that the loop walks from the end.
        const id = '550e8400-e29b-41d4-a716-446655440000';
        seedStore.append(id, 'q1', 'a1-first');
        seedStore.append(id, 'q2', 'a2-second');
        seedStore.append(id, 'q3', 'a3-third');

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: id }), res);

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.exists, true);
        assert.strictEqual(body.lastMermaid, 'a3-third');
    });

    it('should return lastMermaid=null when history contains only user entries', () => {
        // No assistant message to render - the restore loop must fall through
        // to null rather than throw or return a user message as the diagram.
        const id = '550e8400-e29b-41d4-a716-446655440000';
        fs.mkdirSync(path.join(sessionsDir, id));
        fs.writeFileSync(path.join(sessionsDir, id, 'history.json'), JSON.stringify([
            { role: 'user', content: 'q1', ts: 1 },
            { role: 'user', content: 'q2', ts: 2 }
        ]));

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: id }), res);

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.exists, true);
        assert.strictEqual(body.lastMermaid, null);
    });

    it('should return lastMermaid=null when history is empty (no entries)', () => {
        // Distinct from "only user": a freshly-created session with `[]`.
        const id = seedStore.create();

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: id }), res);

        const body = JSON.parse(res.body);
        assert.strictEqual(body.exists, true);
        assert.strictEqual(body.lastMermaid, null);
    });

    it('should pick the last assistant even when a later user entry follows it', () => {
        // Real history ends each round with an assistant msg, but a hand-edited
        // or in-progress file could have a trailing user entry. The probe must
        // still return the most recent assistant, not be confused by the tail.
        const id = '550e8400-e29b-41d4-a716-446655440000';
        fs.mkdirSync(path.join(sessionsDir, id));
        fs.writeFileSync(path.join(sessionsDir, id, 'history.json'), JSON.stringify([
            { role: 'user', content: 'q1', ts: 1 },
            { role: 'assistant', content: 'a1', ts: 2 },
            { role: 'assistant', content: 'a2', ts: 3 },
            { role: 'user', content: 'q3-unsent', ts: 4 }
        ]));

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: id }), res);

        const body = JSON.parse(res.body);
        assert.strictEqual(body.lastMermaid, 'a2');
    });

    it('should echo the queried sessionId back verbatim in the response', () => {
        // The frontend sets state.sessionId = data.sessionId on restore, so the
        // echo must be the exact input (not a re-generated or lowercased id).
        const id = '550e8400-e29b-41d4-a716-446655440000';
        seedStore.append(id, 'q', 'a');

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: id }), res);

        const body = JSON.parse(res.body);
        assert.strictEqual(body.sessionId, id);
    });

    it('should echo an uppercase sessionId as-is and report exists=false when no matching folder exists', () => {
        // isValidId accepts mixed case; create() always emits lowercase, so an
        // uppercase query against an empty dir is exists=false. The echo keeps
        // the original case (what the frontend will store if it ever exists).
        const upperId = '550E8400-E29B-41D4-A716-446655440000';
        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: upperId }), res);

        const body = JSON.parse(res.body);
        assert.strictEqual(body.sessionId, upperId);
        assert.strictEqual(body.exists, false);
        assert.strictEqual(body.lastMermaid, null);
    });

    it('should return lastMermaid=null and reset the file when history.json is corrupt (documents current recovery side effect)', () => {
        // exists() is true (file present), so checkSession proceeds to
        // readHistory -> _loadRaw, which backs up and resets a corrupt file.
        // This is a write side effect during a nominally read-only "check";
        // recorded here so any future move to strict read-only semantics makes
        // the behavior change explicit. See developer R1 openIssues.
        const id = '550e8400-e29b-41d4-a716-446655440000';
        const historyPath = path.join(sessionsDir, id, 'history.json');
        fs.mkdirSync(path.join(sessionsDir, id));
        fs.writeFileSync(historyPath, 'not valid json');

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: id }), res);

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.exists, true);
        assert.strictEqual(body.lastMermaid, null);
        // File was reset to a valid empty array by _loadRaw's recovery path
        assert.strictEqual(fs.readFileSync(historyPath, 'utf-8'), '[]');
        // Original corrupt bytes were backed up, not lost
        const files = fs.readdirSync(path.join(sessionsDir, id));
        assert.ok(files.some(f => f.startsWith('history.json.corrupt-')), 'backup should exist');
    });
});
