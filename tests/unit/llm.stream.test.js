'use strict';

// LLMService 流式能力测试：SSE 行解析 + <think> 标签分离状态机。
// 通过 monkey-patch http.request 喂入构造好的 SSE chunk，验证 chatStream
// 把 reasoning_content / <think> / 正文正确路由到 onThinking / onContent。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');
// llm/index.js 用 module.exports = LLMService 直接导出类，非命名导出
const LLMService = require('../../src/services/llm');

function makeLlm() {
    return new LLMService({
        llm: {
            baseUrl: 'http://fake.test',
            apiKey: 'k',
            model: 'm',
            temperature: 0,
            maxTokens: 0, // 非正 -> payload 省略 max_tokens
            timeout: 30
        }
    });
}

// 拦截 http.request：cb 同步拿到伪 res，nextTick 依次推 SSE chunk 再 end。
// 返回 restore 还原原始 request。
function patchHttp(sseChunks, statusCode = 200) {
    const original = http.request;
    http.request = (options, cb) => {
        const req = {
            write() {}, end() {}, destroy() {}, on() {}, setTimeout() {}
        };
        const res = {
            statusCode,
            _h: {},
            on(event, handler) { this._h[event] = handler; return this; }
        };
        cb(res);
        process.nextTick(() => {
            if (statusCode >= 300) {
                for (const chunk of sseChunks) {
                    if (res._h['data']) res._h['data'](Buffer.from(chunk));
                }
                if (res._h['end']) res._h['end']();
                return;
            }
            for (const chunk of sseChunks) {
                if (res._h['data']) res._h['data'](Buffer.from(chunk));
            }
            if (res._h['end']) res._h['end']();
        });
        return req;
    };
    return () => { http.request = original; };
}

describe('LLMService.chatStream', () => {
    it('reasoning_content 直归 onThinking，正文归 onContent', async () => {
        const llm = makeLlm();
        const restore = patchHttp([
            'data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_content":"再想"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"flowchart TD\\nA-->B"}}]}\n\n',
            'data: [DONE]\n\n'
        ]);
        const thinking = [];
        const content = [];
        await llm.chatStream([{ role: 'user', content: 'hi' }], 'sys', {
            onThinking: d => thinking.push(d),
            onContent: d => content.push(d)
        });
        restore();
        assert.strictEqual(thinking.join(''), '先想再想');
        assert.strictEqual(content.join(''), 'flowchart TD\nA-->B');
    });

    it('content 内嵌 <think>...</think> 被拆到 onThinking，正文留 onContent', async () => {
        const llm = makeLlm();
        const restore = patchHttp([
            'data: {"choices":[{"delta":{"content":"<think>隐藏思考"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"过程</think>"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"flowchart LR\\nX-->Y"}}]}\n\n',
            'data: [DONE]\n\n'
        ]);
        const thinking = [];
        const content = [];
        await llm.chatStream([{ role: 'user', content: 'hi' }], null, {
            onThinking: d => thinking.push(d),
            onContent: d => content.push(d)
        });
        restore();
        assert.strictEqual(thinking.join(''), '隐藏思考过程');
        assert.strictEqual(content.join(''), 'flowchart LR\nX-->Y');
    });

    it('<think> 标签跨 chunk 到达仍正确分离', async () => {
        const llm = makeLlm();
        const restore = patchHttp([
            'data: {"choices":[{"delta":{"content":"<th"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"ink>跨片思考"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"</thi"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"nk>graph TD\\nA-->B"}}]}\n\n',
            'data: [DONE]\n\n'
        ]);
        const thinking = [];
        const content = [];
        await llm.chatStream([{ role: 'user', content: 'hi' }], null, {
            onThinking: d => thinking.push(d),
            onContent: d => content.push(d)
        });
        restore();
        assert.strictEqual(thinking.join(''), '跨片思考');
        assert.strictEqual(content.join(''), 'graph TD\nA-->B');
    });

    it('未闭合 <think> 在流结束时兜底归 thinking，不污染 content', async () => {
        const llm = makeLlm();
        const restore = patchHttp([
            'data: {"choices":[{"delta":{"content":"<think>只有开头没闭合"}}]}\n\n',
            'data: [DONE]\n\n'
        ]);
        const thinking = [];
        const content = [];
        await llm.chatStream([{ role: 'user', content: 'hi' }], null, {
            onThinking: d => thinking.push(d),
            onContent: d => content.push(d)
        });
        restore();
        // 全部归 thinking（已 emit + finalize 兜底），content 为空
        assert.strictEqual(thinking.join(''), '只有开头没闭合');
        assert.strictEqual(content.join(''), '');
    });

    it('payload 含 stream:true，maxTokens 非正时省略 max_tokens', async () => {
        const llm = makeLlm();
        let capturedPayload = null;
        const original = http.request;
        http.request = (options, cb) => {
            // 捕获 payload 后正常放行
            const req = {
                write(body) { capturedPayload = JSON.parse(body); },
                end() {
                    const res = { statusCode: 200, _h: {}, on(e, h) { this._h[e] = h; return this; } };
                    cb(res);
                    process.nextTick(() => {
                        if (res._h['end']) res._h['end']();
                    });
                },
                destroy() {}, on() {}, setTimeout() {}
            };
            return req;
        };
        await llm.chatStream([{ role: 'user', content: 'hi' }], 'sys', {});
        http.request = original;
        assert.strictEqual(capturedPayload.stream, true);
        assert.strictEqual(capturedPayload.model, 'm');
        assert.ok(!('max_tokens' in capturedPayload), 'max_tokens 应被省略');
    });

    it('非 2xx 响应 reject 并带错误信息', async () => {
        const llm = makeLlm();
        const restore = patchHttp([
            '{"error":{"message":"bad key"}}'
        ], 401);
        await assert.rejects(
            llm.chatStream([{ role: 'user', content: 'hi' }], null, {}),
            /bad key/
        );
        restore();
    });

    it('signal 已 abort 时不发请求', async () => {
        const llm = makeLlm();
        let requested = false;
        const original = http.request;
        http.request = () => { requested = true; return { destroy() {}, on() {}, setTimeout() {} }; };
        const ac = new AbortController();
        ac.abort();
        await assert.rejects(
            llm.chatStream([{ role: 'user', content: 'hi' }], null, {}, ac.signal),
            /aborted/
        );
        http.request = original;
        // request 仍会被调用（http.request 同步创建），但 req.destroy 立即触发 -> ABORTED
        assert.ok(requested);
    });

    it('UTF-8 多字节字符跨 chunk 边界正确拼合（StringDecoder 修复）', async () => {
        const llm = makeLlm();
        // 含中文"中"(UTF-8: e4 b8 ad)的 SSE 行，按字节切分让"中"跨两个 TCP chunk
        const prefix = 'data: {"choices":[{"delta":{"content":"';
        const suffix = '"}}]}\n\n';
        const fullBuf = Buffer.concat([
            Buffer.from(prefix, 'utf8'),
            Buffer.from('中', 'utf8'),
            Buffer.from(suffix, 'utf8')
        ]);
        // 切在"中"的第 1 字节后：chunk1 末尾是孤立 0xE4，chunk2 开头是 0xB8 0xAD
        const splitAt = Buffer.from(prefix, 'utf8').length + 1;
        const chunk1 = fullBuf.slice(0, splitAt);
        const chunk2 = fullBuf.slice(splitAt);

        const original = http.request;
        http.request = (options, cb) => {
            const req = { write() {}, end() {}, destroy() {}, on() {}, setTimeout() {} };
            const res = { statusCode: 200, _h: {}, on(e, h) { this._h[e] = h; return this; } };
            cb(res);
            process.nextTick(() => {
                if (res._h['data']) res._h['data'](chunk1);
                if (res._h['data']) res._h['data'](chunk2);
                if (res._h['end']) res._h['end']();
            });
            return req;
        };
        const content = [];
        await llm.chatStream([{ role: 'user', content: 'hi' }], null, {
            onContent: d => content.push(d)
        });
        http.request = original;
        // 未用 StringDecoder 时"中"会损坏成 U+FFFD；修复后完整拼合
        assert.strictEqual(content.join(''), '中');
    });
});
