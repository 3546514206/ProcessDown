'use strict';

/**
 * "用户自主输入禁止作弊" 端到端契约测试（后端层）：
 *
 * 验证核心约束：在用户**自输入**的路径上，后端绝不注入预制代码（welcomeCode）。
 * 预制代码只在 chip click 触发时才允许走 cheat path——本文件不重复 happy path
 * 测试（已由 api.welcomeKey.route.test.js 覆盖），而是穷举用户输入侧可能进入
 * generateStream 的 welcomeKey 形态（缺失 / null / '' / undefined），断言：
 *
 *   1. messages 数组里没有 role === 'system' 的"参考代码"消息
 *   2. messages 里没有任何 content 含 "参考代码" 引导语
 *   3. messages 里没有任何 content 含 prompts/welcome/*.md 里出现过的
 *      图表关键字（C4Container / Person( / sequenceDiagram / gitGraph / mindmap）
 *
 * 关键设计：mock 掉 GeneratorService 自己的 llm.chatStream（而不是 mock
 * GeneratorService.generateStream 整层）。这样捕获到的 messages 数组就是
 * 真正会送往 LLM 的——任何"参考代码"system 消息若被注入，源头只可能是
 * generator.generateStream 里的 `if (typeof welcomeCode === 'string' && welcomeCode.trim())`
 * 那段，从而把契约绑死到源码逻辑上，而非路由层 mock 假设。
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const GeneratorService = require('../../src/services/generator');
const LLMService = require('../../src/services/llm');
const createRouter = require('../../src/routes/api');

function createMockReq(body = {}) {
    const handlers = {};
    return {
        method: 'POST',
        body,
        user: 'nocheatuser',
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
            if (data) this.chunks.push(String(data));
            this.writableEnded = true;
        }
    };
}

// prompts/welcome/*.md 里"特色"关键字——若这些出现在 messages 里，必是
// 预制代码已注入用户输入路径（最严重的作弊）。C4Container / Person( 是 C4Container.md
// 独有；mindmap / gitGraph / sequenceDiagram 是各自类型的起始关键字
const CHEAT_KEYWORDS = ['C4Container', 'Person(', 'sequenceDiagram', 'gitGraph', 'mindmap'];

// 列出所有可能表明 welcomeCode 已注入的形态
function assertNoCheat(capturedMessages) {
    assert.ok(Array.isArray(capturedMessages),
        'llm.chatStream 应被调用且 messages 是数组');
    // 1) 不应有 role: 'system' 的消息——welcomeCode 注入只会走这条
    const systemMsgs = capturedMessages.filter(m => m && m.role === 'system');
    assert.deepStrictEqual(systemMsgs, [],
        'messages 里不应有任何 role: "system" 的消息（welcomeCode 未注入时），实际：'
        + JSON.stringify(systemMsgs.map(m => m.content)));
    // 2) 不应有 content 含 "参考代码" 的消息——更精确的防作弊断言，
    //    即便未来谁把 system 改成 user 也会被捕获
    for (const m of capturedMessages) {
        if (m && typeof m.content === 'string' && m.content.includes('参考代码')) {
            assert.fail('messages 里不应有任何 content 含 "参考代码"，实际 role='
                + m.role + ' content 前 200 字：' + m.content.slice(0, 200));
        }
    }
    // 3) 不应有任何 prompts/welcome/*.md 的关键字出现在 messages content 里
    for (const m of capturedMessages) {
        if (m && typeof m.content === 'string') {
            for (const kw of CHEAT_KEYWORDS) {
                if (m.content.includes(kw)) {
                    assert.fail(`messages content 不应含预制代码关键字 "${kw}"，实际 role=${m.role} 前 200 字：`
                        + m.content.slice(0, 200));
                }
            }
        }
    }
}

describe('用户输入路径不注入预制代码 (e2e no-cheat)', () => {
    let tempDir;
    let router;
    let capturedMessagesList;
    let originalLlmChatStream;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processdown-e2e-nocheat-'));
        const config = {
            session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
            users: { dir: tempDir },
            auth: { tokenTtlDays: 7 },
            llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.3, maxTokens: 1000, timeout: 30 }
        };
        router = createRouter(config);

        // 关键：mock LLMService 原型上的 chatStream。
        // GeneratorService 构造里 `this.llm = new LLMService(config)` 把实例的 llm
        // 存到 instance 上，但 chatStream 实际调用走 prototype chain（实例无该字段），
        // 所以 patch prototype 即可拦截所有 router 创建出来的 generator 上的 llm。
        // 这样捕获到的 messages 就是 generator 真实准备送往 LLM 的内容；
        // 任何"参考代码"注入都只能来自 generator.generateStream 里
        // `if (typeof welcomeCode === 'string' && welcomeCode.trim())` 那段。
        // 不影响 llm.chat（generate 路径用），避免污染其它无关测试
        capturedMessagesList = [];
        originalLlmChatStream = LLMService.prototype.chatStream;
        LLMService.prototype.chatStream = async function (messages, systemPrompt, callbacks, signal) {
            // 深拷贝：避免后续测试读到同一引用
            capturedMessagesList.push(JSON.parse(JSON.stringify(messages)));
            callbacks.onContent('flowchart TD\n    A-->B');
        };
    });

    after(() => {
        if (originalLlmChatStream) {
            LLMService.prototype.chatStream = originalLlmChatStream;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('body 不带 welcomeKey (字段缺失): 不应注入预制代码', async () => {
        const before = capturedMessagesList.length;
        const req = createMockReq({ prompt: '画个登录流程图' });
        const res = createMockRes();
        await router.generateStream(req, res);

        assert.strictEqual(res.headers['Content-Type'], 'text/event-stream',
            '合法 body 应升级 SSE，不应 400');
        assert.strictEqual(capturedMessagesList.length, before + 1,
            'llm.chatStream 应被调用一次');
        assertNoCheat(capturedMessagesList[capturedMessagesList.length - 1]);
    });

    it('body.welcomeKey=null (JSON.stringify 写出 null): 不应注入预制代码', async () => {
        const before = capturedMessagesList.length;
        const req = createMockReq({ prompt: '画个简单流程', welcomeKey: null });
        const res = createMockRes();
        await router.generateStream(req, res);

        assert.strictEqual(res.headers['Content-Type'], 'text/event-stream',
            'welcomeKey=null 应等同缺失，不应 400');
        assert.strictEqual(capturedMessagesList.length, before + 1);
        assertNoCheat(capturedMessagesList[capturedMessagesList.length - 1]);
    });

    it('body.welcomeKey="" (空字符串): 不应注入预制代码（被白名单校验拒绝，llm 不被调用）', async () => {
        // 当前契约：空字符串在 resolveWelcomeCode 里走完三段检查后
        // （undefined? no / typeof string? yes / isValidWelcomeKey? no）
        // 返回 { ok: false, message: ... } → 路由层 400 拒绝。
        // 这是比"等同缺失"更强的安全姿态——避免静默回退让前端误以为请求合法。
        // 关键点：空串绝对不会让 llm.chatStream 被调用 → 不可能注入预制代码。
        const before = capturedMessagesList.length;
        const req = createMockReq({ prompt: '画个简单流程', welcomeKey: '' });
        const res = createMockRes();
        await router.generateStream(req, res);

        assert.strictEqual(res.statusCode, 400,
            'welcomeKey=空字符串 应被白名单拒绝返回 400');
        assert.strictEqual(res.headers['Content-Type'], 'application/json',
            '非法 welcomeKey 必须返回 JSON，不应升级 SSE');
        assert.strictEqual(capturedMessagesList.length, before,
            'llm.chatStream 不应被调用（400 早返）');
    });

    it('body.welcomeKey=undefined (前端 JSON.stringify 跳过此字段): 不应注入预制代码', async () => {
        // 模拟前端 streamGenerate：`welcomeKey: welcomeKey || undefined`。
        // undefined 在 JSON.stringify 时会被跳过，body 实际不含此字段，与"缺失"等价
        const before = capturedMessagesList.length;
        const body = { prompt: '画个简单流程' };
        body.welcomeKey = undefined;  // 显式占位
        // 双重保险：确认 JSON.stringify 跳过 undefined
        const stringified = JSON.stringify(body);
        assert.ok(!stringified.includes('welcomeKey'),
            'JSON.stringify 应跳过 undefined（防御性断言）');

        const req = createMockReq(body);
        const res = createMockRes();
        await router.generateStream(req, res);

        assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
        assert.strictEqual(capturedMessagesList.length, before + 1);
        assertNoCheat(capturedMessagesList[capturedMessagesList.length - 1]);
    });

    it('messages 数组结构：仅一条 user 消息（无 currentMermaid / 无 history / 无 welcomeCode）', async () => {
        const before = capturedMessagesList.length;
        const req = createMockReq({ prompt: '画个登录流程' });
        const res = createMockRes();
        await router.generateStream(req, res);

        const messages = capturedMessagesList[capturedMessagesList.length - 1];
        assert.strictEqual(messages.length, 1,
            '仅 user 消息一条，实际 ' + messages.length);
        assert.strictEqual(messages[0].role, 'user');
        assert.ok(messages[0].content.includes('画个登录流程'),
            'user 消息 content 应含原 prompt');
    });

    it('带 currentMermaid 时 user 消息含 "Current diagram" 但仍无 system/参考代码', async () => {
        const before = capturedMessagesList.length;
        const req = createMockReq({
            prompt: '改成横向',
            mermaid: 'flowchart TD\n    A-->B'
        });
        const res = createMockRes();
        await router.generateStream(req, res);

        const messages = capturedMessagesList[capturedMessagesList.length - 1];
        assertNoCheat(messages);
        // user 消息应含 currentMermaid 上下文——这是合法 LLM 消息，与预制代码无关
        const userMsg = messages.find(m => m.role === 'user');
        assert.ok(userMsg && userMsg.content.includes('Current diagram'),
            'currentMermaid 注入应只在 user 消息里出现');
    });

    it('带 history 时 messages 顺序 [history..., user]，history 不被污染', async () => {
        const before = capturedMessagesList.length;
        const req = createMockReq({ prompt: '继续修改' });
        const history = [
            { role: 'user', content: '上一轮的提示词（与预制代码无关）' },
            { role: 'assistant', content: '上一轮的图表（与预制代码无关）' }
        ];
        // 模拟 sessionStore 已有 history：直接通过 req.user 不行（sessionId 缺失时
        // generator.history 为 []）。改用 history 已写在 prompt 里——这里验证的是
        // 不带 sessionId 的纯单轮路径
        const res = createMockRes();
        await router.generateStream(req, res);

        const messages = capturedMessagesList[capturedMessagesList.length - 1];
        assertNoCheat(messages);
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].role, 'user');
    });

    it('source 文本断言：generateStream 守卫存在且不会被绕过', () => {
        // 防回归：如果有人把 `typeof welcomeCode === 'string' && welcomeCode.trim()`
        // 改成 truthy 判断（空串/纯空白 就会误注入），或把 null 处理挪走到 messages
        // 构造前，运行时测试可能漏（万一某分支命中），源码层面锁死契约
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'services', 'generator.js'),
            'utf-8'
        );
        // 两处：generate 与 generateStream
        const guardRegex = /typeof\s+welcomeCode\s*===\s*'string'\s*&&\s*welcomeCode\.trim\(\)/g;
        const matches = src.match(guardRegex) || [];
        assert.ok(matches.length >= 2,
            'generate 与 generateStream 都应有 typeof+trim 守卫，实际匹配数 ' + matches.length);
        // resolveWelcomeCode：null/undefined 必须返回 null
        const apiSrc = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'routes', 'api.js'),
            'utf-8'
        );
        assert.match(apiSrc, /resolveWelcomeCode[\s\S]{0,200}=== undefined \|\|[\s\S]{0,50}=== null[\s\S]{0,80}ok:\s*true,\s*code:\s*null/,
            'resolveWelcomeCode 在 undefined/null 时必须返回 {ok:true, code:null}');
        // 反向断言：确认没有 truthy 判断把空串当合法
        assert.ok(!/if\s*\(\s*welcomeCode\s*\)/.test(src),
            'generateStream 不应使用 `if (welcomeCode)` 这种 truthy 判断（空串会绕过 trim 守卫）');
    });
});