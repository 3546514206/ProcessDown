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
        return match[1].trim();
    }

    // Try to find code block without language tag
    match = text.match(/```\s*([\s\S]*?)```/);
    if (match) {
        const code = match[1].trim();
        // Verify it looks like Mermaid code
        if (isMermaidCode(code)) {
            return code;
        }
    }

    // If no code block found, check if the whole text is Mermaid code
    if (isMermaidCode(text.trim())) {
        return text.trim();
    }

    // Try to find flowchart/sequenceDiagram keywords
    match = text.match(/(flowchart\s+[^\n]+|sequenceDiagram\s+[\s\S]*?|stateDiagram-v2\s+[\s\S]*?|classDiagram\s+[\s\S]*?|erDiagram\s+[\s\S]*?|gantt\s+[\s\S]*?|pie\s+[\s\S]*?|requirementDiagram\s+[\s\S]*?|gitGraph\s+[\s\S]*?|journey\s+[\s\S]*?)/i);
    if (match) {
        return text.trim();
    }

    logger.warn('Could not extract Mermaid code from response');
    return null;
}

/**
 * Check if text looks like Mermaid code
 */
function isMermaidCode(text) {
    if (!text) return false;

    const mermaidPatterns = [
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
        /graph\s*[TD]?[LR]?/i
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
    fixErdRelationshipLabels
};