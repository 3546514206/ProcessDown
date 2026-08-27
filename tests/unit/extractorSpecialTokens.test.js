'use strict';

// LLM 特殊 token 字面泄漏的剥离测试：
//   (1) stripLlmSpecialTokens 纯函数语义（全角 ｜ 变体 / ASCII tokenizer 专名变体 /
//       合法全角竖线文本不受影响 / 非字符串入参原样返回）。
//   (2) extractMermaidCode 集成：think 剥离之后的特殊 token 剥离生效。
//   (3) generateStream 回退路径：extract 失败时回退串也要过 stripLlmSpecialTokens，
//       后端泄漏的 end-of-sentence token 不能原样下发给前端。

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const { stripLlmSpecialTokens, extractMermaidCode } = require('../../src/services/extractor');
const GeneratorService = require('../../src/services/generator');

// generator 内部单例 logger 会把 warn 落盘到 run/processdown.log，stub 掉避免污染
const logger = require('../../src/utils/logger');
before(() => {
    logger.info = () => {};
    logger.warn = () => {};
    logger.error = () => {};
    logger.debug = () => {};
});

describe('stripLlmSpecialTokens', () => {
    it('全角 end-of-sentence token 整体剥离', () => {
        assert.strictEqual(stripLlmSpecialTokens('<｜end▁of▁sentence｜>'), '');
    });

    it('全角 begin-of-sentence token 整体剥离', () => {
        assert.strictEqual(stripLlmSpecialTokens('<｜begin▁of▁sentence｜>'), '');
    });

    it('ASCII im_end token 剥离', () => {
        assert.strictEqual(stripLlmSpecialTokens('<|im_end|>'), '');
    });

    it('ASCII endoftext token 剥离', () => {
        assert.strictEqual(stripLlmSpecialTokens('<|endoftext|>'), '');
    });

    it('混在合法代码尾部的 token 只剥 token 本身', () => {
        assert.strictEqual(
            stripLlmSpecialTokens('flowchart TD\nA-->B<｜end▁of▁sentence｜>'),
            'flowchart TD\nA-->B'
        );
    });

    it('无 <> 包裹的全角竖线是合法文本，原样保留', () => {
        const text = 'A[文本｜竖线]';
        assert.strictEqual(stripLlmSpecialTokens(text), text);
    });

    it('非字符串入参原样返回（null/undefined/数字）', () => {
        assert.strictEqual(stripLlmSpecialTokens(null), null);
        assert.strictEqual(stripLlmSpecialTokens(undefined), undefined);
        assert.strictEqual(stripLlmSpecialTokens(42), 42);
    });
});

describe('extractMermaidCode 集成：特殊 token 剥离', () => {
    it('图源尾部泄漏的 token 不出现在提取结果里', () => {
        const result = extractMermaidCode('flowchart TD\nA[开始]-->B\n<｜end▁of▁sentence｜>');
        assert.ok(result, '应能提取出 mermaid 代码');
        assert.ok(!result.includes('<｜'), '提取结果不应含特殊 token');
        assert.ok(result.includes('A[开始]-->B'), '提取结果应保留图源正文');
    });

    it('纯 token 输入提取结果为 null', () => {
        assert.strictEqual(extractMermaidCode('<｜end▁of▁sentence｜>'), null);
    });
});

describe('generateStream 回退路径：特殊 token 剥离', () => {
    it('LLM 只吐 token 时，回退串也要剥离，返回 {mermaid: \'\', extracted: false}', async () => {
        const gen = new GeneratorService({
            llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.3, maxTokens: 100, timeout: 5 }
        });
        // 后端泄漏场景：content delta 只有 end-of-sentence token，无任何可提取代码
        gen.llm = {
            chatStream: async (messages, systemPrompt, callbacks) => {
                callbacks.onContent('<｜end▁of▁sentence｜>');
            }
        };

        const result = await gen.generateStream('画个流程图', null, [], {
            onContent: () => {},
            onDone: () => {}
        });

        assert.strictEqual(result.mermaid, '', '回退串应剥离 token 后为空串，而非原样下发 token');
        assert.strictEqual(result.extracted, false);
        assert.deepStrictEqual(result.fixes, []);
    });
});
