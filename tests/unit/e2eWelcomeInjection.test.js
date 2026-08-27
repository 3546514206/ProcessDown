'use strict';

// 端到端验证欢迎场景预制代码注入到 LLM 请求的完整链路：
//   router.generateStream -> resolveWelcomeCode -> GeneratorService.generateStream
//   -> llm.chatStream (captured)
//
// 链路覆盖：
//   (1) 4 个 chip key (c4-ecommerce / mindmap-genai / git-enterprise-flow /
//       seq-spring-bean) 各跑一遍，断言 LLM 收到的 messages 是单条 user 消息，
//       且其 content 含 "参考代码" + 对应 .md 文件的特征片段（预制代码并入
//       user content，而非追加尾部 system 消息--生产 DeepSeek 系后端不接受
//       「user 之后再跟 system」的非标准排列）。
//   (2) 无 currentMermaid 时 messages 仅 1 条 user；有 currentMermaid 时也仅
//       1 条 user，且同时含 "Current diagram" 块与 welcomeCode 特征片段。
//   (3) 不传 welcomeKey (走原 LLM 路径) 时，messages 仅有 1 条 user、无 system。
//
// Mock 策略：替换 LLMService.prototype.chatStream，比 mock GeneratorService.
// generateStream 更彻底--能拿到 generator 自己构造的完整 messages 数组
// (history + user)。mock 收到 onContent 后回吐一份合法 mermaid 代码，
// 让 generator 的 extract + autoFix 链能完整跑完、回调 onDone。

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LLMService = require('../../src/services/llm');
const createRouter = require('../../src/routes/api');
const { extractMermaidFromMarkdown, WELCOME_FILE } = require('../../src/services/welcomeCode');

// 单例 logger 在 generator / router 全程都会调 info/warn/error，落盘到
// run/processdown.log；本测试跑在项目根，logger 默认指向真实日志文件，会污染。
// 在 before 里 stub 掉 warn/error/info/debug。
const logger = require('../../src/utils/logger');

const originalChatStream = LLMService.prototype.chatStream;

// 复用既有路由测试的 createMockReq / createMockRes：req 需支持 on('close', ...)
// （generateStream 路由会注册），res 需支持 SSE 流式写入与 writableEnded。
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
        write(data) {
            if (!this.writableEnded) this.chunks.push(String(data));
        },
        end(data) {
            if (data) {
                if (typeof data === 'string' || Buffer.isBuffer(data)) {
                    this.chunks.push(String(data));
                }
                this.body = data;
            }
            this.writableEnded = true;
        }
    };
}

// 每个 chip key 的"特征片段"--必须出现在从 .md 抽出的实际代码里，不能写死成
// 字符串字面量；这里用"实际抽取结果的关键子串"作为标记，保证将来 .md 内容
// 微调时仍能命中同样的语义意图，而不是死扣字符串。
function featureSnippetFor(key) {
    switch (key) {
        case 'c4-ecommerce': return ['C4Container', 'Person(buyer'];
        case 'mindmap-genai': return ['mindmap', '生成式 AI'];
        case 'git-enterprise-flow': return ['gitGraph', 'cherry-pick'];
        case 'seq-spring-bean': return ['sequenceDiagram', 'autonumber'];
        default: throw new Error(`unknown key: ${key}`);
    }
}

describe('欢迎场景预制代码注入 LLM 请求 - 端到端链路', () => {
    let tempDir;
    let router;
    let capture;

    before(() => {
        // stub logger：避免污染 run/processdown.log
        logger.info = () => {};
        logger.warn = () => {};
        logger.error = () => {};
        logger.debug = () => {};

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-welcome-injection-'));
        const config = {
            session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
            users: { dir: tempDir },
            auth: { tokenTtlDays: 7 },
            llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.3, maxTokens: 1000, timeout: 30 }
        };
        router = createRouter(config);

        // 替换 LLMService.prototype.chatStream：捕获 (messages, systemPrompt, callbacks, signal)。
        // onContent 回吐一份 ```mermaid...``` 包裹的合法代码，让 generator 的
        // extractMermaidCode + autoFix 链路跑完，确保 onDone 被调用、SSE done 事件落地。
        LLMService.prototype.chatStream = async function (messages, systemPrompt, callbacks, signal) {
            capture.lastMessages = messages;
            capture.lastSystem = systemPrompt;
            capture.lastSignal = signal;
            const mockContent = '```mermaid\nflowchart TD\n    MOCK-->OK\n```';
            if (callbacks && typeof callbacks.onContent === 'function') {
                callbacks.onContent(mockContent);
            }
        };
        capture = { lastMessages: null, lastSystem: null, lastSignal: null };
    });

    after(() => {
        LLMService.prototype.chatStream = originalChatStream;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('4 个 chip key -> LLM 收到的 messages', () => {
        const chipKeys = ['c4-ecommerce', 'mindmap-genai', 'git-enterprise-flow', 'seq-spring-bean'];

        for (const key of chipKeys) {
            it(`${key}: 单条 user 消息并入 "参考代码" 与 ${path.basename(WELCOME_FILE[key])} 特征片段`, async () => {
                const req = createMockReq({
                    prompt: '点击 chip 后的占位 prompt',
                    welcomeKey: key
                });
                const res = createMockRes();
                await router.generateStream(req, res);

                // SSE 已升级
                assert.strictEqual(res.headers['Content-Type'], 'text/event-stream',
                    `welcomeKey="${key}" 应升级 SSE，未升级则 resolveWelcomeCode 失败或校验拦下`);

                // LLM 层捕获
                assert.ok(Array.isArray(capture.lastMessages),
                    'LLMService.chatStream mock 未被调用或 messages 不是数组');
                assert.strictEqual(capture.lastMessages.length, 1,
                    `${key}: messages 应只有 1 条 user（无 history，注入不增加条数）`);

                assert.strictEqual(capture.lastMessages[0].role, 'user', `${key}: 唯一一条应是 user`);

                // user 消息含 "参考代码" 引导语
                const userContent = capture.lastMessages[0].content;
                assert.ok(userContent.includes('参考代码'),
                    `${key}: user 消息应包含 "参考代码"`);
                assert.ok(userContent.includes('```mermaid'),
                    `${key}: user 消息应用 mermaid fenced block 包裹`);

                // user 消息含对应 .md 文件的特征片段
                const snippets = featureSnippetFor(key);
                for (const snippet of snippets) {
                    assert.ok(userContent.includes(snippet),
                        `${key}: user 消息应包含特征片段 "${snippet}"--预制代码没注入或文件名漂移`);
                }
            });
        }

        it('cross-check: 4 个 key 抽出的 user 消息 content 不应完全相同（确认不同 key -> 不同内容）', async () => {
            const contents = [];
            for (const key of chipKeys) {
                const req = createMockReq({ prompt: 'p', welcomeKey: key });
                const res = createMockRes();
                await router.generateStream(req, res);
                const last = capture.lastMessages[capture.lastMessages.length - 1];
                contents.push(last.content);
            }
            const unique = new Set(contents);
            assert.strictEqual(unique.size, chipKeys.length,
                '不同 chip key 应映射到不同的预制代码内容--若全相同则解析/分流出错');
        });
    });

    describe('messages 数量与顺序', () => {
        it('无 currentMermaid + welcomeKey 命中: messages 仅 1 条 user（含 prompt 原文与注入块，无 Current diagram）', async () => {
            const req = createMockReq({
                prompt: '画个流程图',
                welcomeKey: 'c4-ecommerce'
            });
            const res = createMockRes();
            await router.generateStream(req, res);

            assert.strictEqual(capture.lastMessages.length, 1);
            const userMsg = capture.lastMessages[0];
            assert.strictEqual(userMsg.role, 'user');
            assert.ok(!userMsg.content.includes('Current diagram'),
                '无 currentMermaid 时 user 消息不应含 "Current diagram" 块');
            assert.ok(userMsg.content.includes('画个流程图'),
                'user 消息应含 prompt 原文');
            assert.ok(userMsg.content.includes('参考代码'),
                'user 消息应含注入块');
            // welcomeCode 特征：c4-ecommerce 的 C4Container 关键字
            assert.ok(userMsg.content.includes('C4Container'),
                'user 消息应含 welcomeCode 特征片段');
        });

        it('有 currentMermaid + welcomeKey 命中: messages 仅 1 条 user（同时含 Current diagram 块与 welcomeCode）', async () => {
            const currentMermaid = 'flowchart LR\n    X-->Y';
            const req = createMockReq({
                prompt: '改成深色',
                mermaid: currentMermaid,
                welcomeKey: 'git-enterprise-flow'
            });
            const res = createMockRes();
            await router.generateStream(req, res);

            assert.strictEqual(capture.lastMessages.length, 1);
            const userMsg = capture.lastMessages[0];
            assert.strictEqual(userMsg.role, 'user');
            assert.ok(userMsg.content.includes('Current diagram'),
                '有 currentMermaid 时 user 消息应含 "Current diagram" 块');
            assert.ok(userMsg.content.includes(currentMermaid),
                'user 消息应内嵌 currentMermaid 原文');
            assert.ok(userMsg.content.includes('改成深色'),
                'user 消息应含 prompt 原文');
            assert.ok(userMsg.content.includes('参考代码'),
                'user 消息应含注入块');
            assert.ok(userMsg.content.includes('gitGraph'),
                'user 消息应含 gitGraph 预制代码特征');
        });

        it('welcomeCode 注入不影响 system prompt：systemPrompt 仍含 theme 适配指令', async () => {
            const req = createMockReq({
                prompt: 'p',
                welcomeKey: 'c4-ecommerce',
                theme: 'dark'
            });
            const res = createMockRes();
            await router.generateStream(req, res);

            // chatStream 第二个形参是 system prompt（来自 buildSystemPrompt(theme)）
            assert.ok(typeof capture.lastSystem === 'string');
            assert.ok(capture.lastSystem.includes('深色主题'),
                'theme=dark 应使 systemPrompt 含深色主题适配指令');
            assert.ok(capture.lastSystem.includes('图表类型') || capture.lastSystem.length > 100,
                'systemPrompt 应包含 prompts/system.txt 的完整内容（不是空字符串）');
        });
    });

    describe('不传 welcomeKey -> 走原 LLM 路径，messages 不追加 system', () => {
        it('不传 welcomeKey: messages 仅 user 一条，无 system', async () => {
            const req = createMockReq({ prompt: '用户自主输入' });
            const res = createMockRes();
            await router.generateStream(req, res);

            assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
            assert.strictEqual(capture.lastMessages.length, 1);
            assert.strictEqual(capture.lastMessages[0].role, 'user');
            assert.ok(!capture.lastMessages.some(m => m.role === 'system'),
                '未传 welcomeKey 时不应追加 system 消息（走原路径）');
            assert.ok(capture.lastMessages[0].content.includes('用户自主输入'));
        });
    });

    describe('content 实际来源校验（端到端证据）', () => {
        it('注入的 mermaid 代码 == prompts/welcome/<file> 抽出的代码（文件 -> loadWelcomeCode -> generator.messages 一致）', async () => {
            const projectRoot = path.join(__dirname, '..', '..');
            const key = 'c4-ecommerce';
            const fileName = WELCOME_FILE[key];
            const raw = fs.readFileSync(
                path.join(projectRoot, 'prompts', 'welcome', fileName),
                'utf-8'
            );
            const expectedExtracted = extractMermaidFromMarkdown(raw);

            const req = createMockReq({ prompt: 'p', welcomeKey: key });
            const res = createMockRes();
            await router.generateStream(req, res);

            const userContent = capture.lastMessages[0].content;
            // user 消息应包含整段抽出的预制代码（不能截断、不能改字）
            assert.ok(userContent.includes(expectedExtracted),
                'user 消息应包含完整预制代码--若只含部分则 resolveWelcomeCode 或 generator 拼接出错');
        });
    });
});
