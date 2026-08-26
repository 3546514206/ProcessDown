'use strict';

// GeneratorService welcomeCode 透传测试：
// 覆盖 generate / generateStream 在 welcomeCode 传入/不传入时的 messages 构造。
// mock 掉 GeneratorService.llm.chat 与 chatStream，捕获传给 LLM 的 messages 数组，
// 断言尾部结构：null/空字符串/纯空白 时不追加 system 消息；非空时追加 system 消息
// 且 content 含 welcomeCode 与 "参考代码"。

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

        it('welcomeCode=缺省 (未传): 同 null，不追加 system', async () => {
            const gen = createGenerator();
            await gen.generate('画个流程图');

            assert.ok(!gen.capturedMessages.some(m => m.role === 'system'),
                '缺省 welcomeCode 应等同 null');
        });

        it('welcomeCode="flowchart TD\\nA-->B": messages 末尾追加 system 消息', async () => {
            const gen = createGenerator();
            const welcomeCode = 'flowchart TD\nA-->B';
            await gen.generate('画个流程图', null, [], 'light', welcomeCode);

            assert.strictEqual(gen.capturedMessages.length, 2,
                '应追加 1 条 system 消息（user + system）');
            const last = gen.capturedMessages[gen.capturedMessages.length - 1];
            assert.strictEqual(last.role, 'system', '末尾应是 system 消息');
            assert.ok(last.content.includes('参考代码'),
                'system 消息应包含 "参考代码" 引导语');
            assert.ok(last.content.includes('flowchart TD'),
                'system 消息应含 welcomeCode 文本');
            assert.ok(last.content.includes('```mermaid'),
                'system 消息应含 mermaid 代码块包裹');
        });

        it('welcomeCode=空字符串 "": 不追加 system 消息', async () => {
            const gen = createGenerator();
            await gen.generate('画个流程图', null, [], 'light', '');

            assert.ok(!gen.capturedMessages.some(m => m.role === 'system'),
                '空字符串应视为未传');
        });

        it('welcomeCode="   " (纯空白): 不追加 system 消息', async () => {
            const gen = createGenerator();
            await gen.generate('画个流程图', null, [], 'light', '   ');

            assert.ok(!gen.capturedMessages.some(m => m.role === 'system'),
                '纯空白应视为未传');
        });

        it('welcomeCode="\\n\\t\\n" (混合空白): 不追加 system 消息', async () => {
            const gen = createGenerator();
            await gen.generate('画个流程图', null, [], 'light', '\n\t\n');

            assert.ok(!gen.capturedMessages.some(m => m.role === 'system'),
                '混合空白应视为未传');
        });

        it('welcomeCode 与 currentMermaid 共存: messages 顺序 [user (含 currentMermaid), system (含 welcomeCode)]', async () => {
            const gen = createGenerator();
            await gen.generate('改成深色', 'flowchart LR\nX-->Y', [], 'dark', 'flowchart TD\nA-->B');

            assert.strictEqual(gen.capturedMessages.length, 2);
            assert.strictEqual(gen.capturedMessages[0].role, 'user');
            assert.ok(gen.capturedMessages[0].content.includes('Current diagram'),
                'first user 消息应包含 currentMermaid');
            assert.strictEqual(gen.capturedMessages[1].role, 'system');
            assert.ok(gen.capturedMessages[1].content.includes('flowchart TD\nA-->B'));
        });

        it('welcomeCode 与 history 共存: system 消息追加在 history + user 之后（不污染 history）', async () => {
            const gen = createGenerator();
            const history = [
                { role: 'user', content: '上一轮提示词' },
                { role: 'assistant', content: '上一轮图表' }
            ];
            await gen.generate('新一轮', null, history, 'light', 'flowchart TD\nA-->B');

            assert.strictEqual(gen.capturedMessages.length, 4);
            assert.deepStrictEqual(
                gen.capturedMessages.map(m => m.role),
                ['user', 'assistant', 'user', 'system'],
                'history 完整保留 + 新 user + 追加 system'
            );
            // history 内容不被修改
            assert.strictEqual(gen.capturedMessages[0].content, '上一轮提示词');
            assert.strictEqual(gen.capturedMessages[1].content, '上一轮图表');
            // 末尾 system 是新加的
            assert.ok(gen.capturedMessages[3].content.includes('参考代码'));
        });

        it('welcomeCode 传入时 LLM 收到的 system prompt 仍带 theme 适配指令', async () => {
            const gen = createGenerator();
            await gen.generate('p', null, [], 'dark', 'flowchart TD\nA-->B');

            assert.ok(gen.capturedSystem.includes('深色主题'),
                'theme=dark 应追加深色配色指令');
            // 同时确认是末尾追加了 system 消息，system prompt 本身（主题指令）保持原样
            const sysMsg = gen.capturedMessages.find(m => m.role === 'system');
            assert.ok(sysMsg.content.includes('参考代码'));
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

        it('welcomeCode="flowchart TD\\nA-->B": messages 末尾追加 system 消息', async () => {
            const gen = createGenerator();
            const welcomeCode = 'flowchart TD\nA-->B';
            await gen.generateStream('画个流程图', null, [], {
                onContent: () => {},
                onDone: () => {}
            }, undefined, 'light', welcomeCode);

            assert.strictEqual(gen.capturedMessages.length, 2);
            const last = gen.capturedMessages[gen.capturedMessages.length - 1];
            assert.strictEqual(last.role, 'system');
            assert.ok(last.content.includes('参考代码'));
            assert.ok(last.content.includes('flowchart TD'));
        });

        it('welcomeCode=空字符串 "": 不追加 system 消息', async () => {
            const gen = createGenerator();
            await gen.generateStream('画个流程图', null, [], {
                onContent: () => {},
                onDone: () => {}
            }, undefined, 'light', '');

            assert.ok(!gen.capturedMessages.some(m => m.role === 'system'),
                '空字符串应视为未传');
        });

        it('welcomeCode="   " (纯空白): 不追加 system 消息', async () => {
            const gen = createGenerator();
            await gen.generateStream('画个流程图', null, [], {
                onContent: () => {},
                onDone: () => {}
            }, undefined, 'light', '   ');

            assert.ok(!gen.capturedMessages.some(m => m.role === 'system'),
                '纯空白应视为未传');
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

            // 不污染 history: 仅末尾追加 system；前 2 条 history 完整保留
            assert.strictEqual(gen.capturedMessages.length, 4);
            assert.strictEqual(gen.capturedMessages[0].content, 'prev');
            assert.strictEqual(gen.capturedMessages[1].content, 'flowchart LR\n  P-->Q');
            assert.strictEqual(gen.capturedMessages[3].role, 'system');
        });
    });
});