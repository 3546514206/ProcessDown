/**
 * Welcome-page example code loader
 *
 * 欢迎场景的"作弊"管道：当用户点击空会话页的四个示例 chip 时（c4-ecommerce
 * / mindmap-genai / git-enterprise-flow / seq-spring-bean），后端从
 * `prompts/welcome/<key>.md` 读出预先写好的正确代码，与用户提示词一起塞给
 * LLM，让 LLM 沿用这份代码生成等价输出。新用户首屏即看到能渲染的图，避免
 * 初次接触因 LLM 现生成翻车而劝退。
 *
 * 设计约束：
 * 1. 白名单：welcomeKey 必须命中硬编码的 4 个 key 之一。文件路径完全由 key
 *    派生（不允许外部传入文件名），杜绝路径穿越与"读任意文件"。
 * 2. 文件缺失/损坏：返回 null，由路由层决定是否 400 或静默回退。绝不在 UI
 *    显示任何预制代码——前端拿到的 mermaid 一律由 LLM 流式产出。
 * 3. 解析：.md 文件格式 ` ```markdown\n<代码>\n``` `，剥外层代码块后剩余即
 *    mermaid 源码。空文件或无 fenced block 一律 null。
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// 与 public/index.html 里 .example-chip 的 data-example-key 一一对应；
// 白名单同步靠 tests/unit/frontendExampleChips.smoke.test.js 兜底。
const WELCOME_KEYS = Object.freeze([
    'c4-ecommerce',
    'mindmap-genai',
    'git-enterprise-flow',
    'seq-spring-bean'
]);

// key → 文件名映射：example key 是面向用户的语义名（c4-ecommerce），文件名
// 是 mermaid 图表类型（C4Container.md）。两者天然不对等，列在白名单旁避免
// 隐式约定漂移；新加 chip 必须同步加这一行。
const WELCOME_FILE = Object.freeze({
    'c4-ecommerce': 'C4Container.md',
    'mindmap-genai': 'mindmap.md',
    'git-enterprise-flow': 'gitGraph.md',
    'seq-spring-bean': 'sequenceDiagram.md'
});

function isValidWelcomeKey(key) {
    return typeof key === 'string' && WELCOME_KEYS.includes(key);
}

/**
 * 把 .md 文件里的 fenced code block 抽出来。
 * 兼容 ```markdown ... ```（当前 welcome/*.md 实际写法）与 ``` ... ``` 两种。
 * 无 fenced block 时返回 null——空文件/手敲文本无法用作"预制代码"。
 */
function extractMermaidFromMarkdown(md) {
    if (typeof md !== 'string') return null;
    const trimmed = md.trim();
    if (!trimmed) return null;
    // 优先 ```markdown 包裹；这是当前 welcome/*.md 的格式
    let m = trimmed.match(/^```markdown\s*\n([\s\S]*?)\n```\s*$/i);
    if (!m) m = trimmed.match(/^```\s*\n([\s\S]*?)\n```\s*$/);
    if (!m) return null;
    const code = m[1].replace(/\r\n/g, '\n').trim();
    return code || null;
}

/**
 * 加载欢迎场景的预制代码。
 * 失败一律返回 null，不抛——调用方据此决定回退到正常 LLM 路径或 400 拒绝。
 * `cwd` 形参仅测试注入；生产固定 process.cwd()。
 */
function loadWelcomeCode(key, opts = {}) {
    if (!isValidWelcomeKey(key)) return null;
    const cwd = opts.cwd || process.cwd();
    // key 是白名单字面量，文件名由映射表提供（不允许外部传入），杜绝路径穿越
    const fileName = WELCOME_FILE[key];
    const filePath = path.join(cwd, 'prompts', 'welcome', fileName);
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        logger.warn('Welcome code load failed for', key, ':', e.message);
        return null;
    }
    return extractMermaidFromMarkdown(raw);
}

module.exports = {
    WELCOME_KEYS,
    WELCOME_FILE,
    isValidWelcomeKey,
    extractMermaidFromMarkdown,
    loadWelcomeCode
};
