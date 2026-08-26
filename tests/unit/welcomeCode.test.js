'use strict';

// src/services/welcomeCode.js 单元测试：
// 覆盖 WELCOME_KEYS / WELCOME_FILE / isValidWelcomeKey / extractMermaidFromMarkdown / loadWelcomeCode。
// 不引入 jsdom（项目未声明为 devDependency），纯 node:test + fs。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const {
    WELCOME_KEYS,
    WELCOME_FILE,
    isValidWelcomeKey,
    extractMermaidFromMarkdown,
    loadWelcomeCode
} = require('../../src/services/welcomeCode');

// stub logger：本文件里的 ENOENT 用例故意构造 fs.readFileSync 失败以验证
// loadWelcomeCode 容错；logger.warn 是单例，appendFileSync 写到
// run/processdown.log 会污染生产日志。require 必须在 welcomeCode.js 之后
// 才能覆盖它实际持有的 logger 引用。
const logger = require('../../src/utils/logger');
logger.warn = () => {};
logger.error = () => {};

describe('welcomeCode 模块', () => {
    describe('WELCOME_KEYS', () => {
        it('长度为 4', () => {
            assert.strictEqual(WELCOME_KEYS.length, 4);
        });

        it('四个 key 与 public/index.html chip key 一致', () => {
            // 与 index.html 里 .example-chip 的 data-example-key 同步：
            // 改任一侧必须同步另一侧，靠这个测试兜底
            assert.deepStrictEqual(
                [...WELCOME_KEYS].sort(),
                ['c4-ecommerce', 'git-enterprise-flow', 'mindmap-genai', 'seq-spring-bean']
            );
        });

        it('WELCOME_KEYS 是冻结数组', () => {
            assert.ok(Object.isFrozen(WELCOME_KEYS));
        });
    });

    describe('WELCOME_FILE', () => {
        it('每个白名单 key 都有非空文件名', () => {
            for (const key of WELCOME_KEYS) {
                const fileName = WELCOME_FILE[key];
                assert.ok(typeof fileName === 'string' && fileName.length > 0,
                    `key "${key}" 必须映射到非空文件名`);
                assert.ok(fileName.endsWith('.md'),
                    `welcome 文件应统一用 .md 后缀（"${key}" -> "${fileName}"）`);
            }
        });

        it('WELCOME_FILE 是冻结对象', () => {
            assert.ok(Object.isFrozen(WELCOME_FILE));
        });

        it('关键映射与文件名一一对应（防漂移）', () => {
            assert.strictEqual(WELCOME_FILE['c4-ecommerce'], 'C4Container.md');
            assert.strictEqual(WELCOME_FILE['mindmap-genai'], 'mindmap.md');
            assert.strictEqual(WELCOME_FILE['git-enterprise-flow'], 'gitGraph.md');
            assert.strictEqual(WELCOME_FILE['seq-spring-bean'], 'sequenceDiagram.md');
        });
    });

    describe('isValidWelcomeKey', () => {
        it('四个白名单 key 全 true', () => {
            for (const key of WELCOME_KEYS) {
                assert.strictEqual(isValidWelcomeKey(key), true, `key "${key}" 应被识别`);
            }
        });

        it('路径穿越字面量返回 false', () => {
            assert.strictEqual(isValidWelcomeKey('../etc/passwd'), false);
            assert.strictEqual(isValidWelcomeKey('..\\windows\\system32'), false);
            assert.strictEqual(isValidWelcomeKey('/etc/passwd'), false);
        });

        it('非字符串一律 false（null / undefined / 数字 / 对象 / 数组）', () => {
            assert.strictEqual(isValidWelcomeKey(null), false);
            assert.strictEqual(isValidWelcomeKey(undefined), false);
            assert.strictEqual(isValidWelcomeKey(123), false);
            assert.strictEqual(isValidWelcomeKey(0), false);
            assert.strictEqual(isValidWelcomeKey({}), false);
            assert.strictEqual(isValidWelcomeKey([]), false);
            assert.strictEqual(isValidWelcomeKey(true), false);
        });

        it('大小写敏感：大小写不匹配的字面量返回 false', () => {
            assert.strictEqual(isValidWelcomeKey('C4-ECOMMERCE'), false);
            assert.strictEqual(isValidWelcomeKey('Mindmap-Genai'), false);
        });

        it('空字符串返回 false', () => {
            assert.strictEqual(isValidWelcomeKey(''), false);
        });
    });

    describe('extractMermaidFromMarkdown', () => {
        it('```markdown\\nfoo\\n``` 抽出 foo', () => {
            const md = '```markdown\nflowchart TD\n    A-->B\n```';
            assert.strictEqual(extractMermaidFromMarkdown(md), 'flowchart TD\n    A-->B');
        });

        it('```\\nbar\\n``` 抽出 bar（无语言标签）', () => {
            const md = '```\nsequenceDiagram\n    A->>B: hi\n```';
            assert.strictEqual(extractMermaidFromMarkdown(md), 'sequenceDiagram\n    A->>B: hi');
        });

        it('```MARKDOWN\\nfoo\\n``` 也兼容（大小写不敏感）', () => {
            const md = '```MARKDOWN\ngitGraph\n    commit\n```';
            assert.strictEqual(extractMermaidFromMarkdown(md), 'gitGraph\n    commit');
        });

        it('```mermaid\\nfoo\\n``` 不被识别（只兼容 markdown 标签与无标签）', () => {
            // 解析器只识别 ```markdown 与无标签两种 fenced block；
            // ```mermaid 是 mermaid 自己渲染时的格式，不应被误判为预制代码来源
            assert.strictEqual(extractMermaidFromMarkdown('```mermaid\nflowchart TD\nA-->B\n```'), null);
        });

        it('无 fenced block 返回 null', () => {
            assert.strictEqual(extractMermaidFromMarkdown('plain text only'), null);
            assert.strictEqual(extractMermaidFromMarkdown('hello\nworld'), null);
        });

        it('空字符串返回 null', () => {
            assert.strictEqual(extractMermaidFromMarkdown(''), null);
        });

        it('只有空白字符返回 null', () => {
            assert.strictEqual(extractMermaidFromMarkdown('   \n\n   '), null);
        });

        it('非字符串返回 null（null / undefined / 数字 / 对象 / 数组）', () => {
            assert.strictEqual(extractMermaidFromMarkdown(null), null);
            assert.strictEqual(extractMermaidFromMarkdown(undefined), null);
            assert.strictEqual(extractMermaidFromMarkdown(123), null);
            assert.strictEqual(extractMermaidFromMarkdown({}), null);
            assert.strictEqual(extractMermaidFromMarkdown([]), null);
            assert.strictEqual(extractMermaidFromMarkdown(true), null);
        });

        it('fenced block 内只有空白返回 null', () => {
            // 抽出后 trim 为空字符串，按设计视为无效
            const md = '```markdown\n   \n```';
            assert.strictEqual(extractMermaidFromMarkdown(md), null);
        });

        it('首尾空白不影响提取', () => {
            const md = '\n\n```markdown\nflowchart TD\nA-->B\n```\n\n';
            assert.strictEqual(extractMermaidFromMarkdown(md), 'flowchart TD\nA-->B');
        });

        it('CRLF 换行被规范化为 LF', () => {
            const md = '```markdown\r\nfoo\r\nbar\r\n```';
            assert.strictEqual(extractMermaidFromMarkdown(md), 'foo\nbar');
        });
    });

    describe('loadWelcomeCode', () => {
        it('四个白名单 key 全能加载出非空字符串', () => {
            for (const key of WELCOME_KEYS) {
                const code = loadWelcomeCode(key);
                assert.ok(typeof code === 'string' && code.length > 0,
                    `key "${key}" 应加载出非空字符串`);
            }
        });

        it('非白名单 key 返回 null（路径穿越安全）', () => {
            assert.strictEqual(loadWelcomeCode('../etc/passwd'), null);
            assert.strictEqual(loadWelcomeCode('..'), null);
            assert.strictEqual(loadWelcomeCode('unknown-key'), null);
            assert.strictEqual(loadWelcomeCode(''), null);
            assert.strictEqual(loadWelcomeCode(null), null);
            assert.strictEqual(loadWelcomeCode(undefined), null);
            assert.strictEqual(loadWelcomeCode(123), null);
        });

        it('opts.cwd 指向不存在的目录 -> 返回 null', () => {
            // isValidWelcomeKey 已先过滤非白名单 key；白名单 key + 不存在的
            // cwd 让 fs.readFileSync 抛 ENOENT，被 try/catch 兜底返回 null
            const code = loadWelcomeCode('c4-ecommerce', { cwd: '/path/that/definitely/does/not/exist' });
            assert.strictEqual(code, null);
        });

        it('opts.cwd 指向 prompts/welcome 的实际项目根：抽出内容首字符与对应 .md 文件 fenced 块一致', () => {
            // 这是"白名单 + 文件名映射 + 解析器"三件套的端到端校验：
            // loadWelcomeCode(key) 返回的字符串首字符，应 == 直接读 .md 并
            // extractMermaidFromMarkdown 后的首字符
            const projectRoot = path.join(__dirname, '..', '..');
            for (const key of WELCOME_KEYS) {
                const fileName = WELCOME_FILE[key];
                const raw = fs.readFileSync(
                    path.join(projectRoot, 'prompts', 'welcome', fileName),
                    'utf-8'
                );
                const expected = extractMermaidFromMarkdown(raw);
                const actual = loadWelcomeCode(key, { cwd: projectRoot });
                assert.ok(expected && expected.length > 0,
                    `原始文件 "${fileName}" 应抽出非空字符串`);
                assert.strictEqual(actual, expected,
                    `key "${key}" loadWelcomeCode 应 == 直接读 .md 并解析`);
                assert.strictEqual(actual[0], expected[0],
                    `key "${key}" 抽出内容首字符应一致`);
            }
        });

        it('opts.cwd 指向临时目录 + 不存在的文件 -> 返回 null（白名单通过但读不到）', () => {
            // 用 fs.mkdtempSync 创建临时 cwd，文件本来就不存在，应 null
            const tmpCwd = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'welcome-code-test-');
            try {
                const code = loadWelcomeCode('c4-ecommerce', { cwd: tmpCwd });
                assert.strictEqual(code, null);
            } finally {
                fs.rmSync(tmpCwd, { recursive: true, force: true });
            }
        });
    });
});