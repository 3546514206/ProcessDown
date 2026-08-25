'use strict';

// 主题上送（任务 A）测试：
// 1. GeneratorService 三个入口（generate/regenerate/generateStream）收到 theme 后，
//    传给 LLM 的 system prompt 在 prompts/system.txt 基底之后追加了对应主题
//    （深色/浅色）的配色适配指令；
// 2. 路由层对 body.theme 做净化：'dark' -> 'dark'，非法值/缺失 -> 'light'
//    （不加 400 校验，兼容不带 theme 的旧客户端）。

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const GeneratorService = require('../../src/services/generator');
const createRouter = require('../../src/routes/api');

const MERMAID = 'flowchart TD\nA-->B';
// prompts/system.txt 首句，用于断言主题指令是"追加"而非"替换"system prompt
const SYSTEM_BASE_MARK = '你是一个专业的 Mermaid 图表生成助手';

// 直接构造 GeneratorService 并替换 llm 层：捕获 system prompt，回吐可提取的
// mermaid 代码，不打真实网络
function createGenerator() {
    const config = {
        llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.3, maxTokens: 100, timeout: 5 }
    };
    const gen = new GeneratorService(config);
    gen.capturedSystem = null;
    gen.llm = {
        chat: async (messages, systemPrompt) => {
            gen.capturedSystem = systemPrompt;
            return '```mermaid\n' + MERMAID + '\n```';
        },
        chatStream: async (messages, systemPrompt, callbacks) => {
            gen.capturedSystem = systemPrompt;
            callbacks.onContent('```mermaid\n' + MERMAID + '\n```');
        }
    };
    return gen;
}

// ---- GeneratorService 层 ------------------------------------------------------

describe('GeneratorService 主题适配指令', () => {
    it('generate(theme="dark")：system prompt 含深色配色指令，且保留原基底', async () => {
        const gen = createGenerator();
        const code = await gen.generate('画个流程图', null, [], 'dark');
        assert.strictEqual(code, MERMAID);
        assert.ok(gen.capturedSystem.includes(SYSTEM_BASE_MARK),
            'system prompt 必须保留 prompts/system.txt 基底（指令是追加不是替换）');
        assert.ok(gen.capturedSystem.includes('深色主题'),
            'dark 主题应追加深色配色适配指令');
        assert.ok(!gen.capturedSystem.includes('浅色主题'),
            'dark 主题不应出现浅色指令文案');
    });

    it('generate(theme="light")：system prompt 含浅色配色指令', async () => {
        const gen = createGenerator();
        await gen.generate('画个流程图', null, [], 'light');
        assert.ok(gen.capturedSystem.includes('浅色主题'),
            'light 主题应追加浅色配色适配指令');
        assert.ok(!gen.capturedSystem.includes('深色主题'),
            'light 主题不应出现深色指令文案');
    });

    it('generate 缺省 theme：回落浅色指令（与新默认一致）', async () => {
        const gen = createGenerator();
        await gen.generate('画个流程图');
        assert.ok(gen.capturedSystem.includes('浅色主题'),
            '未传 theme 应按默认 light 追加浅色指令');
    });

    it('regenerate(theme="dark")：同样追加深色配色指令', async () => {
        const gen = createGenerator();
        await gen.regenerate(MERMAID, '把 A 染红', 'dark');
        assert.ok(gen.capturedSystem.includes(SYSTEM_BASE_MARK), 'regenerate 保留 system 基底');
        assert.ok(gen.capturedSystem.includes('深色主题'),
            'regenerate 的 dark 主题应追加深色指令');
    });

    it('generateStream(theme="dark")：chatStream 收到含深色指令的 system prompt', async () => {
        const gen = createGenerator();
        let onDoneArg = null;
        const result = await gen.generateStream('画个流程图', null, [], {
            onContent: () => {},
            onDone: (arg) => { onDoneArg = arg; }
        }, undefined, 'dark');
        assert.ok(gen.capturedSystem.includes(SYSTEM_BASE_MARK), 'generateStream 保留 system 基底');
        assert.ok(gen.capturedSystem.includes('深色主题'),
            'generateStream 的 dark 主题应追加深色指令');
        assert.strictEqual(result.mermaid, MERMAID);
        assert.ok(onDoneArg, 'onDone 应被回调');
    });
});

// ---- 路由层净化 ---------------------------------------------------------------

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
    return {
        method: 'POST',
        body,
        user: 'themeuser',
        headers: {},
        on() {} // generateStream 的 req.on('close')，本测试不触发断开
    };
}

describe('路由层 theme 净化', () => {
    let tempDir;
    let router;
    const originalGenerate = GeneratorService.prototype.generate;
    const originalGenerateStream = GeneratorService.prototype.generateStream;
    const originalRegenerate = GeneratorService.prototype.regenerate;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processdown-theme-route-'));
        const config = {
            session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
            users: { dir: tempDir },
            auth: { tokenTtlDays: 7 },
            llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'm', temperature: 0.3, maxTokens: 100, timeout: 5 }
        };
        router = createRouter(config);
    });

    after(() => {
        GeneratorService.prototype.generate = originalGenerate;
        GeneratorService.prototype.generateStream = originalGenerateStream;
        GeneratorService.prototype.regenerate = originalRegenerate;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    // 三个路由统一断言：'dark' 原样透传，'trash'/缺失回落 'light'
    const cases = [
        { bodyTheme: 'dark', expected: 'dark' },
        { bodyTheme: 'trash', expected: 'light' },
        { bodyTheme: undefined, expected: 'light' }
    ];

    for (const { bodyTheme, expected } of cases) {
        it(`/api/generate theme=${String(bodyTheme)} -> generator 收到 '${expected}'`, async () => {
            let received = null;
            GeneratorService.prototype.generate = async (prompt, cur, history, theme) => {
                received = theme;
                return MERMAID;
            };
            const body = { prompt: '画个流程图' };
            if (bodyTheme !== undefined) body.theme = bodyTheme;
            await router.generate(createMockReq(body), createMockRes());
            assert.strictEqual(received, expected);
        });

        it(`/api/generate/stream theme=${String(bodyTheme)} -> generator 收到 '${expected}'`, async () => {
            let received = null;
            GeneratorService.prototype.generateStream = async (prompt, cur, history, cb, signal, theme) => {
                received = theme;
                cb.onDone && cb.onDone({ mermaid: MERMAID, fixes: [], extracted: true });
                return { mermaid: MERMAID, fixes: [], extracted: true };
            };
            const body = { prompt: '画个流程图' };
            if (bodyTheme !== undefined) body.theme = bodyTheme;
            await router.generateStream(createMockReq(body), createMockRes());
            assert.strictEqual(received, expected);
        });

        it(`/api/regenerate theme=${String(bodyTheme)} -> generator 收到 '${expected}'`, async () => {
            let received = null;
            GeneratorService.prototype.regenerate = async (mermaid, instruction, theme) => {
                received = theme;
                return MERMAID;
            };
            const body = { mermaid: MERMAID, instruction: '调整一下' };
            if (bodyTheme !== undefined) body.theme = bodyTheme;
            await router.regenerate(createMockReq(body), createMockRes());
            assert.strictEqual(received, expected);
        });
    }

    // typeof 守卫：非字符串值（如对象/数组/数字）一律落 light，避免未来重构
    // 把 '=== dark' 误改成 '== truthy' 时把任意非空对象当作 dark
    const nonStringCases = [
        { theme: 123, label: 'number' },
        { theme: ['dark'], label: 'array' },
        { theme: { value: 'dark' }, label: 'object' },
        { theme: null, label: 'null' }
    ];
    for (const { theme, label } of nonStringCases) {
        it(`/api/generate theme=${label} -> generator 收到 'light'`, async () => {
            let received = 'unset';
            GeneratorService.prototype.generate = async (prompt, cur, history, t) => {
                received = t;
                return MERMAID;
            };
            await router.generate(createMockReq({ prompt: '画图', theme }), createMockRes());
            assert.strictEqual(received, 'light',
                `非字符串 theme (${label}) 应落 light`);
        });
    }
});
