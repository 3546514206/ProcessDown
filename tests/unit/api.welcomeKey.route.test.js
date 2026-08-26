'use strict';

// /api/generate 与 /api/generate/stream 路由 welcomeKey 行为测试：
// 用 GeneratorService.prototype.generate / generateStream mock，验证路由层
// (a) 把白名单 welcomeKey 抽出的代码作为第 5 参 (welcomeCode) 透传给 generator
// (b) 不传 welcomeKey 时透传 null
// (c) 非法 welcomeKey（非字符串 / 非白名单 / 文件缺失）返回 400，且不调 generator

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const GeneratorService = require('../../src/services/generator');
const createRouter = require('../../src/routes/api');
const { extractMermaidFromMarkdown } = require('../../src/services/welcomeCode');

const originalGenerate = GeneratorService.prototype.generate;
const originalGenerateStream = GeneratorService.prototype.generateStream;

// 复用 generateStream.route.test.js 的 createMockReq / createMockRes 模式
function createMockReq(body = {}) {
    const handlers = {};
    return {
        method: 'POST',
        body,
        user: 'welcomeuser',
        headers: {},
        on(event, handler) { handlers[event] = handler; },
        _triggerClose() { if (handlers.close) handlers.close(); }
    };
}

function createMockRes() {
    return {
        statusCode: 200,
        headers: {},
        chunks: [],
        body: null,
        writableEnded: false,
        writeHead(code, headers) {
            this.statusCode = code;
            this.headers = { ...this.headers, ...headers };
        },
        write(data) { if (!this.writableEnded) this.chunks.push(String(data)); },
        end(data) {
            if (data) {
                if (typeof data === 'string' || Buffer.isBuffer(data)) {
                    this.chunks.push(String(data));
                    this.body = data;
                } else {
                    this.body = data;
                }
            }
            this.writableEnded = true;
        }
    };
}

// 预期从 C4Container.md 抽出的代码，路由测试用
function loadExpectedCode() {
    const projectRoot = path.join(__dirname, '..', '..');
    const raw = fs.readFileSync(
        path.join(projectRoot, 'prompts', 'welcome', 'C4Container.md'),
        'utf-8'
    );
    return extractMermaidFromMarkdown(raw);
}

describe('路由 welcomeKey 处理', () => {
    let tempDir;
    let router;
    let expectedC4Code;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processdown-welcomekey-route-'));
        const config = {
            session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
            users: { dir: tempDir },
            auth: { tokenTtlDays: 7 },
            llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.3, maxTokens: 1000, timeout: 30 }
        };
        router = createRouter(config);
        expectedC4Code = loadExpectedCode();
    });

    after(() => {
        GeneratorService.prototype.generate = originalGenerate;
        GeneratorService.prototype.generateStream = originalGenerateStream;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('POST /api/generate', () => {
        it('(a) 传 welcomeKey=c4-ecommerce: generator 收到的 welcomeCode 是从 .md 抽出的字符串', async () => {
            let receivedWelcome = 'unset';
            GeneratorService.prototype.generate = async (prompt, cur, history, theme, welcomeCode) => {
                receivedWelcome = welcomeCode;
                return 'flowchart TD\nA-->B';
            };

            const req = createMockReq({ prompt: '画个电商架构图', welcomeKey: 'c4-ecommerce' });
            const res = createMockRes();
            await router.generate(req, res);

            assert.strictEqual(res.statusCode, 200, '合法 welcomeKey 不应 400');
            assert.strictEqual(typeof receivedWelcome, 'string', 'welcomeCode 应是字符串');
            assert.strictEqual(receivedWelcome, expectedC4Code,
                'welcomeCode 应等于从 C4Container.md 抽出的代码');
        });

        it('(b) 不传 welcomeKey: generator 收到的 welcomeCode=null', async () => {
            let receivedWelcome = 'unset';
            GeneratorService.prototype.generate = async (prompt, cur, history, theme, welcomeCode) => {
                receivedWelcome = welcomeCode;
                return 'flowchart TD\nA-->B';
            };

            const req = createMockReq({ prompt: '画个流程图' });
            const res = createMockRes();
            await router.generate(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(receivedWelcome, null, '未传 welcomeKey 应透传 null');
        });

        it('(c) welcomeKey=../etc/passwd: 返回 400, mock generate 不被调用', async () => {
            let called = false;
            GeneratorService.prototype.generate = async () => { called = true; return 'x'; };

            const req = createMockReq({ prompt: 'p', welcomeKey: '../etc/passwd' });
            const res = createMockRes();
            await router.generate(req, res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.headers['Content-Type'], 'application/json');
            const body = JSON.parse(res.body);
            assert.strictEqual(body.error, 'Validation Error');
            assert.strictEqual(called, false, '非法 welcomeKey 必须 400, generator 不被调用');
        });

        it('(d) welcomeKey=123 (非字符串): 返回 400', async () => {
            let called = false;
            GeneratorService.prototype.generate = async () => { called = true; return 'x'; };

            const req = createMockReq({ prompt: 'p', welcomeKey: 123 });
            const res = createMockRes();
            await router.generate(req, res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.headers['Content-Type'], 'application/json');
            const body = JSON.parse(res.body);
            assert.strictEqual(body.error, 'Validation Error');
            assert.match(body.message, /welcomeKey/, 'message 应提到 welcomeKey');
            assert.strictEqual(called, false);
        });

        it('(d-2) welcomeKey={obj}: 非字符串对象也返回 400', async () => {
            let called = false;
            GeneratorService.prototype.generate = async () => { called = true; return 'x'; };

            const req = createMockReq({ prompt: 'p', welcomeKey: { value: 'c4-ecommerce' } });
            const res = createMockRes();
            await router.generate(req, res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(called, false);
        });

        it('(e) welcomeKey=unknown-key (白名单外但字符串): 返回 400', async () => {
            let called = false;
            GeneratorService.prototype.generate = async () => { called = true; return 'x'; };

            const req = createMockReq({ prompt: 'p', welcomeKey: 'unknown-key' });
            const res = createMockRes();
            await router.generate(req, res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.headers['Content-Type'], 'application/json');
            const body = JSON.parse(res.body);
            assert.strictEqual(body.error, 'Validation Error');
            assert.match(body.message, /welcomeKey|recognized/i, 'message 应指明 welcomeKey 不被识别');
            assert.strictEqual(called, false);
        });

        it('welcomeKey=null: 视为未传，generator 收到 null', async () => {
            let receivedWelcome = 'unset';
            GeneratorService.prototype.generate = async (p, c, h, t, welcomeCode) => {
                receivedWelcome = welcomeCode;
                return 'flowchart TD\nA-->B';
            };

            const req = createMockReq({ prompt: 'p', welcomeKey: null });
            const res = createMockRes();
            await router.generate(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(receivedWelcome, null, 'welcomeKey=null 应等同未传');
        });
    });

    describe('POST /api/generate/stream', () => {
        it('(f) 传 welcomeKey=c4-ecommerce: generateStream 收到的 welcomeCode 是 .md 抽出的字符串', async () => {
            let receivedWelcome = 'unset';
            GeneratorService.prototype.generateStream = async (
                prompt, cur, history, cb, signal, theme, welcomeCode
            ) => {
                receivedWelcome = welcomeCode;
                cb.onDone && cb.onDone({ mermaid: 'flowchart TD\nA-->B', fixes: [], extracted: true });
                return { mermaid: 'flowchart TD\nA-->B', fixes: [], extracted: true };
            };

            const req = createMockReq({ prompt: 'p', welcomeKey: 'c4-ecommerce' });
            const res = createMockRes();
            await router.generateStream(req, res);

            assert.strictEqual(res.headers['Content-Type'], 'text/event-stream',
                '合法 welcomeKey 应升级 SSE');
            assert.strictEqual(typeof receivedWelcome, 'string');
            assert.strictEqual(receivedWelcome, expectedC4Code);
        });

        it('(g) 不传 welcomeKey: generateStream 收到 welcomeCode=null', async () => {
            let receivedWelcome = 'unset';
            GeneratorService.prototype.generateStream = async (
                prompt, cur, history, cb, signal, theme, welcomeCode
            ) => {
                receivedWelcome = welcomeCode;
                cb.onDone && cb.onDone({ mermaid: 'x', fixes: [], extracted: true });
                return { mermaid: 'x', fixes: [], extracted: true };
            };

            const req = createMockReq({ prompt: 'p' });
            const res = createMockRes();
            await router.generateStream(req, res);

            assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
            assert.strictEqual(receivedWelcome, null);
        });

        it('(h) 非法 welcomeKey=../etc/passwd: 返回 400 JSON, 不升级 SSE, generateStream 不被调用', async () => {
            let called = false;
            GeneratorService.prototype.generateStream = async () => {
                called = true;
                return { mermaid: 'x', fixes: [], extracted: true };
            };

            const req = createMockReq({ prompt: 'p', welcomeKey: '../etc/passwd' });
            const res = createMockRes();
            await router.generateStream(req, res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.headers['Content-Type'], 'application/json',
                '非法 welcomeKey 必须 JSON, 不升级 SSE');
            // 兜底：即使 headers 误设也应能识别 Content-Type
            const body = JSON.parse(res.body);
            assert.strictEqual(body.error, 'Validation Error');
            assert.strictEqual(called, false);
        });

        it('(h-2) 非法 welcomeKey=123 (非字符串): 同样 400 JSON, 不升级 SSE', async () => {
            let called = false;
            GeneratorService.prototype.generateStream = async () => {
                called = true;
                return { mermaid: 'x', fixes: [], extracted: true };
            };

            const req = createMockReq({ prompt: 'p', welcomeKey: 123 });
            const res = createMockRes();
            await router.generateStream(req, res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.headers['Content-Type'], 'application/json');
            assert.strictEqual(called, false);
        });

        it('(h-3) 非法 welcomeKey=unknown-key (白名单外): 同样 400 JSON', async () => {
            let called = false;
            GeneratorService.prototype.generateStream = async () => {
                called = true;
                return { mermaid: 'x', fixes: [], extracted: true };
            };

            const req = createMockReq({ prompt: 'p', welcomeKey: 'unknown-key' });
            const res = createMockRes();
            await router.generateStream(req, res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.headers['Content-Type'], 'application/json');
            assert.strictEqual(called, false);
        });

        it('welcomeKey=null (流式): 视为未传, generateStream 收到 null', async () => {
            let receivedWelcome = 'unset';
            GeneratorService.prototype.generateStream = async (
                prompt, cur, history, cb, signal, theme, welcomeCode
            ) => {
                receivedWelcome = welcomeCode;
                cb.onDone && cb.onDone({ mermaid: 'x', fixes: [], extracted: true });
                return { mermaid: 'x', fixes: [], extracted: true };
            };

            const req = createMockReq({ prompt: 'p', welcomeKey: null });
            const res = createMockRes();
            await router.generateStream(req, res);

            assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
            assert.strictEqual(receivedWelcome, null);
        });
    });
});