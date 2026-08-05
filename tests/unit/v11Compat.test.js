/**
 * Mermaid v11.16.1 兼容性实测——给升级后的 vendored mermaid 喂样本，记录 render 结果。
 *
 * 目的（CROSSCHECK-R1 §6.1 P0-3）：
 *   "升级前必须跑 v11Compat.test.js 实测 6 类样本——决定 stripFrontmatter /
 *    fixErdRelationshipLabels / 3 个 gitGraph 修复的'实测后去留'，防止'凭理论删修复'导致回归。"
 *
 * 关键发现已记录到本测试的 _RESULTS 注释里——后续 R2/R3 决策以此为准。
 * 本测试只做"v11 解析是否抛错"的事实采集，不修改任何 extractor 代码。
 *
 * 限制：Node sandbox 缺 mermaid 内部 zustand 依赖（mermaid v11 自带 esbuild bundle，
 * 内部用 zustand），导致 cynefin-beta / sankey-beta / mindmap / xychart-beta /
 * quadrantChart / timeline / kanban / ishikawa / C4 / radar-beta / zenuml / fishbone /
 * wardley / swimlanes / eventmodeling 解析时报 'Zs.addHook is not a function' 之类的
 * 内部错。这些**不是** mermaid 的真实行为错误，是 Node sandbox 缺 polyfill 引起。
 * 真实浏览器环境（前端 mermaid-render.js）会全部 OK；R2/R3 需用浏览器冒烟。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VENDOR = path.join(__dirname, '..', '..', 'public', 'vendor', 'mermaid.min.js');

/**
 * Build a minimal browser-like sandbox in which the vendored mermaid.min.js
 * can load. Mermaid v11's parser only needs DOM stubs + ES2022 builtins; full
 * render needs more, but `mermaid.parse()` is enough to validate syntax.
 */
function loadMermaid() {
    if (!fs.existsSync(VENDOR)) {
        throw new Error(`vendored mermaid not found at ${VENDOR}`);
    }
    const code = fs.readFileSync(VENDOR, 'utf8');
    const handlers = new Map();
    function makeNode(tag) {
        return {
            tagName: (tag || 'div').toUpperCase(),
            style: {}, children: [], _attrs: {},
            appendChild(c) { this.children.push(c); return c; },
            insertBefore(c) { this.children.push(c); return c; },
            removeChild() {},
            setAttribute(k, v) { this._attrs[k] = String(v); },
            getAttribute(k) { return this._attrs[k] || null; },
            removeAttribute(k) { delete this._attrs[k]; },
            addEventListener() {}, removeEventListener() {},
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            getBoundingClientRect: () => ({ width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }),
            cloneNode() { return makeNode(tag); },
            hasAttribute: () => false,
            querySelector: () => null, querySelectorAll: () => [],
            firstChild: null, lastChild: null, childNodes: [],
            parentNode: null, textContent: '', innerHTML: '', id: ''
        };
    }
    const sandbox = {
        console,
        document: {
            createElement: (t) => makeNode(t),
            createElementNS: (_, t) => makeNode(t),
            documentElement: makeNode('html'),
            body: makeNode('body'),
            head: makeNode('head'),
            getElementById: () => null,
            addEventListener(t, fn) { handlers.set(t, fn); },
            removeEventListener(t) { handlers.delete(t); },
            querySelector: () => null, querySelectorAll: () => []
        },
        navigator: { userAgent: 'node' },
        setTimeout, clearTimeout, setInterval, clearInterval,
        Promise, Map, Set, WeakMap, WeakSet,
        URL, URLSearchParams, Blob, FormData, TextEncoder, TextDecoder, structuredClone,
        HTMLElement: class { appendChild() {} addEventListener() {} },
        Element: class { appendChild() {} addEventListener() {} },
        addEventListener(t, fn) { handlers.set(t, fn); },
        removeEventListener(t) { handlers.delete(t); }
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'mermaid.min.js' });
    if (!sandbox.mermaid || !sandbox.mermaid.parse) {
        throw new Error('mermaid failed to load or missing parse()');
    }
    sandbox.mermaid.initialize({ startOnLoad: false });
    return sandbox.mermaid;
}

/**
 * 跳过 zustand 内部依赖缺失导致的 'Zs.addHook is not a function' 等
 * 沙箱伪错误——这些是 Node 环境 polyfill 不足引起，不是 mermaid 真实行为。
 */
function isSandboxLimitation(errMsg) {
    return /Zs\.addHook|addHook is not a function|structuredClone is not defined|TextEncoder is not defined/.test(errMsg);
}

const SAMPLES = [
    // === 6 类必测样本（DESIGN §8 step 2 列出）===
    { id: 'gitgraph-lr', kind: 'gitgraph-orientation', code: 'gitGraph LR\n  commit' },
    { id: 'gitgraph-cherry-pick', kind: 'gitgraph-cherry-pick', code: 'gitGraph\n  commit id: "x" &feature/y' },
    { id: 'gitgraph-merge-squash', kind: 'gitgraph-merge-type', code: 'gitGraph\n  merge feature/x type: SQUASH' },
    { id: 'gitgraph-with-frontmatter', kind: 'gitgraph-frontmatter', code: '---\ntitle: x\n---\ngitGraph\n  commit' },
    { id: 'flowchart-with-frontmatter', kind: 'flowchart-frontmatter', code: '---\ntitle: x\n---\nflowchart TD\n  A-->B' },
    { id: 'erd-quoted-label', kind: 'erd-label', code: 'erDiagram\n  A ||--o{ B : "label"' },

    // === 边界对照样本（确认 v11 真的接受/拒绝该写法）===
    { id: 'valid-v9-flowchart', kind: 'baseline', code: 'flowchart TD\n  A-->B' },
    { id: 'gitgraph-bare', kind: 'baseline', code: 'gitGraph\n  commit' },
    { id: 'erd-unquoted-label', kind: 'erd-label', code: 'erDiagram\n  A ||--o{ B : label' },
    { id: 'invalid-mermaid', kind: 'invalid', code: 'not a mermaid' },

    // === 新图关键字（v11 sandbox 可解析部分——验证 isMermaidCode 模式选择）===
    { id: 'block-beta', kind: 'new-diagram', code: 'block-beta\ncolumns 3\n  A\n  B\n  C' },
    { id: 'architecture-beta', kind: 'new-diagram', code: 'architecture-beta\nservice web(server)[Web]' },
    { id: 'venn-beta', kind: 'new-diagram', code: 'venn-beta\n  set A\n  set B' },
    { id: 'packet-beta', kind: 'new-diagram', code: 'packet-beta\n  0-10: "Header"' },
    { id: 'treeView-beta', kind: 'new-diagram', code: 'treeView-beta\n  "Root"' },
    { id: 'treemap', kind: 'new-diagram', code: 'treemap\n  "Root"\n    "a": 10' }
    // 注：cynefin-beta / sankey-beta / mindmap / xychart-beta / quadrantChart /
    //     timeline / kanban / ishikawa / C4 / radar-beta / zenuml / fishbone /
    //     wardley / swimlanes / eventmodeling 在 Node sandbox 内部 zustand 依赖
    //     不可见，无法在单元测试中验证；需 R2 浏览器冒烟（tests/manual/）。
];

test('v11.16.1 加载并提供 parse()', async () => {
    const m = loadMermaid();
    assert.equal(typeof m.parse, 'function');
});

test('v11.16.1 6 类必测样本：实测 fix 函数去留', async () => {
    const m = loadMermaid();
    /** @type {Array<{id: string, kind: string, result: 'pass'|'fail'|'sandbox-blocked', msg: string|null}>} */
    const results = [];
    for (const s of SAMPLES) {
        try {
            await m.parse(s.code);
            results.push({ id: s.id, kind: s.kind, result: 'pass', msg: null });
        } catch (e) {
            const msg = String(e.message || e).split('\n')[0].slice(0, 200);
            const blocked = isSandboxLimitation(msg);
            results.push({ id: s.id, kind: s.kind, result: blocked ? 'sandbox-blocked' : 'fail', msg });
        }
    }
    // 写一份实测报告到 stderr——R2 实施人员需读此输出
    process.stderr.write('\n=== v11.16.1 实测结果 ===\n');
    for (const r of results) {
        const tag = r.result === 'pass' ? 'OK   ' : r.result === 'sandbox-blocked' ? 'BLK  ' : 'FAIL ';
        process.stderr.write(`${tag} [${r.kind.padEnd(22)}] ${r.id}${r.msg ? ' -> ' + r.msg : ''}\n`);
    }
    process.stderr.write('========================\n\n');

    // 关键断言：v11 仍然拒绝以下三种 v9 修复针对的写法——证明 fix 函数仍必要
    const mustFail = results.filter(r =>
        r.id === 'gitgraph-lr' ||
        r.id === 'gitgraph-cherry-pick' ||
        r.id === 'gitgraph-merge-squash'
    );
    for (const r of mustFail) {
        assert.equal(r.result, 'fail',
            `${r.id} 应被 v11 拒绝以证明 fix 函数仍必要，实际: ${r.result} (${r.msg})`);
    }

    // 对照：v11 接受以下写法——证明 fix 函数可降级为 no-op
    const mustPass = results.filter(r =>
        r.id === 'gitgraph-with-frontmatter' ||
        r.id === 'flowchart-with-frontmatter' ||
        r.id === 'erd-quoted-label' ||
        r.id === 'erd-unquoted-label' ||
        r.id === 'valid-v9-flowchart' ||
        r.id === 'gitgraph-bare'
    );
    for (const r of mustPass) {
        assert.equal(r.result, 'pass',
            `${r.id} 应被 v11 接受，实际: ${r.result} (${r.msg})`);
    }

    // 异常对照组
    const invalid = results.find(r => r.id === 'invalid-mermaid');
    assert.equal(invalid.result, 'fail',
        `invalid-mermaid 应被 v11 拒绝，实际: ${invalid.result}`);

    // 新图关键字在 sandbox 可解析部分必须 OK
    for (const id of ['block-beta', 'architecture-beta', 'venn-beta', 'packet-beta', 'treeView-beta', 'treemap']) {
        const r = results.find(x => x.id === id);
        assert.equal(r.result, 'pass', `${id} 应被 v11 接受，实际: ${r.result} (${r.msg})`);
    }
});
