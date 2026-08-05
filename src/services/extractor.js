/**
 * Mermaid Code Extractor
 * Extracts Mermaid code from LLM responses
 */

const logger = require('../utils/logger');

/**
 * Extract Mermaid code from response text
 * Supports various formats:
 * - ```mermaid\n code \n```
 * - ```code\n```
 * - Just the code if no formatting
 */
function extractMermaidCode(text) {
    if (!text) return null;

    // 兼容 OpenAI 协议的 <think> 深度思考标签：剥离标签及其内容
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    logger.debug('Extracting Mermaid code from response, length:', text.length);

    // Try to find code block with mermaid language tag
    let match = text.match(/```mermaid\s*([\s\S]*?)```/i);
    if (match) {
        return stripFrontmatter(match[1].trim());
    }

    // Try to find code block without language tag
    match = text.match(/```\s*([\s\S]*?)```/);
    if (match) {
        const code = match[1].trim();
        // Verify it looks like Mermaid code
        if (isMermaidCode(code)) {
            return stripFrontmatter(code);
        }
    }

    // If no code block found, check if the whole text is Mermaid code
    if (isMermaidCode(text.trim())) {
        return stripFrontmatter(text.trim());
    }

    // Try to find flowchart/sequenceDiagram/etc. keywords (covers all v9-v11 supported diagrams)
    // 关键字清单与 isMermaidCode 模式保持一致（CLAUDE.md 硬约束"三处同步"），
    // 注意 cynefin-beta 比 cynefin 长，必须先放长关键字再放短关键字以免被短前缀截断
    match = text.match(/(flowchart\s+[^\n]+|sequenceDiagram\s+[\s\S]*?|stateDiagram-v2\s+[\s\S]*?|classDiagram\s+[\s\S]*?|erDiagram\s+[\s\S]*?|gantt\s+[\s\S]*?|pie\s+[\s\S]*?|requirementDiagram\s+[\s\S]*?|gitGraph\s+[\s\S]*?|journey\s+[\s\S]*?|quadrantChart\s+[\s\S]*?|(?:C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\s+[\s\S]*?|mindmap\s+[\s\S]*?|timeline\s+[\s\S]*?|sankey-beta\s+[\s\S]*?|xychart-beta\s+[\s\S]*?|block-beta\s+[\s\S]*?|packet-beta\s+[\s\S]*?|kanban\s+[\s\S]*?|architecture-beta\s+[\s\S]*?|radar-beta\s+[\s\S]*?|treemap\s+[\s\S]*?|venn-beta\s+[\s\S]*?|(?:ishikawa|fishbone)\s+[\s\S]*?|wardley\s+[\s\S]*?|treeView-beta\s+[\s\S]*?|cynefin-beta\s+[\s\S]*?|zenuml\s+[\s\S]*?|swimlanes\s+[\s\S]*?|eventmodeling\s+[\s\S]*?)/i);
    if (match) {
        return stripFrontmatter(text.trim());
    }

    logger.warn('Could not extract Mermaid code from response');
    return null;
}

/**
 * 剥离 Mermaid frontmatter（图表开头的 `---\n...\n---\n` YAML 配置块）。
 *
 * 本项目 vendored 的 mermaid（public/vendor/mermaid.min.js）不支持 frontmatter
 * （源码 grep frontmatter=0），但 LLM 偶尔按最新文档输出带 frontmatter 的
 * gitGraph 等，导致 mermaid.render 失败。在 extractMermaidCode 各返回点剥离，
 * 同时闭合 generate 与 checkSession 恢复两条路径（两者都跑 extract）。
 *
 * 注意：未来若升级 mermaid 到支持 frontmatter 的版本，此剥离会丢失 config
 * 配置，届时需移除此函数或改为按版本条件剥离。
 */
function stripFrontmatter(code) {
    if (!code) return code;
    // frontmatter 必须在图表最开头：首行 `---` + YAML 内容 + 闭合 `---` 行。
    // 用 ^ 锚定首行，避免误伤图表正文里出现的 `---`（如 sequenceDiagram 注释）。
    // [ \t]* 容忍行尾空格；\r?\n 兼容 CRLF；[\s\S]*? 非贪婪到第一个闭合 ---。
    return code.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '').trim();
}

/**
 * Check if text looks like Mermaid code
 *
 * 模式清单与 DESIGN §4.3 对齐：覆盖 mermaid 11.16.1 全部 20 种新图 + 原 10 种 v9 图。
 * 优先级与 system.txt 一致；CLAUDE.md "新增 Mermaid 图表类型时需同步三处" 硬约束。
 *
 * beta 后缀（cynefin-beta / architecture-beta / sankey-beta / radar-beta /
 * venn-beta / xychart-beta / packet-beta / block-beta / treeView-beta）必须保留：
 * v11 仍把这些图标为 beta，去掉 -beta 会报 unknown diagram。
 * C4 严格匹配 5 个关键字（Context/Container/Component/Dynamic/Deployment），
 * 不裸 `c4`——避免与变量名/类名里的 "c4" 误伤。
 */
function isMermaidCode(text) {
    if (!text) return false;

    const mermaidPatterns = [
        // v9 保留
        /flowchart\s*[TD]?[LR]?/i,
        /sequenceDiagram/i,
        /stateDiagram-v2/i,
        /classDiagram/i,
        /erDiagram/i,
        /gantt/i,
        /pie\s*\{/i,
        /requirementDiagram/i,
        /gitGraph/i,
        /journey/i,
        /graph\s*[TD]?[LR]?/i,
        // v10+ 新增
        /quadrantChart/i,
        /(C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)/i,
        /mindmap/i,
        /timeline/i,
        /sankey-beta/i,
        /xychart-beta/i,
        /block-beta/i,
        /packet-beta/i,
        /kanban/i,
        // v11+ 新增
        /architecture-beta/i,
        /radar-beta/i,
        /treemap/i,
        /venn-beta/i,
        /(ishikawa|fishbone)/i,
        /wardley/i,
        /treeView-beta/i,
        /cynefin-beta/i,
        /zenuml/i,
        /swimlanes/i,
        /eventmodeling/i,
    ];

    return mermaidPatterns.some(pattern => pattern.test(text));
}

/**
 * Validate Mermaid code syntax
 * Checks for common syntax issues and unsafe characters
 */
function validateMermaidCode(code) {
    const errors = [];
    const warnings = [];

    if (!code || typeof code !== 'string') {
        errors.push('Code is empty or not a string');
        return { valid: false, errors, warnings };
    }

    const openBrackets = (code.match(/\[/g) || []).length;
    const closeBrackets = (code.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
        errors.push('Unbalanced square brackets');
    }

    const openParens = (code.match(/\(/g) || []).length;
    const closeParens = (code.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
        errors.push('Unbalanced parentheses');
    }

    const openBraces = (code.match(/\{/g) || []).length;
    const closeBraces = (code.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
        errors.push('Unbalanced braces');
    }

    const emojiRegex = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
    if (emojiRegex.test(code)) {
        errors.push('Code contains emoji characters which may cause Mermaid parse errors. Use plain text instead.');
    }

    const chinesePunctuationRegex = /[，；：。（）【】《》""''、！？]/;
    if (chinesePunctuationRegex.test(code)) {
        warnings.push('Code contains Chinese punctuation marks. Consider using English half-width punctuation (,;:.()[]) for better compatibility.');
    }

    if (code.includes('\t')) {
        warnings.push('Code contains tab characters. Use spaces for indentation instead.');
    }

    const trailingSpaceLines = code.split('\n').filter((line, i) => {
        if (i === code.split('\n').length - 1 && line === '') return false;
        return line !== line.trimEnd() && line.trimEnd() !== '';
    });
    if (trailingSpaceLines.length > 0) {
        warnings.push(`${trailingSpaceLines.length} line(s) have trailing whitespace.`);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings
    };
}

/**
 * Auto-fix common Mermaid code issues
 * Returns the fixed code and a list of fixes applied
 */

/**
 * 修复 erDiagram 关系行被错误加引号的关系标签。
 * Mermaid 的 erDiagram 解析器不支持引号包裹的关系标签，形如
 *   Shipment ||--o{ TemperatureLog : "monitored_by"
 *   ElectronicSignature }o..o{ Tenant : "signs (polymorphic)"
 * 都会导致渲染失败。若标签是合法标识符（字母开头的字母数字下划线串），
 * 去掉引号保留；否则（含空格、括号、特殊字符或为空）整段 `: "label"` 一并删掉。
 * 非 erDiagram 整体返回原文；classDiagram 关系标签本身不带引号、其 `"1" *-- "0..*"`
 * 中的引号是基数标记而非 label 引用，本规则不触及。
 */
function fixErdRelationshipLabels(code) {
    // 整体不含 erDiagram 声明则直接放过：classDiagram / flowchart 等图类型不会被误改
    if (!/\berDiagram\b/i.test(code)) {
        return { fixed: false, code };
    }

    // ERD 关系行：左侧 cardinality + 实线/虚线 + 右侧 cardinality。
    // Mermaid ERD 的六种合法 cardinality：|| (one), }o (zero-many), }| (one-many),
    // o| (zero-one), o{ (zero-many), |{ (one-many)。
    const ERD_RELATION_REGEX = /(\|\||\}o|\}\||o\||o\{|\|\{)[-.]+(\|\||\}o|\}\||o\||o\{|\|\{)/;
    // 行尾带引号的 label：`: "label"` 或 `: 'label'`
    const DOUBLE_QUOTED_LABEL = /\s*:\s*"([^"]*)"\s*$/;
    const SINGLE_QUOTED_LABEL = /\s*:\s*'([^']*)'\s*$/;
    // 安全 label：字母开头，后续字母/数字/下划线——这是 Mermaid 关系标签去掉引号后能正常解析的最小子集
    const SAFE_LABEL = /^[a-zA-Z][a-zA-Z0-9_]*$/;

    const lines = code.split('\n');
    let changed = false;

    const out = lines.map((line) => {
        // 非关系行（如实体声明 `ENTITY { ... }`、注释 `%% ...`）直接跳过
        if (!ERD_RELATION_REGEX.test(line)) return line;

        let m = line.match(DOUBLE_QUOTED_LABEL);
        if (m) {
            const label = m[1];
            if (SAFE_LABEL.test(label)) {
                changed = true;
                return line.replace(DOUBLE_QUOTED_LABEL, ' : ' + label);
            }
            changed = true;
            return line.replace(DOUBLE_QUOTED_LABEL, '').replace(/\s+$/, '');
        }

        m = line.match(SINGLE_QUOTED_LABEL);
        if (m) {
            const label = m[1];
            if (SAFE_LABEL.test(label)) {
                changed = true;
                return line.replace(SINGLE_QUOTED_LABEL, ' : ' + label);
            }
            changed = true;
            return line.replace(SINGLE_QUOTED_LABEL, '').replace(/\s+$/, '');
        }

        return line;
    });

    if (!changed) {
        return { fixed: false, code };
    }
    return { fixed: true, code: out.join('\n') };
}

/**
 * 修复 gitGraph 中错误使用 v10+ cherry-pick 语法 `&<branch>` 后缀。
 * Mermaid v9 的 gitGraph 不支持 `commit &<branch>` / `merge &<branch>`，
 * LLM 输出常出现 `merge feature/user-auth ... &feature/user-auth` 这种冗余写法
 * 或单独的 `commit ... &feature/order-refactor`，渲染会失败。
 * 处理：去掉行尾的 `&<branch>` 后缀；若去掉后整行只剩 merge/commit 关键字 + 分支名
 * （即原本是 `merge &<branch>` 形式），保留原 merge/commit 结构作为无 cherry-pick 版本。
 */
function fixGitGraphCherryPick(code) {
    if (!/\bgitGraph\b/i.test(code)) {
        return { fixed: false, code };
    }

    const CHERRY_PICK_SUFFIX = /\s+&[A-Za-z0-9_./-]+\s*$/;
    const lines = code.split('\n');
    let changed = false;
    const out = lines.map((line) => {
        const trimmed = line.trimStart();
        // 只处理 commit / merge 开头的行
        if (!/^(commit|merge)\b/.test(trimmed)) return line;
        if (!CHERRY_PICK_SUFFIX.test(line)) return line;
        changed = true;
        return line.replace(CHERRY_PICK_SUFFIX, '').replace(/\s+$/, '');
    });

    if (!changed) {
        return { fixed: false, code };
    }
    return { fixed: true, code: out.join('\n') };
}

/**
 * 修复 gitGraph 头部 v10.3.0+ 的方向参数（LR / TB / RL / BT）。
 * Mermaid vendored 3.0.9 的 gitGraph 解析器只接受 `gitGraph` 或
 * `gitGraph: { ... }` 两种头部；LLM 看到最新文档会输出 `gitGraph LR`
 * 等，解析器会报 "Parse error on line 1"。
 * 策略：保留 `gitGraph` 关键字，把后续方向词去掉。
 * 方向感是视觉偏好，丢掉的代价远小于直接渲染失败。
 */
function fixGitGraphOrientation(code) {
    if (!/\bgitGraph\b/i.test(code)) {
        return { fixed: false, code };
    }

    // 只匹配紧跟 `gitGraph` 关键字（同行末尾、可有空白）的方向词；
    // 行首是 `gitGraph` 时方向被剥，行内别处出现 `LR` 不动（避免误伤分支名等）。
    // 大小写不敏感；BT/RL 是合法 v10 方向，vendored 不接受。
    // 方向词后若紧跟冒号（`gitGraph LR:`）一并剥掉：vendored 只接受 bare `gitGraph`
    // 或 `gitGraph: { ... }`，`gitGraph:` 后换行会解析失败。[ \t]* 不含换行，避免
    // 吃掉方向词后的换行与缩进而破坏代码结构。
    const ORIENTATION = /\bgitGraph\s+(LR|TB|RL|BT)\b[ \t]*:?/i;
    const m = code.match(ORIENTATION);
    if (!m) {
        return { fixed: false, code };
    }
    return {
        fixed: true,
        code: code.replace(ORIENTATION, 'gitGraph').replace(/[ \t]+$/, '')
    };
}

/**
 * 修复 gitGraph merge 行上 v10+ 的 merge-algorithm type 关键字
 * （SQUASH / REBASE / FAST_FORWARD / FAST-FORWARD / NO_FF）。
 *
 * Mermaid v9 的 gitGraph 解析器（vendored 3.0.9）只识别
 * `NORMAL` / `REVERSE` / `HIGHLIGHT` 三个 commit-style highlight，
 * 不接受这些 v10+ merge algorithm 关键字；LLM 倾向按最新文档输出
 * `merge feature/x type: SQUASH` / `type: REBASE` 之类，渲染时报
 * "but found: 'SQUASH'"。
 *
 * 策略：把这些 v10+ type 段整段从 merge 行上剥掉，NORMAL 等合法值保留。
 * 不能映射成 NORMAL（语义不匹配——NORMAL 是 highlight 不是 merge algorithm），
 * 也不能保留（解析器不认识），所以只能丢弃。
 *
 * 注意：与 fixGitGraphCherryPick 不同的是，本函数限定只剥
 * `^merge ... type: <V10_KEYWORD>` 的 v10 merge algorithm；
 * commit 行上的 `type: HIGHLIGHT` 等合法 v9 highlight 不在处理范围。
 */
function fixGitGraphMergeType(code) {
    if (!/\bgitGraph\b/i.test(code)) {
        return { fixed: false, code };
    }

    // v10+ merge algorithm 关键字。NO_FF 在 docs 里有提到，按同样的"剥掉"处理。
    // 大小写不敏感、underscore / hyphen 两种形式都接受。
    const V10_MERGE_TYPES = /^(SQUASH|REBASE|FAST_FORWARD|FAST-FORWARD|NO_FF)$/i;

    const lines = code.split('\n');
    let changed = false;
    const out = lines.map((line) => {
        const trimmed = line.trimStart();
        // 只处理 merge 开头的行；commit 行上的 type: HIGHLIGHT 是合法 v9 highlight
        if (!/^merge\b/.test(trimmed)) return line;

        // 匹配 `type: <keyword>`（keyword 边界为空白、行尾或引号）；
        // 只剥离 v10 merge algorithm 关键字，NORMAL/REVERSE/HIGHLIGHT 等 v9 合法值保留。
        // 边界用 (?=\s|$|") 避免误伤类似 `type: NORMAL_FF` 之类的非完整单词。
        const typeMatch = trimmed.match(/\btype:\s*(\S+?)(?=\s|$|")/);
        if (!typeMatch) return line;
        if (!V10_MERGE_TYPES.test(typeMatch[1])) return line;

        changed = true;
        // 删掉 ` type: <keyword>` 这段子串；保留行首缩进与剩余属性。
        // 如果 type 段恰好是行尾（trimEnd 后无内容），会留下行尾空格，
        // 由 autoFixMermaidCode 末尾的统一 trimEnd 处理。
        return line.replace(/\s*\btype:\s*\S+/, '').replace(/\s+$/, '');
    });

    if (!changed) {
        return { fixed: false, code };
    }
    return { fixed: true, code: out.join('\n') };
}

/**
 * Fix sequenceDiagram `opt` blocks that incorrectly contain `else`.
 * Mermaid's `opt` block does not support `else` (only `alt` does). When an
 * `opt` block contains `else`, the model intended a conditional branch, so
 * convert `opt` to `alt`. Tracks block nesting via a stack so nested blocks
 * are matched correctly.
 */
function fixOptWithElse(code) {
    const lines = code.split('\n');
    const stack = [];
    const optLinesToFix = new Set();

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        const blockMatch = trimmed.match(/^(opt|alt|par|loop|critical|rect|box)\b/i);
        if (blockMatch) {
            stack.push({ type: blockMatch[1].toLowerCase(), line: i });
            continue;
        }
        if (/^else\b/i.test(trimmed)) {
            if (stack.length > 0 && stack[stack.length - 1].type === 'opt') {
                optLinesToFix.add(stack[stack.length - 1].line);
            }
            continue;
        }
        if (/^end\b/i.test(trimmed)) {
            if (stack.length > 0) stack.pop();
        }
    }

    if (optLinesToFix.size === 0) {
        return { fixed: false, code };
    }
    for (const lineNum of optLinesToFix) {
        lines[lineNum] = lines[lineNum].replace(/\bopt\b/i, 'alt');
    }
    return { fixed: true, code: lines.join('\n') };
}

function autoFixMermaidCode(code) {
    if (!code || typeof code !== 'string') return { code, fixes: [] };

    const fixes = [];
    let fixed = code;

    const emojiRegex = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
    if (emojiRegex.test(fixed)) {
        fixed = fixed.replace(emojiRegex, '');
        fixes.push('Removed emoji characters');
    }

    const chinesePunctuationMap = [
        [/\uff0c/g, ','],
        [/\uff1b/g, ';'],
        [/\uff1a/g, ':'],
        [/\uff08/g, '('],
        [/\uff09/g, ')'],
        [/\u3010/g, '['],
        [/\u3011/g, ']'],
        [/\u300a/g, '<'],
        [/\u300b/g, '>'],
    ];

    let hasChinesePunct = false;
    for (const [regex, replacement] of chinesePunctuationMap) {
        if (regex.test(fixed)) {
            fixed = fixed.replace(regex, replacement);
            hasChinesePunct = true;
        }
    }
    if (hasChinesePunct) {
        fixes.push('Replaced Chinese punctuation with English equivalents');
    }

    if (fixed.includes('\t')) {
        fixed = fixed.replace(/\t/g, '    ');
        fixes.push('Replaced tabs with 4 spaces');
    }

    const optFix = fixOptWithElse(fixed);
    if (optFix.fixed) {
        fixed = optFix.code;
        fixes.push('Converted opt block with else to alt');
    }

    const erdLabelFix = fixErdRelationshipLabels(fixed);
    if (erdLabelFix.fixed) {
        fixed = erdLabelFix.code;
        fixes.push('Stripped quoted erDiagram relationship labels');
    }

    const gitGraphFix = fixGitGraphCherryPick(fixed);
    if (gitGraphFix.fixed) {
        fixed = gitGraphFix.code;
        fixes.push('Stripped v10 cherry-pick suffix from gitGraph commit/merge');
    }

    const gitGraphMergeFix = fixGitGraphMergeType(fixed);
    if (gitGraphMergeFix.fixed) {
        fixed = gitGraphMergeFix.code;
        fixes.push('Stripped v10 merge type (SQUASH/REBASE/FAST_FORWARD/NO_FF) from gitGraph merge');
    }

    const gitGraphOrientFix = fixGitGraphOrientation(fixed);
    if (gitGraphOrientFix.fixed) {
        fixed = gitGraphOrientFix.code;
        fixes.push('Stripped v10.3.0+ orientation (LR/TB/RL/BT) from gitGraph header');
    }

    fixed = fixed.split('\n').map(line => line.trimEnd()).join('\n');
    if (fixed !== code && fixes.length === 0) {
        fixes.push('Removed trailing whitespace');
    }

    return { code: fixed, fixes };
}

module.exports = {
    extractMermaidCode,
    isMermaidCode,
    validateMermaidCode,
    autoFixMermaidCode,
    stripFrontmatter,
    fixErdRelationshipLabels,
    fixGitGraphCherryPick,
    fixGitGraphMergeType,
    fixGitGraphOrientation
};