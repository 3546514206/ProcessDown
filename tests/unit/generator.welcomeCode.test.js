'use strict';

// GeneratorService welcomeCode 透传测试：
// 覆盖 generate / generateStream 在 welcomeCode 传入/不传入时的 messages 构造。
// mock 掉 GeneratorService.llm.chat 与 chatStream，捕获传给 LLM 的 messages 数组，
// 断言：null/空字符串/纯空白 时不注入；非空时预制代码并入最后一条 user 消息的
// content 末尾（含 "参考代码" 引导语 + welcomeCode 原文 + mermaid fenced block），
// messages 里不出现任何 role==='system' 的消息--生产 DeepSeek 系后端不接受
// 「user 之后再跟 system」的非标准消息排列。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const GeneratorService = require('../../src/services/generator');

const MERMAID = 'flowchart TD\n    A-->B';

// 直接构造 GeneratorService 并替换 llm 层：捕获 messages，回吐可提取的 mermaid 代码
function createGenerator() {
    const config = {
        llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.3, maxTokens: 100, timeout: 5 }
    };
    const gen = new GeneratorService(config);
    gen.capturedMessages = null;
    gen.capturedSystem = null;
    gen.llm = {
        chat: async (messages, systemPrompt) => {
            gen.capturedMessages = messages;
            gen.capturedSystem = systemPrompt;
            return '```mermaid\n' + MERMAID + '\n```';
        },
        chatStream: async (messages, systemPrompt, callbacks) => {
            gen.capturedMessages = messages;
            gen.capturedSystem = systemPrompt;
            callbacks.onContent('```mermaid\n' + MERMAID + '\n```');
        }
    };
    return gen;
}

// 断言注入形态：无 system 消息；最后一条 user 消息同时含原 user 内容、
// "参考代码" 引导语、welcomeCode 原文与 mermaid fenced block。
function assertMergedIntoLastUser(messages, originalSnippet, welcomeCode) {
    assert.ok(!messages.some(m => m.role === 'system'),
        '不应有任何 role==="system" 的消息（welcomeCode 应并入 user content）');
    const last = messages[messages.length - 1];
    assert.strictEqual(last.role, 'user', '最后一条消息应是 user');
    assert.ok(last.content.includes(originalSnippet),
        'user 消息应保留原 user 内容（prompt / Current diagram 块）');
    assert.ok(last.content.includes('参考代码'),
        'user 消息应包含 "参考代码" 引导语');
    assert.ok(last.content.includes(welcomeCode),
        'user 消息应包含 welcomeCode 原文');
    assert.ok(last.content.includes('```mermaid'),
        'user 消息应含 mermaid 代码块包裹');
}

// 断言未注入形态：无 system 消息，且任何消息 content 都不含 "参考代码"。
function assertNotInjected(messages) {
    assert.ok(!messages.some(m => m.role === 'system'),
        '不应有任何 role==="system" 的消息');
    assert.ok(!messages.some(m => typeof m.content === 'string' && m.content.includes('参考代码')),
        '未传有效 welcomeCode 时 user 消息不应含 "参考代码" 注入块');
}

describe('GeneratorService welcomeCode 注入', () => {
    describe('generate()', () => {
        it('welcomeCode=null: messages 末尾是 user，无 system', async () => {
            const gen = createGenerator();
            const code = await gen.generate('画个流程图', null, [], 'light', null);

            assert.strictEqual(code, MERMAID);
            assert.ok(Array.isArray(gen.capturedMessages), '应捕获 messages 数组');
            assert.strictEqual(gen.capturedMessages.length, 1, '仅 1 条 user 消息');
            assert.strictEqual(gen.capturedMessages[0].role, 'user');
            assert.strictEqual(gen.capturedMessages[0].content.includes('画个流程图'), true);
            // 不应有 system 消息
            assert.ok(!gen.capturedMessages.some(m => m.role === 'system'),
                'welcomeCode=null 时不应追加 system 消息');
        });

        it('welcomeCode=缺省 (未传): 同 null，不注入', async () => {
            const gen = createGenerator();
            await gen.generate('画个流程图');

            assert.ok(!gen.capturedMessages.some(m => m.role === 'system'),
                '缺省 welcomeCode 应等同 null');
        });

        it('welcomeCode="flowchart TD\\nA-->B": 并入最后一条 user 消息，无 system 消息', async () => {
            const gen = createGenerator();
            const welcomeCode = 'flowchart TD\nA-->B';
            await gen.generate('画个流程图', null, [], 'light', welcomeCode);

            assert.strictEqual(gen.capturedMessages.length, 1,
                '注入不应增加消息条数（仍是那 1 条 user）');
            assertMergedIntoLastUser(gen.capturedMessages, '画个流程图', welcomeCode);
        });

        it('welcomeCode=空字符串 "": 不注入', async () => {
            const gen = createGenerator();
            await gen.generate('画个流程图', null, [], 'light', '');

            assertNotInjected(gen.capturedMessages);
        });

        it('welcomeCode="   " (纯空白): 不注入', async () => {
            const gen = createGenerator();
            await gen.generate('画个流程图', null, [], 'light', '   ');

            assertNotInjected(gen.capturedMessages);
        });

        it('welcomeCode="\\n\\t\\n" (混合空白): 不注入', async () => {
            const gen = createGenerator();
            await gen.generate('画个流程图', null, [], 'light', '\n\t\n');

            assertNotInjected(gen.capturedMessages);
        });

        it('welcomeCode 与 currentMermaid 共存: 单条 user 消息同时含 Current diagram 块与 welcomeCode', async () => {
            const gen = createGenerator();
            const welcomeCode = 'flowchart TD\nA-->B';
            await gen.generate('改成深色', 'flowchart LR\nX-->Y', [], 'dark', welcomeCode);

            assert.strictEqual(gen.capturedMessages.length, 1);
            assert.strictEqual(gen.capturedMessages[0].role, 'user');
            assertMergedIntoLastUser(gen.capturedMessages, 'Current diagram', welcomeCode);
        });

        it('welcomeCode 与 history 共存: 并入最后一条 user 消息（history 条目不被修改）', async () => {
            const gen = createGenerator();
            const history = [
                { role: 'user', content: '上一轮提示词' },
                { role: 'assistant', content: '上一轮图表' }
            ];
            await gen.generate('新一轮', null, history, 'light', 'flowchart TD\nA-->B');

            assert.strictEqual(gen.capturedMessages.length, 3);
            assert.deepStrictEqual(
                gen.capturedMessages.map(m => m.role),
                ['user', 'assistant', 'user'],
                'history 完整保留 + 新 user（注入不增加消息条数）'
            );
            // history 内容不被修改
            assert.strictEqual(gen.capturedMessages[0].content, '上一轮提示词');
            assert.strictEqual(gen.capturedMessages[1].content, '上一轮图表');
            // 注入落在最后一条（新构造的）user 消息上
            assert.ok(gen.capturedMessages[2].content.includes('新一轮'),
                '新 user 消息应保留本轮 prompt 原文');
            assert.ok(gen.capturedMessages[2].content.includes('参考代码'),
                '新 user 消息应含注入块');
        });

        it('welcomeCode 传入时 LLM 收到的 system prompt 仍带 theme 适配指令', async () => {
            const gen = createGenerator();
            await gen.generate('p', null, [], 'dark', 'flowchart TD\nA-->B');

            assert.ok(gen.capturedSystem.includes('深色主题'),
                'theme=dark 应追加深色配色指令');
            // 注入并入 user content，system prompt 本身（主题指令）保持原样
            const last = gen.capturedMessages[gen.capturedMessages.length - 1];
            assert.ok(last.content.includes('参考代码'));
        });
    });

    describe('generateStream()', () => {
        it('welcomeCode=null: messages 末尾是 user，无 system', async () => {
            const gen = createGenerator();
            let onDoneArg = null;
            const result = await gen.generateStream('画个流程图', null, [], {
                onContent: () => {},
                onDone: (arg) => { onDoneArg = arg; }
            }, undefined, 'light', null);

            assert.strictEqual(result.mermaid, MERMAID);
            assert.ok(Array.isArray(gen.capturedMessages));
            assert.strictEqual(gen.capturedMessages.length, 1);
            assert.strictEqual(gen.capturedMessages[0].role, 'user');
            assert.ok(!gen.capturedMessages.some(m => m.role === 'system'),
                'welcomeCode=null 时不应追加 system 消息');
            assert.ok(onDoneArg, 'onDone 应被回调');
        });

        it('welcomeCode="flowchart TD\\nA-->B": 并入最后一条 user 消息，无 system 消息', async () => {
            const gen = createGenerator();
            const welcomeCode = 'flowchart TD\nA-->B';
            await gen.generateStream('画个流程图', null, [], {
                onContent: () => {},
                onDone: () => {}
            }, undefined, 'light', welcomeCode);

            assert.strictEqual(gen.capturedMessages.length, 1,
                '注入不应增加消息条数（仍是那 1 条 user）');
            assertMergedIntoLastUser(gen.capturedMessages, '画个流程图', welcomeCode);
        });

        it('welcomeCode=空字符串 "": 不注入', async () => {
            const gen = createGenerator();
            await gen.generateStream('画个流程图', null, [], {
                onContent: () => {},
                onDone: () => {}
            }, undefined, 'light', '');

            assertNotInjected(gen.capturedMessages);
        });

        it('welcomeCode="   " (纯空白): 不注入', async () => {
            const gen = createGenerator();
            await gen.generateStream('画个流程图', null, [], {
                onContent: () => {},
                onDone: () => {}
            }, undefined, 'light', '   ');

            assertNotInjected(gen.capturedMessages);
        });

        it('welcomeCode 传入时 history 不被污染', async () => {
            const gen = createGenerator();
            const history = [
                { role: 'user', content: 'prev' },
                { role: 'assistant', content: 'flowchart LR\n  P-->Q' }
            ];
            await gen.generateStream('改一下', null, history, {
                onContent: () => {},
                onDone: () => {}
            }, undefined, 'light', 'flowchart TD\nA-->B');

            // 不污染 history: 注入只落在最后一条新构造的 user 消息上，前 2 条 history 完整保留
            assert.strictEqual(gen.capturedMessages.length, 3);
            assert.strictEqual(gen.capturedMessages[0].content, 'prev');
            assert.strictEqual(gen.capturedMessages[1].content, 'flowchart LR\n  P-->Q');
            assert.strictEqual(gen.capturedMessages[2].role, 'user');
            assert.ok(gen.capturedMessages[2].content.includes('参考代码'));
        });
    });
});
