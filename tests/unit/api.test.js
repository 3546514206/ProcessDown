'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Monkey-patch GeneratorService before requiring createRouter
const GeneratorService = require('../../src/services/generator');
const originalGenerate = GeneratorService.prototype.generate;
GeneratorService.prototype.generate = async () => 'flowchart TD\n A-->B';

const createRouter = require('../../src/routes/api');

// Helper to create mock request/response
function createMockReq(method = 'POST', body = {}) {
    return {
        method,
        body
    };
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
        end(data) {
            res.body = data;
        }
    };
    return res;
}

describe('API Routes', () => {
    let tempDir;
    let config;
    let router;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processdown-api-test-'));
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        // Restore original generate
        GeneratorService.prototype.generate = originalGenerate;
    });

    beforeEach(() => {
        // Clean tempDir
        for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
            const entryPath = path.join(tempDir, entry.name);
            fs.rmSync(entryPath, { recursive: true, force: true });
        }
        config = {
            session: {
                dir: tempDir,
                maxHistory: 20,
                ttlDays: 7
            },
            llm: {
                baseUrl: 'http://fake',
                apiKey: 'fake-key',
                model: 'fake-model',
                temperature: 0.7,
                maxTokens: 1000,
                timeout: 30000
            },
            server: { port: 3000, timeout: 30000 },
            cors: { enabled: true, origins: ['*'] },
            rateLimit: { enabled: false, maxRequests: 100, windowMs: 60000 },
            auth: { enabled: false },
            health: { checkLlm: false }
        };
        router = createRouter(config);
    });

    describe('createSession', () => {
        it('should return 405 for GET requests', () => {
            const req = createMockReq('GET');
            const res = createMockRes();

            router.createSession(req, res);

            assert.strictEqual(res.statusCode, 405);
            const body = JSON.parse(res.body);
            assert.strictEqual(body.error, 'Method Not Allowed');
        });

        it('should return 200 with valid UUID for POST requests', () => {
            const req = createMockReq('POST');
            const res = createMockRes();

            router.createSession(req, res);

            assert.strictEqual(res.statusCode, 200);
            const body = JSON.parse(res.body);
            assert.ok(body.success);
            assert.match(body.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

            // Verify folder was created
            const sessionDir = path.join(tempDir, body.sessionId);
            assert.ok(fs.existsSync(sessionDir));
            assert.ok(fs.existsSync(path.join(sessionDir, 'history.json')));
        });
    });

    describe('generate', () => {
        it('should return 200 with empty history when no sessionId provided', async () => {
            const req = createMockReq('POST', { prompt: 'test prompt' });
            const res = createMockRes();

            await router.generate(req, res);

            assert.strictEqual(res.statusCode, 200);
            const body = JSON.parse(res.body);
            assert.ok(body.success);
            assert.strictEqual(body.mermaid, 'flowchart TD\n A-->B');
            assert.deepStrictEqual(body.history, []);

            // No session folders should be created
            const entries = fs.readdirSync(tempDir);
            assert.strictEqual(entries.length, 0);
        });

        it('should return 400 for invalid sessionId format', async () => {
            const req = createMockReq('POST', { prompt: 'test', sessionId: '../../etc/passwd' });
            const res = createMockRes();

            await router.generate(req, res);

            assert.strictEqual(res.statusCode, 400);
            const body = JSON.parse(res.body);
            assert.strictEqual(body.error, 'Validation Error');
            assert.strictEqual(body.message, 'Invalid sessionId format');
        });

        it('should return 200 and transparently recreate for valid but non-existent sessionId', async () => {
            const fakeId = '550e8400-e29b-41d4-a716-446655440000';
            const req = createMockReq('POST', { prompt: 'test', sessionId: fakeId });
            const res = createMockRes();

            await router.generate(req, res);

            assert.strictEqual(res.statusCode, 200);
            const body = JSON.parse(res.body);
            assert.ok(body.success);

            // Folder should be created and have history
            const sessionDir = path.join(tempDir, fakeId);
            assert.ok(fs.existsSync(sessionDir));
            const historyPath = path.join(sessionDir, 'history.json');
            assert.ok(fs.existsSync(historyPath));
            const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            assert.strictEqual(history.length, 2); // user + assistant
        });

        it('should append history on disk with valid sessionId', async () => {
            const req1 = createMockReq('POST', { prompt: 'round 1', sessionId: '550e8400-e29b-41d4-a716-446655440000' });
            const res1 = createMockRes();
            await router.generate(req1, res1);

            const req2 = createMockReq('POST', { prompt: 'round 2', sessionId: '550e8400-e29b-41d4-a716-446655440000' });
            const res2 = createMockRes();
            await router.generate(req2, res2);

            const historyPath = path.join(tempDir, '550e8400-e29b-41d4-a716-446655440000', 'history.json');
            const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            assert.strictEqual(history.length, 4); // 2 rounds
            assert.strictEqual(history[0].content, 'round 1');
            assert.strictEqual(history[2].content, 'round 2');
        });
    });
});
