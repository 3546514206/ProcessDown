'use strict';

// /api/generate/stream 路由测试：mock GeneratorService.generateStream，
// 验证 SSE 事件序列（thinking/content/done/[DONE]）、会话落盘、校验失败、客户端断开中止。

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const GeneratorService = require('../../src/services/generator');
const createRouter = require('../../src/routes/api');

const originalGenerateStream = GeneratorService.prototype.generateStream;

function createMockRes() {
    return {
        statusCode: 200,
        headers: {},
        chunks: [],
        writableEnded: false,
        writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); },
        write(data) { if (!this.writableEnded) this.chunks.push(String(data)); },
        end(data) { if (data) this.chunks.push(String(data)); this.writableEnded = true; }
    };
}

function createMockReq(body = {}) {
    const handlers = {};
    return {
        method: 'POST',
        body,
        user: 'testuser',
        headers: {},
        on(event, handler) { handlers[event] = handler; },
        _triggerClose() { if (handlers.close) handlers.close(); }
    };
}

// 把捕获的 res.write 文本解析回 SSE 事件对象列表
function parseEvents(res) {
    const events = [];
    for (const chunk of res.chunks) {
        for (const line of chunk.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const json = trimmed.slice(5).trim();
            if (json === '[DONE]') { events.push({ type: '[DONE]' }); continue; }
            try { events.push(JSON.parse(json)); } catch (e) { /* 忽略半截 */ }
        }
    }
    return events;
}

describe('POST /api/generate/stream', () => {
    let tempDir;
    let config;
    let router;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processdown-stream-route-'));
        config = {
            session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
            users: { dir: tempDir },
            auth: { tokenTtlDays: 7 },
            llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.3, maxTokens: 1000, timeout: 30 }
        };
        router = createRouter(config);
    });

    after(() => {
        GeneratorService.prototype.generateStream = originalGenerateStream;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('正常流式：按序推 thinking/content/done，再 [DONE]，并落盘会话', async () => {
        GeneratorService.prototype.generateStream = async function (prompt, cur, history, cb) {
            cb.onThinking && cb.onThinking('t1');
            cb.onContent && cb.onContent('c1');
            cb.onContent && cb.onContent('c2');
            cb.onDone && cb.onDone({ mermaid: 'flowchart TD\nA-->B', fixes: ['x'], extracted: true });
            return { mermaid: 'flowchart TD\nA-->B', fixes: ['x'], extracted: true };
        };

        const sessionId = crypto.randomUUID();
        const req = createMockReq({ prompt: '画个流程图', sessionId });
        const res = createMockRes();

        await router.generateStream(req, res);

        assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
        assert.strictEqual(res.headers['X-Accel-Buffering'], 'no');
        const events = parseEvents(res);
        assert.deepStrictEqual(events.map(e => e.type), ['thinking', 'content', 'content', 'done', '[DONE]']);
        assert.strictEqual(events[0].delta, 't1');
        assert.strictEqual(events[1].delta, 'c1');
        assert.strictEqual(events[2].delta, 'c2');
        assert.strictEqual(events[3].mermaid, 'flowchart TD\nA-->B');
        assert.strictEqual(events[3].fixes[0], 'x');

        // 会话落盘：history.json 含本轮 user + assistant
        const historyPath = path.join(tempDir, 'testuser', 'sessions', sessionId, 'history.json');
        const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
        assert.strictEqual(history.length, 2);
        assert.strictEqual(history[0].role, 'user');
        assert.strictEqual(history[1].role, 'assistant');
        assert.strictEqual(history[1].content, 'flowchart TD\nA-->B');
    });

    it('校验失败：返回 400 JSON，不升级 SSE', async () => {
        const req = createMockReq({}); // 既无 prompt 也无 mermaid
        const res = createMockRes();
        await router.generateStream(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.headers['Content-Type'], 'application/json');
        const events = parseEvents(res);
        assert.strictEqual(events.length, 0); // 无 SSE 事件
    });

    it('非法 sessionId：返回 400', async () => {
        const req = createMockReq({ prompt: 'x', sessionId: 'not-a-uuid' });
        const res = createMockRes();
        await router.generateStream(req, res);
        assert.strictEqual(res.statusCode, 400);
    });

    it('客户端断开：abort 信号传入 generateStream，不写 error 事件', async () => {
        let receivedSignal = null;
        GeneratorService.prototype.generateStream = async function (prompt, cur, history, cb, signal) {
            receivedSignal = signal;
            // 模拟流式中途客户端断开：等一拍让 close handler 触发 abort
            await new Promise(r => setTimeout(r, 20));
            if (signal && signal.aborted) {
                const e = new Error('aborted');
                e.code = 'ABORTED';
                throw e;
            }
            cb.onDone && cb.onDone({ mermaid: 'x', fixes: [], extracted: true });
        };

        const req = createMockReq({ prompt: 'x', sessionId: crypto.randomUUID() });
        const res = createMockRes();

        const p = router.generateStream(req, res);
        // 触发客户端断开（route 的 req.on('close') 会 abort controller）
        req._triggerClose();
        await p;

        assert.ok(receivedSignal, 'generateStream 应收到 signal');
        assert.ok(receivedSignal.aborted, 'signal 应已 abort');
        assert.ok(res.writableEnded, 'res 应已 end');
        const events = parseEvents(res);
        // 不应有 error 事件（abort 静默收尾）
        assert.ok(!events.some(e => e.type === 'error'), 'abort 不应写 error 事件');
    });

    it('生成异常（非 abort）：写 error 事件再 [DONE]', async () => {
        GeneratorService.prototype.generateStream = async function () {
            throw new Error('ECONNREFUSED connect failed');
        };
        const req = createMockReq({ prompt: 'x', sessionId: crypto.randomUUID() });
        const res = createMockRes();
        await router.generateStream(req, res);
        const events = parseEvents(res);
        const errEvt = events.find(e => e.type === 'error');
        assert.ok(errEvt, '应有 error 事件');
        assert.ok(errEvt.message.includes('LLM 服务连接失败'), '错误信息应脱敏为用户可读提示');
        assert.ok(events.some(e => e.type === '[DONE]'));
    });
});
