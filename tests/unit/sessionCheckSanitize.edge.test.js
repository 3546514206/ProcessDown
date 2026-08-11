'use strict';

/**
 * checkSession 净化（sanitization）回归测试。
 *
 * Bug 背景：历史会话恢复后图表无法渲染。根因是 checkSession 返回的
 * lastMermaid（最后一条 assistant content）未经净化，老数据里残留的
 * `gitGraph LR:` 等当前 vendored mermaid 不接受的语法会让
 * 前端 mermaid.render 抛错。开发已修：checkSession 返回前对 lastMermaid
 * 跑一遍 extractMermaidCode + autoFixMermaidCode，与 generate 链路保持单一
 * 净化真源；extract 返回 null（非 mermaid 内容）时保留原文，避免丢数据。
 *
 * 注（11.16.1）：frontmatter 不再剥离--bundle 已原生支持（processFrontmatter）。
 * 下方 frontmatter 用例已改为断言"保留 frontmatter"。
 *
 * 本文件通过真实 createRouter dispatch checkSession，用 mock SessionStore
 * 植入特定 history，验证返回的 lastMermaid 已被净化。与
 * extractorFrontmatter.edge.test.js（extract/autoFix 纯函数）互补：那里测
 * 净化函数本身，这里测 checkSession 是否正确接上了净化函数。
 *
 * 不与 sessionCheck.edge.test.js 的用例重叠：那里用 'a1'/'a2' 等非 mermaid
 * 文本测"取最后一条 assistant"的语义，恰好走 fallback 保留原文；这里专测
 * 净化真正生效的 mermaid 路径（gitGraph LR、frontmatter、幂等）。
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Patch GeneratorService.generate before createRouter so constructing the
// router (which news a GeneratorService) never reaches the network. None of
// these tests call generate; the patch is purely defensive for construction.
const GeneratorService = require('../../src/services/generator');
const originalGenerate = GeneratorService.prototype.generate;
GeneratorService.prototype.generate = async () => 'flowchart TD\n A-->B';

const createRouter = require('../../src/routes/api');
const { SessionStore } = require('../../src/services/sessionStore');

function createMockReq(method = 'POST', body = {}) {
    return { method, body, user: 'testuser' };
}

function createMockRes() {
    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        writeHead(code, headers) {
            res.statusCode = code;
            res.headers = { ...res.headers, ...headers };
        },
        end(data) { res.body = data; }
    };
    return res;
}

describe('POST /api/session/check - lastMermaid sanitization', () => {
    let tempDir;
    let sessionsDir;
    let config;
    let router;
    let seedStore;
    const ID = '550e8400-e29b-41d4-a716-446655440000';

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-check-sanitize-'));
    });
    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        GeneratorService.prototype.generate = originalGenerate;
    });
    beforeEach(() => {
        for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, entry.name), { recursive: true, force: true });
        }
        config = {
            session: { dir: tempDir, maxHistory: 20, ttlDays: 7 },
            // 用户会话目录指向 tempDir，路由据此派生 tempDir/testuser/sessions/
            users: { dir: tempDir },
            llm: {
                baseUrl: 'http://fake', apiKey: 'fake-key', model: 'fake-model',
                temperature: 0.7, maxTokens: 1000, timeout: 30000
            },
            server: { port: 3000, timeout: 30000 },
            cors: { enabled: true, origins: ['*'] },
            rateLimit: { enabled: false, maxRequests: 100, windowMs: 60000 },
            auth: { enabled: false, tokenTtlDays: 7 },
            health: { checkLlm: false }
        };
        router = createRouter(config);
        // A second SessionStore over the SAME user sessions dir lets us seed
        // history directly with distinct assistant contents. Must match the dir
        // the router derives for req.user.
        sessionsDir = path.join(tempDir, 'testuser', 'sessions');
        seedStore = new SessionStore({ session: { dir: sessionsDir, maxHistory: 20, ttlDays: 7 } });
    });

    it('sanitizes gitGraph LR: header -> gitGraph (orientation + colon stripped)', () => {
        // Bug 报告的 canonical 场景：老历史存了 `gitGraph LR:`，当前 vendored
        // mermaid（3.0.9）的 gitGraph 解析器只接受 `gitGraph` / `gitGraph:{}`，
        // 遇到 `LR` 会 "Parse error on line 1"。checkSession 必须在返回前剥掉
        // 方向词，使恢复后的图表可渲染。
        const raw = 'gitGraph LR:\n    commit id: "init"';
        seedStore.append(ID, '画一个 git 提交图', raw);

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: ID }), res);

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.exists, true);
        assert.strictEqual(body.lastMermaid, 'gitGraph\n    commit id: "init"');
    });

    it('preserves frontmatter in the last assistant content (bundle supports it)', () => {
        // 11.16.1 bundle 原生支持 frontmatter（processFrontmatter + js-yaml），
        // extractMermaidCode 不再剥离。checkSession 返回的 lastMermaid 保留
        // frontmatter 块，让前端 mermaid.render 自行解析 title 与 config。
        const raw = '---\nconfig:\n  theme: base\n---\ngitGraph\n    commit id: "init"';
        seedStore.append(ID, '画一个 git 提交图', raw);

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: ID }), res);

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.exists, true);
        assert.strictEqual(body.lastMermaid, raw);
    });

    it('returns lastMermaid=null when history has no assistant entry', () => {
        // 没有 assistant 消息可渲染时，恢复循环应 fall through 到 null，
        // 而不是抛错或把 user 消息当图表。净化守卫 `if (lastMermaid)` 对 null
        // 短路，不会把 null 喂给 extract。
        fs.mkdirSync(path.join(sessionsDir, ID));
        fs.writeFileSync(path.join(sessionsDir, ID, 'history.json'), JSON.stringify([
            { role: 'user', content: 'q1', ts: 1 },
            { role: 'user', content: 'q2', ts: 2 }
        ]));

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: ID }), res);

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.exists, true);
        assert.strictEqual(body.lastMermaid, null);
    });

    it('keeps the original content when extract returns null (non-mermaid fallback)', () => {
        // 非 mermaid 的 assistant content（如纯文本"你好"）会让 extractMermaidCode
        // 返回 null。开发的 fallback 实现是保留原文，避免丢数据--前端会显示渲染
        // 错误便于诊断，行为与修复前一致。此用例锁定 fallback 语义，防止未来被
        // 改成"返回 null / 空串"从而吞掉历史内容。
        const raw = '你好';
        seedStore.append(ID, '你好', raw);

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: ID }), res);

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.exists, true);
        assert.strictEqual(body.lastMermaid, '你好');
    });

    it('is idempotent on already-purified sequenceDiagram', () => {
        // 已净化的代码再跑一遍 extract+autoFix 应保持不变。checkSession 可能被
        // 前端多次调用（反复恢复同一会话），幂等性保证不会把干净数据改坏。
        const clean = 'sequenceDiagram\nA->>B: hello';
        seedStore.append(ID, '画一个时序图', clean);

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: ID }), res);

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.exists, true);
        assert.strictEqual(body.lastMermaid, clean);
    });

    it('fixes gitGraph LR with frontmatter in one pass (frontmatter preserved, orientation stripped)', () => {
        // 真实老数据常同时带 frontmatter + gitGraph LR 方向词。extract 保留
        // frontmatter，autoFix 只剥方向词，两步在一次 checkSession 返回中完成。
        const raw = '---\nconfig\n---\ngitGraph LR\n    commit';
        seedStore.append(ID, '画一个 git 提交图', raw);

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: ID }), res);

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.lastMermaid, '---\nconfig\n---\ngitGraph\n    commit');
    });

    it('does NOT write the purified value back to history.json (read-only contract)', () => {
        // checkSession 是只读语义：只净化"返回值"，不写盘。历史文件必须保持
        // 原始未净化内容，避免恢复操作静默篡改用户数据。若未来有人改成写回，
        // 此断言会让该行为变更显式。
        const raw = 'gitGraph LR:\n    commit id: "init"';
        seedStore.append(ID, '画一个 git 提交图', raw);
        const historyPath = path.join(sessionsDir, ID, 'history.json');
        const before = fs.readFileSync(historyPath, 'utf-8');

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: ID }), res);

        // 返回值已被净化
        const body = JSON.parse(res.body);
        assert.strictEqual(body.lastMermaid, 'gitGraph\n    commit id: "init"');
        // 但盘上历史仍是原始未净化内容
        const after = fs.readFileSync(historyPath, 'utf-8');
        assert.strictEqual(after, before);
        assert.ok(after.includes('gitGraph LR:'), 'stored history should still hold the original LR header');
    });

    it('sanitizes every assistant entry in the history array (not just lastMermaid)', () => {
        // R2 发现：前端 renderHistory 走 history 分支（非 lastMermaid），故 history
        // 数组里的 assistant content 也必须净化，否则旧会话恢复时 gitGraph LR 等仍
        // 渲染失败。此用例锁定 history 字段的净化语义，与 lastMermaid 一致。
        const raw = 'gitGraph LR:\n    commit id: "init"';
        seedStore.append(ID, '画一个 git 提交图', raw);

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: ID }), res);

        const body = JSON.parse(res.body);
        assert.ok(Array.isArray(body.history), 'history should be an array');
        const assistants = body.history.filter(h => h.role === 'assistant');
        assert.ok(assistants.length > 0);
        assert.strictEqual(assistants[assistants.length - 1].content, 'gitGraph\n    commit id: "init"');
        assert.strictEqual(assistants[assistants.length - 1].content, body.lastMermaid);
    });

    it('sanitizes multiple assistant entries (multi-round history)', () => {
        // 多轮历史里每条 assistant content 都需净化（map 对所有 assistant 统一处理）。
        // 锁定 2 轮 gitGraph LR 同时被净化的场景，确保不止最后一条被处理。
        seedStore.append(ID, '画 git 图1', 'gitGraph LR:\n    commit id: "a"');
        seedStore.append(ID, '画 git 图2', 'gitGraph LR\n    commit id: "b"');

        const res = createMockRes();
        router.checkSession(createMockReq('POST', { sessionId: ID }), res);

        const body = JSON.parse(res.body);
        const assistants = body.history.filter(h => h.role === 'assistant');
        assert.strictEqual(assistants.length, 2);
        assert.strictEqual(assistants[0].content, 'gitGraph\n    commit id: "a"');
        assert.strictEqual(assistants[1].content, 'gitGraph\n    commit id: "b"');
        assert.strictEqual(body.lastMermaid, 'gitGraph\n    commit id: "b"');
    });
});
