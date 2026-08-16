'use strict';

// Tests for POST /api/message/edit (在对话内直接编辑 Mermaid 代码并落盘)。
// 两组关注点：
//   handler 层：方法/参数校验、索引与角色校验、落盘结果；
//   wiring 层：路由必须在 PROTECTED_USER_ROUTES 内，且未带 Bearer 时被
//   authUser 拦在 handler 之前（与 protectedRoutes.edge.test.js 同一手法：
//   server/index.js require 即 listen，无法直接导入，故从源码正则提取）。

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { UserStore } = require('../../src/services/userStore');
const authUserMiddleware = require('../../src/middleware/authUser');

const GeneratorService = require('../../src/services/generator');
const originalGenerate = GeneratorService.prototype.generate;
GeneratorService.prototype.generate = async () => 'flowchart TD\n A-->B';
const createRouter = require('../../src/routes/api');

after(() => {
    GeneratorService.prototype.generate = originalGenerate;
});

function createMockReq(method = 'POST', body = {}, user = 'testuser', headers = {}) {
    return { method, body, user, headers };
}

function createMockRes() {
    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        headersSent: false,
        writeHead(code, headers) {
            res.statusCode = code;
            res.headers = { ...res.headers, ...headers };
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
        session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
        users: { dir: tempDir },
        llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.7, maxTokens: 1000, timeout: 30000 },
        server: { port: 3000, timeout: 30000 },
        cors: { enabled: true, origins: ['*'] },
        rateLimit: { enabled: false, maxRequests: 100, windowMs: 60000 },
        auth: { enabled: false, tokenTtlDays: 7 },
        health: { checkLlm: false }
    };
}

function historyPathFor(tempDir, user, sessionId) {
    return path.join(tempDir, user, 'sessions', sessionId, 'history.json');
}

function seedSession(tempDir, user, rounds) {
    // 直接落盘而不是走 generate：本文件只测编辑路径，绕开 LLM 与 SessionStore 缓存
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const dir = path.join(tempDir, user, 'sessions', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const entries = [];
    for (const [u, a] of rounds) {
        entries.push({ role: 'user', content: u, ts: 1 });
        entries.push({ role: 'assistant', content: a, ts: 1 });
    }
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(entries, null, 2));
    return sessionId;
}

describe('editMessage handler', () => {
    let tempDir;
    let router;
    let sessionId;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-edit-msg-'));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    beforeEach(() => {
        for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, entry.name), { recursive: true, force: true });
        }
        router = createRouter(makeConfig(tempDir));
        sessionId = seedSession(tempDir, 'testuser', [['画个登录流程', 'flowchart TD\n A-->B']]);
    });

    function edit(body, user = 'testuser') {
        const res = createMockRes();
        router.editMessage(createMockReq('POST', body, user), res);
        return res;
    }

    it('should return 405 for non-POST', () => {
        const res = createMockRes();
        router.editMessage(createMockReq('GET', {}), res);
        assert.strictEqual(res.statusCode, 405);
        assert.strictEqual(JSON.parse(res.body).error, 'Method Not Allowed');
    });

    it('should persist a valid edit and return 200 with ts', () => {
        const res = edit({ sessionId, messageIndex: 1, content: 'flowchart LR\n X-->Y' });

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.success, true);
        assert.ok(body.ts > 0);

        const entries = JSON.parse(fs.readFileSync(historyPathFor(tempDir, 'testuser', sessionId), 'utf-8'));
        assert.strictEqual(entries[1].content, 'flowchart LR\n X-->Y');
        assert.strictEqual(entries[0].content, '画个登录流程');
    });

    it('should save the edit verbatim (no extract/autoFix rewrite)', () => {
        // 用户手输内容含全角标点：generate 链路会自动修复，编辑链路不得改写
        const raw = 'flowchart TD\n A["中文，标点"]-->B';
        edit({ sessionId, messageIndex: 1, content: raw });
        const entries = JSON.parse(fs.readFileSync(historyPathFor(tempDir, 'testuser', sessionId), 'utf-8'));
        assert.strictEqual(entries[1].content, raw);
    });

    it('should return 400 for a missing or blank sessionId', () => {
        assert.strictEqual(edit({ messageIndex: 1, content: 'x' }).statusCode, 400);
        assert.strictEqual(edit({ sessionId: '   ', messageIndex: 1, content: 'x' }).statusCode, 400);
        assert.strictEqual(edit({ sessionId: 42, messageIndex: 1, content: 'x' }).statusCode, 400);
    });

    it('should return 400 for a malformed sessionId (path traversal)', () => {
        const res = edit({ sessionId: '../../etc/passwd', messageIndex: 1, content: 'x' });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(JSON.parse(res.body).message, 'Invalid sessionId format');
    });

    it('should return 400 for missing or non-string content', () => {
        assert.strictEqual(edit({ sessionId, messageIndex: 1 }).statusCode, 400);
        assert.strictEqual(edit({ sessionId, messageIndex: 1, content: null }).statusCode, 400);
        assert.strictEqual(edit({ sessionId, messageIndex: 1, content: { a: 1 } }).statusCode, 400);
    });

    it('should accept an empty content string (mid-edit clear)', () => {
        const res = edit({ sessionId, messageIndex: 1, content: '' });
        assert.strictEqual(res.statusCode, 200);
        const entries = JSON.parse(fs.readFileSync(historyPathFor(tempDir, 'testuser', sessionId), 'utf-8'));
        assert.strictEqual(entries[1].content, '');
    });

    it('should accept content exactly at the 64KB cap and reject above it', () => {
        const cap = 64 * 1024;
        assert.strictEqual(edit({ sessionId, messageIndex: 1, content: 'a'.repeat(cap) }).statusCode, 200);
        const res = edit({ sessionId, messageIndex: 1, content: 'a'.repeat(cap + 1) });
        assert.strictEqual(res.statusCode, 400);
        assert.match(JSON.parse(res.body).message, /64KB/);
    });

    it('should return 400 for out-of-range messageIndex', () => {
        assert.strictEqual(edit({ sessionId, messageIndex: -1, content: 'x' }).statusCode, 400);
        assert.strictEqual(edit({ sessionId, messageIndex: 2, content: 'x' }).statusCode, 400);
        assert.strictEqual(edit({ sessionId, messageIndex: 99, content: 'x' }).statusCode, 400);
    });

    it('should return 400 for a non-integer messageIndex', () => {
        assert.strictEqual(edit({ sessionId, content: 'x' }).statusCode, 400);
        assert.strictEqual(edit({ sessionId, messageIndex: '1', content: 'x' }).statusCode, 400);
        assert.strictEqual(edit({ sessionId, messageIndex: 1.5, content: 'x' }).statusCode, 400);
    });

    it('should return 400 when messageIndex points at a user message', () => {
        const res = edit({ sessionId, messageIndex: 0, content: 'forged prompt' });
        assert.strictEqual(res.statusCode, 400);
        assert.match(JSON.parse(res.body).message, /assistant/);
        const entries = JSON.parse(fs.readFileSync(historyPathFor(tempDir, 'testuser', sessionId), 'utf-8'));
        assert.strictEqual(entries[0].content, '画个登录流程');
    });

    it('should return 404 for a well-formed but unknown sessionId', () => {
        const res = edit({ sessionId: '11111111-2222-3333-4444-555555555555', messageIndex: 1, content: 'x' });
        assert.strictEqual(res.statusCode, 404);
        // 未知 id 不得留下空会话残骸（exists 是纯 stat 探测）
        assert.strictEqual(
            fs.existsSync(path.join(tempDir, 'testuser', 'sessions', '11111111-2222-3333-4444-555555555555')),
            false
        );
    });

    it('should handle a corrupted history.json without throwing (400, backup kept)', () => {
        const filePath = historyPathFor(tempDir, 'testuser', sessionId);
        fs.writeFileSync(filePath, 'not json at all');

        const res = edit({ sessionId, messageIndex: 1, content: 'x' });

        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf-8')), []);
        assert.ok(
            fs.readdirSync(path.dirname(filePath)).some(f => f.startsWith('history.json.corrupt-')),
            'corrupted history should be backed up'
        );
    });

    it('should edit the right round in a multi-round session', () => {
        const multi = seedSession(tempDir, 'testuser', []);
        fs.writeFileSync(historyPathFor(tempDir, 'testuser', multi), JSON.stringify([
            { role: 'user', content: 'u0', ts: 1 },
            { role: 'assistant', content: 'a0', ts: 1 },
            { role: 'user', content: 'u1', ts: 1 },
            { role: 'assistant', content: 'a1', ts: 1 }
        ]));

        assert.strictEqual(edit({ sessionId: multi, messageIndex: 1, content: 'a0-edited' }).statusCode, 200);
        const entries = JSON.parse(fs.readFileSync(historyPathFor(tempDir, 'testuser', multi), 'utf-8'));
        assert.deepStrictEqual(entries.map(e => e.content), ['u0', 'a0-edited', 'u1', 'a1']);
    });

    it('should not touch another user session that shares the same uuid', () => {
        // 同一个 uuid 在 bob 名下也存在：alice 的编辑必须只落到自己目录
        seedSession(tempDir, 'bob', [['bob prompt', 'bob mermaid']]);
        const alice = seedSession(tempDir, 'alice', [['alice prompt', 'alice mermaid']]);

        assert.strictEqual(
            edit({ sessionId: alice, messageIndex: 1, content: 'alice edited' }, 'alice').statusCode,
            200
        );

        const bobEntries = JSON.parse(fs.readFileSync(historyPathFor(tempDir, 'bob', alice), 'utf-8'));
        assert.strictEqual(bobEntries[1].content, 'bob mermaid');
    });
});

describe('editMessage wiring: /api/message/edit is behind authUser', () => {
    let tempDir;
    let router;
    let authUser;
    let token;
    let protectedRoutes;
    let sessionId;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-edit-wiring-'));
        router = createRouter(makeConfig(tempDir));
        const userStore = new UserStore({ users: { dir: tempDir }, auth: { tokenTtlDays: 7 } });
        authUser = authUserMiddleware(userStore);
        token = userStore.register('alice', 'secret123').token;
        userStore.register('bob', 'secret123');
        sessionId = seedSession(tempDir, 'alice', [['q', 'flowchart TD\n A-->B']]);

        const src = fs.readFileSync(path.join(__dirname, '../../src/server/index.js'), 'utf-8');
        const m = src.match(/PROTECTED_USER_ROUTES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
        assert.ok(m, 'PROTECTED_USER_ROUTES set literal not found in src/server/index.js');
        protectedRoutes = new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    // Mirrors server/index.js dispatch: protected routes run authUser first;
    // if it rejects (headersSent) the handler is skipped.
    function dispatch(req, res) {
        if (protectedRoutes.has('/api/message/edit')) {
            authUser(req, res, () => {});
            if (res.headersSent) return;
        }
        router.editMessage(req, res);
    }

    it('PROTECTED_USER_ROUTES includes /api/message/edit (wiring pinned to source)', () => {
        assert.ok(protectedRoutes.has('/api/message/edit'), '/api/message/edit must be protected');
    });

    it('server/index.js dispatches /api/message/edit to api.editMessage', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/server/index.js'), 'utf-8');
        assert.match(src, /case '\/api\/message\/edit':\s*\n\s*api\.editMessage\(req, res\);/);
    });

    it('returns 401 with no Bearer token (handler not reached)', () => {
        const res = createMockRes();
        dispatch({ method: 'POST', headers: {}, body: { sessionId, messageIndex: 1, content: 'x' } }, res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(JSON.parse(res.body).error, 'Unauthorized');
        // 历史未被改动
        const entries = JSON.parse(fs.readFileSync(historyPathFor(tempDir, 'alice', sessionId), 'utf-8'));
        assert.strictEqual(entries[1].content, 'flowchart TD\n A-->B');
    });

    it('returns 401 for a forged token', () => {
        const res = createMockRes();
        dispatch({
            method: 'POST',
            headers: { authorization: 'Bearer bob.deadbeef' },
            body: { sessionId, messageIndex: 1, content: 'x' }
        }, res);
        assert.strictEqual(res.statusCode, 401);
    });

    it('reaches the handler with a valid token', () => {
        const res = createMockRes();
        dispatch({
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: { sessionId, messageIndex: 1, content: 'edited by alice' }
        }, res);
        assert.strictEqual(res.statusCode, 200);
        const entries = JSON.parse(fs.readFileSync(historyPathFor(tempDir, 'alice', sessionId), 'utf-8'));
        assert.strictEqual(entries[1].content, 'edited by alice');
    });

    it('bob cannot edit alice session even when passing her sessionId', () => {
        // req.user 来自 token（authUser 注入），与请求体里的 sessionId 无关：
        // bob 的编辑只会落到 run/users/bob/sessions/ 下，alice 的历史不受影响。
        const bobStore = new UserStore({ users: { dir: tempDir }, auth: { tokenTtlDays: 7 } });
        const bobToken = bobStore.login('bob', 'secret123').token;

        const res = createMockRes();
        dispatch({
            method: 'POST',
            headers: { authorization: `Bearer ${bobToken}` },
            body: { sessionId, messageIndex: 1, content: 'hacked by bob' }
        }, res);

        // bob 名下没有这个会话 -> 404，且 alice 的文件原样
        assert.strictEqual(res.statusCode, 404);
        const entries = JSON.parse(fs.readFileSync(historyPathFor(tempDir, 'alice', sessionId), 'utf-8'));
        assert.strictEqual(entries[1].content, 'edited by alice');
    });
});
