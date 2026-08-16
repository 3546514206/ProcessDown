'use strict';

/**
 * 覆盖 in-place 编辑引入的 diagram.json 持久化路径：
 *
 * 1) SessionStore.saveDiagram / readDiagram 的单元行为（含 corrupt 备份）
 * 2) /api/session/check 读 diagram.json 优先于 history.json 的派生
 * 3) PATCH /api/session/:id/diagram 端点的校验 + 写入
 * 4) /api/generate 与 /api/generate/stream 落盘后 diagram.json 同时存在
 *
 * 复用 protectedRoutes.edge.test.js 的 mock 风格（mockReq/mockRes + 创建 router）。
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GeneratorService = require('../../src/services/generator');
const originalGenerate = GeneratorService.prototype.generate;
const originalGenerateStream = GeneratorService.prototype.generateStream;
GeneratorService.prototype.generate = async () => 'flowchart TD\n A-->B';
GeneratorService.prototype.generateStream = async (_prompt, _current, _history, hooks) => {
    if (hooks && hooks.onContent) hooks.onContent('flowchart TD\n A-->B');
    if (hooks && hooks.onDone) hooks.onDone({ mermaid: 'flowchart TD\n A-->B', fixes: [], extracted: true });
};

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

// 流式 mock：generateStream 走 res.write 而非 res.end
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

describe('SessionStore.saveDiagram / readDiagram', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-diagram-store-'));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    beforeEach(() => {
        for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, entry.name), { recursive: true, force: true });
        }
        store = new SessionStore({
            session: { dir: tempDir, maxHistory: 20, ttlDays: 7 }
        });
    });

    it('saveDiagram writes {code, ts} to diagram.json', () => {
        const id = store.create();
        store.saveDiagram(id, 'flowchart TD\nA-->B');
        const diagramPath = path.join(tempDir, id, 'diagram.json');
        assert.ok(fs.existsSync(diagramPath), 'diagram.json should exist after saveDiagram');
        const data = JSON.parse(fs.readFileSync(diagramPath, 'utf-8'));
        assert.strictEqual(data.code, 'flowchart TD\nA-->B');
        assert.strictEqual(typeof data.ts, 'number');
    });

    it('readDiagram returns the saved diagram', () => {
        const id = store.create();
        store.saveDiagram(id, 'flowchart TD\nA-->B');
        const data = store.readDiagram(id);
        assert.deepStrictEqual(data.code, 'flowchart TD\nA-->B');
        assert.strictEqual(typeof data.ts, 'number');
    });

    it('readDiagram returns null when no diagram.json exists', () => {
        const id = store.create();
        assert.strictEqual(store.readDiagram(id), null);
    });

    it('readDiagram returns null for invalid sessionId (no path traversal)', () => {
        assert.strictEqual(store.readDiagram('../etc/passwd'), null);
    });

    it('readDiagram backs up corrupt file and returns null', () => {
        const id = store.create();
        const diagramPath = path.join(tempDir, id, 'diagram.json');
        fs.writeFileSync(diagramPath, 'not json at all');
        const data = store.readDiagram(id);
        assert.strictEqual(data, null);
        // 备份存在
        const files = fs.readdirSync(path.join(tempDir, id));
        const backup = files.find(f => f.startsWith('diagram.json.corrupt-'));
        assert.ok(backup, 'corrupt diagram.json should be backed up');
    });

    it('readDiagram rejects payload with non-string code (backed up, returns null)', () => {
        const id = store.create();
        const diagramPath = path.join(tempDir, id, 'diagram.json');
        fs.writeFileSync(diagramPath, JSON.stringify({ code: 12345, ts: 1 }));
        const data = store.readDiagram(id);
        assert.strictEqual(data, null);
        const files = fs.readdirSync(path.join(tempDir, id));
        assert.ok(files.some(f => f.startsWith('diagram.json.corrupt-')));
    });
});

describe('PATCH /api/session/:id/diagram + checkSession diagram precedence', () => {
    let tempDir;
    let router;
    let sessionsDir;
    let store;
    const ID = '550e8400-e29b-41d4-a716-446655440000';

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-diagram-route-'));
        router = createRouter(makeConfig(tempDir));
        sessionsDir = path.join(tempDir, 'testuser', 'sessions');
        store = new SessionStore({ session: { dir: sessionsDir, maxHistory: 20, ttlDays: 7 } });
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        GeneratorService.prototype.generate = originalGenerate;
        GeneratorService.prototype.generateStream = originalGenerateStream;
    });

    function mockReq(method, url, body, user = 'testuser') {
        // generateStream 注册了 req.on('close')，mock 也得带上
        return {
            method, url, body, user,
            on() { return this; }
        };
    }

    it('PATCH returns 405 on non-PATCH method', () => {
        const res = mockRes();
        router.patchDiagram(mockReq('POST', `/api/session/${ID}/diagram`, {}), res);
        assert.strictEqual(res.statusCode, 405);
    });

    it('PATCH 404s on a path that does not match /api/session/:id/diagram shape', () => {
        const res = mockRes();
        router.patchDiagram(mockReq('PATCH', '/api/session/not-a-uuid/diagram', { code: 'x' }), res);
        // 非 UUID 的 id 在 isValidId 后会 400
        assert.strictEqual(res.statusCode, 400);
    });

    it('PATCH 400 when code is not a string', () => {
        const res = mockRes();
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`, { code: 12345 }), res);
        assert.strictEqual(res.statusCode, 400);
    });

    it('PATCH 400 when code exceeds 200KB', () => {
        const res = mockRes();
        const big = 'x'.repeat(200001);
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`, { code: big }), res);
        assert.strictEqual(res.statusCode, 400);
    });

    it('PATCH writes diagram.json on a valid request', () => {
        const res = mockRes();
        router.patchDiagram(mockReq('PATCH', `/api/session/${ID}/diagram`, { code: 'flowchart LR\nX' }), res);
        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.sessionId, ID);
        assert.strictEqual(typeof body.savedAt, 'number');
        // diagram.json 已写入
        const diagramPath = path.join(sessionsDir, ID, 'diagram.json');
        assert.ok(fs.existsSync(diagramPath));
        const data = JSON.parse(fs.readFileSync(diagramPath, 'utf-8'));
        assert.strictEqual(data.code, 'flowchart LR\nX');
    });

    it('checkSession prefers diagram.json over history last assistant', () => {
        // 种 history，最后一条 assistant 是 "gitGraph LR:\n    commit"
        store.append(ID, '画图', 'gitGraph LR:\n    commit');
        // 同时写一份 diagram.json（用户编辑后的净化版本）
        store.saveDiagram(ID, 'gitGraph\n    commit');

        const res = mockRes();
        router.checkSession(mockReq('POST', `/api/session/check`, { sessionId: ID }), res);
        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        // lastMermaid 应来自 diagram.json（已净化），而不是 history 里未净化的 LR
        assert.strictEqual(body.lastMermaid, 'gitGraph\n    commit');
    });

    it('checkSession falls back to history when diagram.json absent', () => {
        const id2 = '660e8400-e29b-41d4-a716-446655440000';
        store.append(id2, '画图', 'flowchart TD\nA-->B');

        const res = mockRes();
        router.checkSession(mockReq('POST', '/api/session/check', { sessionId: id2 }), res);
        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.lastMermaid, 'flowchart TD\nA-->B');
    });

    it('checkSession falls back to history when diagram.json corrupt', () => {
        const id3 = '770e8400-e29b-41d4-a716-446655440000';
        store.append(id3, '画图', 'flowchart TD\nA-->B');
        // 写一份损坏的 diagram.json
        fs.mkdirSync(path.join(sessionsDir, id3), { recursive: true });
        fs.writeFileSync(path.join(sessionsDir, id3, 'diagram.json'), 'this is not json');

        const res = mockRes();
        router.checkSession(mockReq('POST', '/api/session/check', { sessionId: id3 }), res);
        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        // 损坏 backup 后回退到 history
        assert.strictEqual(body.lastMermaid, 'flowchart TD\nA-->B');
    });

    it('/api/generate writes both history.json and diagram.json', async () => {
        const id4 = '880e8400-e29b-41d4-a716-446655440000';
        const res = mockRes();
        await router.generate(mockReq('POST', '/api/generate', {
            prompt: '画一个简单流程图',
            sessionId: id4
        }), res);
        assert.strictEqual(res.statusCode, 200);
        const dir = path.join(sessionsDir, id4);
        assert.ok(fs.existsSync(path.join(dir, 'history.json')));
        assert.ok(fs.existsSync(path.join(dir, 'diagram.json')));
        const diagram = JSON.parse(fs.readFileSync(path.join(dir, 'diagram.json'), 'utf-8'));
        assert.strictEqual(diagram.code, 'flowchart TD\n A-->B');
    });

    it('/api/generate/stream writes both history.json and diagram.json', async () => {
        const id5 = '990e8400-e29b-41d4-a716-446655440000';
        const res = mockStreamRes();
        await router.generateStream(mockReq('POST', '/api/generate/stream', {
            prompt: '画一个简单流程图',
            sessionId: id5
        }), res);
        const dir = path.join(sessionsDir, id5);
        assert.ok(fs.existsSync(path.join(dir, 'history.json')));
        assert.ok(fs.existsSync(path.join(dir, 'diagram.json')));
        const diagram = JSON.parse(fs.readFileSync(path.join(dir, 'diagram.json'), 'utf-8'));
        assert.strictEqual(diagram.code, 'flowchart TD\n A-->B');
    });
});