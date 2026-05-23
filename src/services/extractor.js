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
 * Basic validation for common syntax issues
 */
function validateMermaidCode(code) {
    const errors = [];

    if (!code || typeof code !== 'string') {
        errors.push('Code is empty or not a string');
        return { valid: false, errors };
    }

    // Check for balanced brackets
    const openBrackets = (code.match(/\[/g) || []).length;
    const closeBrackets = (code.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
        errors.push('Unbalanced square brackets');
    }

    // Check for balanced parentheses
    const openParens = (code.match(/\(/g) || []).length;
    const closeParens = (code.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
        errors.push('Unbalanced parentheses');
    }

    // Check for balanced braces
    const openBraces = (code.match(/\{/g) || []).length;
    const closeBraces = (code.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
        errors.push('Unbalanced braces');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    extractMermaidCode,
    isMermaidCode,
    validateMermaidCode
};