/**
 * v11 新图的 happy path + 关键字识别测试。
 *
 * 覆盖 DESIGN §4.3 列举的 20 种新图与 mermaid 11.16.1：
 * - isMermaidCode 模式匹配
 * - extractMermaidCode 关键字 fallback 提取
 * - autoFixMermaidCode 不破坏（关键 v9 修复仍兼容）
 *
 * 真实渲染（svg 生成）不在此测试范围——需浏览器冒烟（tests/manual/）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isMermaidCode,
    extractMermaidCode,
    autoFixMermaidCode
} = require('../../src/services/extractor');

/**
 * 每种图一个 happy path：isMermaidCode 识别 + extractMermaidCode 关键字 fallback 提取
 * 关键字 fallback 路径：把代码塞进纯文本（无 ```mermaid 围栏）让 extractMermaidCode
 * 走到 line 45 关键字 alternation 分支
 */
const HAPPY_PATHS = [
    // P0
    { name: 'cynefin-beta', code: 'cynefin-beta\ntitle 决策\ncomplex\n"item1"' },
    { name: 'quadrantChart', code: 'quadrantChart\n  x-axis "低 → 高"\n  y-axis "低 → 高"\n  quadrant-1 "Q1"\n  "A": [0.5, 0.5]' },
    { name: 'block-beta', code: 'block-beta\ncolumns 3\n  A\n  B\n  C' },
    // P1
    { name: 'architecture-beta', code: 'architecture-beta\ndirection LR\nservice web(server)[Web]' },
    { name: 'mindmap', code: 'mindmap\n  root((中心))\n    子1\n    子2' },
    { name: 'sankey-beta', code: 'sankey-beta\n煤,发电,40\n天然气,发电,30' },
    { name: 'C4Context', code: 'C4Context\ntitle 系统\nPerson(u, "User")\nSystem(s, "Sys")' },
    { name: 'C4Container', code: 'C4Container\ntitle 容器\nPerson(u, "User")' },
    { name: 'C4Component', code: 'C4Component\ntitle 组件\nPerson(u, "User")' },
    { name: 'C4Dynamic', code: 'C4Dynamic\ntitle 动态\nPerson(u, "User")' },
    { name: 'C4Deployment', code: 'C4Deployment\ntitle 部署\nPerson(u, "User")' },
    // P2
    { name: 'timeline', code: 'timeline\ntitle 项目\n2024 : 启动\n2025 : 完成' },
    { name: 'kanban', code: 'kanban\nTodo\n  id1[设计]\nDoing\n  id2[开发]' },
    { name: 'radar-beta', code: 'radar-beta\naxis 性能,易用,安全\ncurve v1 {1, 2, 3}' },
    { name: 'treemap', code: 'treemap\n"Root"\n  "a": 10\n  "b": 20' },
    { name: 'venn-beta', code: 'venn-beta\nset A\nset B\nintersection(A, B) : "overlap"' },
    // P3
    { name: 'xychart-beta', code: 'xychart-beta\ntitle "S"\nx-axis [a, b]\ny-axis "y"\nbar [1, 2]' },
    { name: 'packet-beta', code: 'packet-beta\n0-10: "Header"\n10-50: "Data"' },
    { name: 'ishikawa', code: 'ishikawa\n问题(质量下降)\n人力{ 缺培训 }' },
    { name: 'fishbone', code: 'fishbone\n问题(质量)\n人力{ 原因 }' },
    { name: 'wardley', code: 'wardley\ntitle 战略\naxis 演化 --> 价值\nCRM[0.7, 0.3]' },
    { name: 'treeView-beta', code: 'treeView-beta\n"Root"\n  "Child"' },
    // zenuml 不在 vendored bundle，已从 extractor 移除，不列入 HAPPY_PATHS
    { name: 'swimlanes', code: 'swimlanes\nlane 用户\n  点按钮' },
    { name: 'eventmodeling', code: 'eventmodeling\nslice 注册\nevent UserRegistered' }
];

/** isMermaidCode 必须为 false 的"非 mermaid"对照组 */
const NEGATIVES = [
    'plain text',
    'console.log("hello")',
    'function foo() { return 1 }',
    '',
    null,
    undefined
];

test('v11 关键字 - isMermaidCode 识别全部 20 种新图（happy path）', () => {
    for (const { name, code } of HAPPY_PATHS) {
        assert.equal(isMermaidCode(code), true,
            `isMermaidCode 应识别 ${name}，实际 false。代码: ${code.split('\n')[0]}`);
    }
});

test('v11 关键字 - extractMermaidCode 从裸文本中识别新图关键字', () => {
    for (const { name, code } of HAPPY_PATHS) {
        // 模拟 LLM 输出裸代码（无 ```mermaid 围栏）
        const llmOutput = '以下是图表：\n' + code + '\n';
        const result = extractMermaidCode(llmOutput);
        // 注：extractMermaidCode 的关键字 fallback 路径（extractor.js:45）匹配到关键字后
        // 直接返回 text.trim()（不再剥离 frontmatter--bundle 11.16.1 已原生支持），
        // 不剥掉关键字前的"以下是图表："。这是 v9 时代遗留行为，DESIGN 没要求改；
        // 测试只验证"含关键字 + 不为 null"。
        assert.ok(result, `extractMermaidCode 应识别 ${name}，实际 null`);
        assert.ok(result.includes(name.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')),
            `提取结果应含 ${name} 关键字，实际: ${result.split('\n').slice(0, 2).join(' | ')}`);
    }
});

test('v11 关键字 - extractMermaidCode 从 ```mermaid 围栏中识别新图', () => {
    for (const { name, code } of HAPPY_PATHS) {
        const fenced = '```mermaid\n' + code + '\n```';
        const result = extractMermaidCode(fenced);
        assert.ok(result, `extractMermaidCode 应从围栏识别 ${name}`);
        assert.match(result, new RegExp(`^${name.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')}`),
            `围栏提取应以 ${name} 开头，实际: ${result.split('\n')[0]}`);
    }
});

test('isMermaidCode 对非 mermaid 文本返回 false', () => {
    for (const t of NEGATIVES) {
        assert.equal(isMermaidCode(t), false,
            `isMermaidCode("${String(t).slice(0, 30)}") 应为 false`);
    }
});

test('zenuml 不在 vendored bundle，isMermaidCode 拒绝（避免提取通过->渲染失败陷阱）', () => {
    // zenuml 已从 isMermaidCode / extractMermaidCode / system.txt 三处移除：
    // bundle 内无 zenuml detector（grep=0），detectType 抛 UnknownDiagramError。
    // 若 isMermaidCode 接受 zenuml，extractMermaidCode 会返回代码 -> 前端渲染失败。
    assert.equal(isMermaidCode('zenuml\n  Alice -> Bob: Hi'), false,
        'zenuml 不在 vendored bundle，isMermaidCode 应拒绝');
});

test('v11 关键字子串匹配（isMermaidCode 不依赖完整行）', () => {
    // 即使代码混在解释文本中，isMermaidCode 也能识别关键字
    const wrapped = '下面是要画的图：\n  cynefin-beta\n  complex\n  done';
    assert.equal(isMermaidCode(wrapped), true);
    const wrapped2 = 'Note: 用户旅程图如下：\njourney\n  title 测试';
    assert.equal(isMermaidCode(wrapped2), true);
});

test('v9 修复对 v11 新图不破坏（autoFixMermaidCode 幂等）', () => {
    // 新图不应触发任何 fix 路径，autoFixMermaidCode 应返回 fixes=[]
    for (const { name, code } of HAPPY_PATHS) {
        const { fixes, code: fixed } = autoFixMermaidCode(code);
        // 应当所有 fix 都是空——新图不涉及 gitGraph / erDiagram / opt / 全角标点等
        // 但末尾 trimEnd 可能产生 'Removed trailing whitespace' fix（如果输入无 fix 但有 trailing space）
        // 因此我们只检查"非预期的修复"是否存在
        const unexpected = fixes.filter(f => !/trailing whitespace/.test(f));
        assert.deepEqual(unexpected, [],
            `${name} 不应有非预期修复: ${unexpected.join('; ')}`);
        // 关键字应保留
        assert.match(fixed, new RegExp(`^${name.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')}`),
            `${name} 关键字应在 autoFix 后保留`);
    }
});

test('C4 严格匹配 5 个关键字，避免与变量名 "c4" 误伤', () => {
    // isMermaidCode 不应误识别裸 "c4"
    assert.equal(isMermaidCode('c4 is a variable name'), false);
    assert.equal(isMermaidCode('class Foo extends C4'), false);
    // 但应识别 5 个完整 C4 关键字
    assert.equal(isMermaidCode('C4Context\n  Person'), true);
    assert.equal(isMermaidCode('C4Container\n  Person'), true);
    assert.equal(isMermaidCode('C4Component\n  Person'), true);
    assert.equal(isMermaidCode('C4Dynamic\n  Person'), true);
    assert.equal(isMermaidCode('C4Deployment\n  Person'), true);
});

test('stabilized 图（sankey/xychart/block/packet）bare 与 -beta 均识别', () => {
    // 11.16.1 已 stabilize：bare 关键字合法，isMermaidCode 必须接受。
    // 这是用户报告 sankey 渲染失败的根因--LLM 输出 bare `sankey` 被误判为非 mermaid。
    assert.equal(isMermaidCode('sankey\n  A,B,10'), true,
        'sankey bare（无 -beta）是合法 v11 图，应被 isMermaidCode 接受');
    assert.equal(isMermaidCode('xychart\n  title "S"\n  bar [1,2]'), true,
        'xychart bare 应被接受');
    assert.equal(isMermaidCode('block\n  columns 3\n  A'), true,
        'block bare 应被接受');
    assert.equal(isMermaidCode('packet\n  0-10: "H"'), true,
        'packet bare 应被接受');
    // -beta 形式仍接受（向后兼容）
    assert.equal(isMermaidCode('sankey-beta\n  A,B,10'), true);
    assert.equal(isMermaidCode('block-beta\n  columns 3'), true);
});

test('仍强制 -beta 的图（cynefin/architecture/radar/venn/treeView）bare 不识别', () => {
    // 这些图 11.16.1 仍要求 -beta 后缀，bare 形式 bundle 实测 FAIL，
    // isMermaidCode 必须拒绝 bare 写法（LLM 必须输出带 -beta 的关键字）。
    assert.equal(isMermaidCode('cynefin\n  complex'), false,
        'cynefin 关键字（无 -beta）不是合法 v11 图，应被 isMermaidCode 拒绝');
    assert.equal(isMermaidCode('architecture\n  direction LR'), false,
        'architecture bare 应被拒绝（仍需 -beta）');
    assert.equal(isMermaidCode('radar\n  axis a,b,c'), false,
        'radar bare 应被拒绝（仍需 -beta）');
    assert.equal(isMermaidCode('venn\n  set A'), false,
        'venn bare 应被拒绝（仍需 -beta）');
    assert.equal(isMermaidCode('treeView\n  "Root"'), false,
        'treeView bare 应被拒绝（仍需 -beta）');
});
