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
    autoFixMermaidCode
};