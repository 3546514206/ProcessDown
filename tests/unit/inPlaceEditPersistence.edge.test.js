'use strict';

/**
 * In-place editing — server-side persistence & multi-round isolation tests.
 *
 * 覆盖目标（api.js / sessionStore.js 的 edit-persistence 行为）：
 *
 *   1) 编辑 round 3 不污染 round 1/2：history.json 是按 round 追加的不可变审计轨迹；
 *      diagram.json 是当前规范覆盖层。PATCH /diagram 只动 diagram.json，history 完全不动
 *
 *   2) 跨用户隔离：alice 的 edit 不能写到 bob 的 diagram.json（sessionStoreFor(req) 按
 *      req.user 派生目录）
 *
 *   3) 大小边界：超过 200KB 的 code 被 400 拒绝（但小到 0 字符允许——空 code 等于清空覆盖层）
 *
 *   4) 多轮并发：连续多轮 generate + 多次 edit，diagrams 与 historys 各自正确隔离，
 *      checkSession 在每轮都返回最新覆盖层
 *
 *   5) checkSession 的图优先语义：diagram.json 是 canonical，history 只是审计轨迹，
 *      已 edit 的会话永远通过 diagram 派生 lastMermaid
 *
 * 复用 diagramPersistence.edge.test.js 的 mock 风格（mockReq/mockRes + real createRouter）。
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GeneratorService = require('../../src/services/generator');
const originalGenerate = GeneratorService.prototype.generate;
const originalGenerateStream = GeneratorService.prototype.generateStream;

// round-robin mock: round N 返回不同的 mermaid，覆盖多轮场景
// 由于每个 describe 的 after() 会恢复原 prototype，helper 需在每次 before() 重新 patch
let roundCounter = 0;
function installGeneratorMocks() {
    GeneratorService.prototype.generate = async () => {
        roundCounter += 1;
        return `flowchart TD\n    Round${roundCounter}A-->Round${roundCounter}B`;
    };
    GeneratorService.prototype.generateStream = async (_prompt, _current, _history, hooks) => {
        roundCounter += 1;
        const mermaid = `flowchart TD\n    Round${roundCounter}A-->Round${roundCounter}B`;
        if (hooks && hooks.onContent) hooks.onContent(mermaid);
        if (hooks && hooks.onDone) hooks.onDone({ mermaid, fixes: [], extracted: true });
    };
}
installGeneratorMocks();

const createRouter = require('../../src/routes/api');
const { SessionStore } = require('../../src/services/sessionStore');

function mockRes() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        writeHead(code, h) {
            this.statusCode = code;
            if (h) Object.assign(this.headers, h);
        },
        end(data) { this.body = data; }
    };
}

function mockStreamRes() {
    return {
        statusCode: 200,
        headers: {},
        chunks: [],
        writableEnded: false,
        writeHead(code, h) {
            this.statusCode = code;
            if (h) Object.assign(this.headers, h);
        },
        write(data) { if (!this.writableEnded) this.chunks.push(String(data)); },
        end(data) { if (data) this.chunks.push(String(data)); this.writableEnded = true; }
    };
}

function makeConfig(tempDir) {
    return {
        session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
        users: { dir: tempDir },
        llm: { baseUrl: 'http://fake', apiKey: 'fake-key', model: 'fake-model', temperature: 0.7, maxTokens: 1000, timeout: 30000 },
        server: { port: 3000, timeout: 30000 },
        cors: { enabled: true, origins: ['*'] },
        rateLimit: { enabled: false, maxRequests: 100, windowMs: 60000 },
        auth: { enabled: false, tokenTtlDays: 7 },
        health: { checkLlm: false }
    };
}

describe('in-place edit: multi-round history isolation', () => {
    let tempDir;
    let router;
    let sessionsDir;
    const ID = '550e8400-e29b-41d4-a716-446655440000';

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-edit-multiround-'));
        router = createRouter(makeConfig(tempDir));
        sessionsDir = path.join(tempDir, 'testuser', 'sessions');
        roundCounter = 0;
        installGeneratorMocks();
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        GeneratorService.prototype.generate = originalGenerate;
        GeneratorService.prototype.generateStream = originalGenerateStream;
    });

    function mockReq(method, url, body) {
        return {
            method, url, body, user: 'testuser',
            on() { return this; }
        };
    }

    async function runGenerateRound(prompt) {
        const res = mockRes();
        await router.generate(mockReq('POST', '/api/generate', { prompt, sessionId: ID }), res);
        assert.strictEqual(res.statusCode, 200, `generate round for "${prompt}" should succeed`);
    }

    it('three rounds produce three history entries AND three diagram writes', async () => {
        await runGenerateRound('round 1 prompt');
        await runGenerateRound('round 2 prompt');
        await runGenerateRound('round 3 prompt');

        const dir = path.join(sessionsDir, ID);
        // history.json contains 6 entries (3 user + 3 assistant)
        const history = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf-8'));
        assert.strictEqual(history.length, 6);
        const userPrompts = history.filter(h => h.role === 'user').map(h => h.content);
        assert.deepStrictEqual(userPrompts, ['round 1 prompt', 'round 2 prompt', 'round 3 prompt']);

        // diagram.json was overwritten on each round to the latest LLM output
        const diagram = JSON.parse(fs.readFileSync(path.join(dir, 'diagram.json'), 'utf-8'));
        assert.strictEqual(diagram.code, 'flowchart TD\n    Round3A-->Round3B',
            'diagram.json reflects the LAST generate round');
    });

    it('PATCH diagram.json for round 3 leaves rounds 1 and 2 history entries intact', async () => {
        const dir = path.join(sessionsDir, ID);
        const historyBefore = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf-8'));

        const res = mockRes();
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`,
            { code: 'flowchart LR\nHAND_EDITED' }), res);
        assert.strictEqual(res.statusCode, 200);

        const historyAfter = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf-8'));
        assert.deepStrictEqual(historyAfter, historyBefore,
            'PATCH /diagram must not touch history.json — audit trail is immutable');

        const diagram = JSON.parse(fs.readFileSync(path.join(dir, 'diagram.json'), 'utf-8'));
        assert.strictEqual(diagram.code, 'flowchart LR\nHAND_EDITED');
    });

    it('checkSession returns the edited diagram as lastMermaid while history still shows raw rounds', async () => {
        const res = mockRes();
        router.checkSession(mockReq('POST', '/api/session/check', { sessionId: ID }), res);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.lastMermaid, 'flowchart LR\nHAND_EDITED',
            'lastMermaid is the edited diagram, NOT the latest LLM round');

        // history survives as-is: last assistant in history is still the LLM round 3 output
        const lastAssistant = [...body.history].reverse().find(h => h.role === 'assistant');
        assert.strictEqual(lastAssistant.content, 'flowchart TD\n    Round3A-->Round3B',
            'history shows the LLM-authored content for round 3 — editing does NOT rewrite history');
    });

    it('a NEW round after edit overwrites diagram.json with the new LLM output', async () => {
        await runGenerateRound('round 4 prompt');
        const dir = path.join(sessionsDir, ID);
        const diagram = JSON.parse(fs.readFileSync(path.join(dir, 'diagram.json'), 'utf-8'));
        assert.strictEqual(diagram.code, 'flowchart TD\n    Round4A-->Round4B',
            'next LLM round supersedes the hand edit');

        const history = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf-8'));
        assert.strictEqual(history.length, 8, 'history appends 2 more entries (user+assistant)');
    });
});

describe('in-place edit: cross-user isolation', () => {
    let tempDir;
    let router;
    let sessionsDir;
    const ALICE_ID = 'a11ce000-e29b-41d4-a716-446655440000';
    const BOB_ID = 'b0b00000-e29b-41d4-a716-446655440000';

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-edit-crossuser-'));
        router = createRouter(makeConfig(tempDir));
        sessionsDir = path.join(tempDir);
        roundCounter = 0;
        installGeneratorMocks();
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        GeneratorService.prototype.generate = originalGenerate;
        GeneratorService.prototype.generateStream = originalGenerateStream;
    });

    function mockReqAs(user, method, url, body) {
        return { method, url, body, user, on() { return this; } };
    }

    it('alice writes diagram; bob reading the same uuid under his own user does not see it', async () => {
        // Alice does a round first
        await router.generate(mockReqAs('alice', 'POST', '/api/generate',
            { prompt: 'alice', sessionId: ALICE_ID }), mockRes());

        // Alice PATCHes her diagram
        const res = mockRes();
        router.patchDiagram(mockReqAs('alice', 'PATCH', `/api/session/${ALICE_ID}/diagram`,
            { code: 'flowchart LR\nALICE_EDIT' }), res);
        assert.strictEqual(res.statusCode, 200);

        // Bob with the SAME uuid but his own sessionStoreFor path: his /api/session/check
        // looks at <bob>/sessions/<ALICE_ID> which is empty
        const bobCheck = mockRes();
        router.checkSession(mockReqAs('bob', 'POST', '/api/session/check',
            { sessionId: ALICE_ID }), bobCheck);
        const body = JSON.parse(bobCheck.body);
        assert.strictEqual(body.exists, false,
            'alice\'s uuid is invisible to bob — his sessionStoreFor() reads <bob>/sessions/');
        assert.strictEqual(body.lastMermaid, null);

        // Alice can still see her edit
        const aliceCheck = mockRes();
        router.checkSession(mockReqAs('alice', 'POST', '/api/session/check',
            { sessionId: ALICE_ID }), aliceCheck);
        const aliceBody = JSON.parse(aliceCheck.body);
        assert.strictEqual(aliceBody.lastMermaid, 'flowchart LR\nALICE_EDIT');
    });
});

describe('in-place edit: payload boundaries', () => {
    let tempDir;
    let router;
    const ID = '550e8400-e29b-41d4-a716-446655440000';

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-edit-bounds-'));
        router = createRouter(makeConfig(tempDir));
        installGeneratorMocks();
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        GeneratorService.prototype.generate = originalGenerate;
        GeneratorService.prototype.generateStream = originalGenerateStream;
    });

    function mockReq(method, url, body) {
        return { method, url, body, user: 'testuser', on() { return this; } };
    }

    it('empty string code is allowed (semantic: clear the overlay)', () => {
        const res = mockRes();
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`, { code: '' }), res);
        assert.strictEqual(res.statusCode, 200, 'empty code is a valid "clear overlay" signal');
        const diagram = JSON.parse(fs.readFileSync(
            path.join(tempDir, 'testuser', 'sessions', ID, 'diagram.json'), 'utf-8'));
        assert.strictEqual(diagram.code, '');
    });

    it('exactly 200000 bytes is allowed; 200001 is rejected', () => {
        const exact = 'x'.repeat(200000);
        const res1 = mockRes();
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`, { code: exact }), res1);
        assert.strictEqual(res1.statusCode, 200, '200000 bytes is the inclusive upper bound');

        const tooBig = 'x'.repeat(200001);
        const res2 = mockRes();
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`, { code: tooBig }), res2);
        assert.strictEqual(res2.statusCode, 400);
        assert.match(JSON.parse(res2.body).message, /200KB/);
    });

    it('malformed sessionId rejected before any filesystem touch', () => {
        // Path traversal: split('/api/session/../../../etc/passwd/diagram') yields 8
        // segments, so the route's path-shape check rejects with 404 before any
        // filesystem touch. The "wrong id but valid path" case (4 segments but
        // non-uuid) is the 400 path.
        const traversalRes = mockRes();
        router.patchDiagram(mockReq('PATCH', '/api/session/../../../etc/passwd/diagram',
            { code: 'flowchart TD\nA-->B' }), traversalRes);
        assert.strictEqual(traversalRes.statusCode, 404,
            'path traversal -> wrong number of segments -> 404 (no fs touch)');

        const nonUuidRes = mockRes();
        router.patchDiagram(mockReq('PATCH', '/api/session/not-a-uuid/diagram',
            { code: 'flowchart TD\nA-->B' }), nonUuidRes);
        assert.strictEqual(nonUuidRes.statusCode, 400,
            'non-uuid id -> isValidId rejection -> 400 (no fs touch)');

        // Verify no diagram.json was created under any unintended path
        const expectedDir = path.join(tempDir, 'testuser', 'sessions');
        if (fs.existsSync(expectedDir)) {
            for (const entry of fs.readdirSync(expectedDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                assert.match(entry.name, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
                    `unexpected non-uuid session folder under testuser: ${entry.name}`);
            }
        }
    });
});

describe('in-place edit: streaming co-write behavior', () => {
    let tempDir;
    let router;
    let sessionsDir;
    const ID = '550e8400-e29b-41d4-a716-446655440000';

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-edit-stream-'));
        router = createRouter(makeConfig(tempDir));
        sessionsDir = path.join(tempDir, 'testuser', 'sessions');
        roundCounter = 0;
        installGeneratorMocks();
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        GeneratorService.prototype.generate = originalGenerate;
        GeneratorService.prototype.generateStream = originalGenerateStream;
    });

    function mockReq(method, url, body) {
        return { method, url, body, user: 'testuser', on() { return this; } };
    }

    it('a successful streaming round writes BOTH history.json AND diagram.json onDone', async () => {
        const res = mockStreamRes();
        await router.generateStream(mockReq('POST', '/api/generate/stream',
            { prompt: 'stream round', sessionId: ID }), res);

        const dir = path.join(sessionsDir, ID);
        assert.ok(fs.existsSync(path.join(dir, 'history.json')),
            'history.json must exist after streaming round');
        assert.ok(fs.existsSync(path.join(dir, 'diagram.json')),
            'diagram.json must exist after streaming round');

        const diagram = JSON.parse(fs.readFileSync(path.join(dir, 'diagram.json'), 'utf-8'));
        const history = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf-8'));
        assert.strictEqual(diagram.code, history[history.length - 1].content,
            'streaming diagram write equals the appended assistant content');
    });

    it('PATCH after stream round DOES NOT re-write history (only diagram)', async () => {
        const dir = path.join(sessionsDir, ID);
        const historyBefore = fs.readFileSync(path.join(dir, 'history.json'), 'utf-8');

        const res = mockRes();
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`,
            { code: 'flowchart LR\nPOST_STREAM_EDIT' }), res);
        assert.strictEqual(res.statusCode, 200);

        const historyAfter = fs.readFileSync(path.join(dir, 'history.json'), 'utf-8');
        assert.strictEqual(historyAfter, historyBefore,
            'PATCH must be a no-op on history.json — same byte content');
    });
});