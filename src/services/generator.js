/**
 * Flowchart Generator Service
 * Orchestrates the generation of Mermaid code from natural language
 */

const logger = require('../utils/logger');
const LLMService = require('./llm');
const { extractMermaidCode, validateMermaidCode, autoFixMermaidCode } = require('./extractor');
const fs = require('fs');
const path = require('path');

class GeneratorService {
    constructor(config) {
        this.llm = new LLMService(config);
        this.systemPrompt = this.loadSystemPrompt();
    }

    /**
     * Load system prompt from file
     */
    loadSystemPrompt() {
        const promptPath = path.join(process.cwd(), 'prompts', 'system.txt');
        try {
            if (fs.existsSync(promptPath)) {
                return fs.readFileSync(promptPath, 'utf-8');
            }
        } catch (e) {
            logger.warn('Could not load system prompt:', e.message);
        }

        // Default system prompt
        return `You are an expert at generating Mermaid diagrams from natural language descriptions.

Generate ONLY Mermaid code, no explanations. The code should be complete and renderable.

Supported diagram types:
- flowchart (default): for processes and workflows
- sequenceDiagram: for interactions between actors
- stateDiagram-v2: for state machines
- classDiagram: for class structures
- erDiagram: for database entity relationships
- gantt: for project timelines
- pie: for data visualization
- requirementDiagram: for requirements tracking
- gitGraph: for git history
- journey: for user journeys

Start with the appropriate diagram type keyword followed by the content.
Do not wrap the code in markdown fences unless specifically asked.

Examples:
flowchart TD
    A[Start] --> B[Process]
    B --> C{Decision}
    C -->|Yes| D[Action 1]
    C -->|No| E[Action 2]

sequenceDiagram
    participant U as User
    participant S as System
    U->>S: Request
    S-->>U: Response`;
    }

    /**
     * Generate Mermaid code from natural language
     */
    async generate(prompt, currentMermaid = null) {
        logger.info('Generating Mermaid code for prompt:', prompt.substring(0, 100));

        const messages = [];

        if (currentMermaid) {
            messages.push({
                role: 'user',
                content: `Current diagram:\n\`\`\`mermaid\n${currentMermaid}\n\`\`\`\n\n请根据以下要求修改图表，只输出 Mermaid 代码：${prompt}`
            });
        } else {
            messages.push({
                role: 'user',
                content: `请根据以下描述生成 Mermaid 流程图代码。只输出代码，不要任何其他内容：\n\n${prompt}`
            });
        }

        try {
            const response = await this.llm.chat(messages, this.systemPrompt);
            const extractedCode = extractMermaidCode(response);

            if (!extractedCode) {
                logger.warn('LLM response did not contain Mermaid code. Raw response:', response.substring(0, 500));
                throw new Error('Could not extract Mermaid code from LLM response');
            }

            let finalCode = extractedCode;

            const fixResult = autoFixMermaidCode(extractedCode);
            if (fixResult.fixes.length > 0) {
                logger.info('Auto-fixed Mermaid code:', fixResult.fixes.join(', '));
                finalCode = fixResult.code;
            }

            const validation = validateMermaidCode(finalCode);
            if (validation.warnings && validation.warnings.length > 0) {
                logger.warn('Mermaid code warnings:', validation.warnings.join('; '));
            }
            if (!validation.valid) {
                logger.warn('Mermaid code validation issues:', validation.errors.join('; '));
            }

            logger.info('Successfully generated Mermaid code, length:', finalCode.length);
            return finalCode;

        } catch (error) {
            logger.error('Generation failed:', error.message);
            throw error;
        }
    }

    /**
     * Regenerate from current Mermaid code
     */
    async regenerate(mermaid, instruction) {
        logger.info('Regenerating with instruction:', instruction.substring(0, 100));

        const messages = [{
            role: 'user',
            content: `Current diagram:\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n${instruction}`
        }];

        try {
            const response = await this.llm.chat(messages, this.systemPrompt);
            let extractedCode = extractMermaidCode(response);

            if (!extractedCode) {
                throw new Error('Could not extract Mermaid code from LLM response');
            }

            const fixResult = autoFixMermaidCode(extractedCode);
            if (fixResult.fixes.length > 0) {
                logger.info('Auto-fixed Mermaid code:', fixResult.fixes.join(', '));
                extractedCode = fixResult.code;
            }

            const validation = validateMermaidCode(extractedCode);
            if (validation.warnings && validation.warnings.length > 0) {
                logger.warn('Mermaid code warnings:', validation.warnings.join('; '));
            }
            if (!validation.valid) {
                logger.warn('Mermaid code validation issues:', validation.errors.join('; '));
            }

            return extractedCode;
        } catch (error) {
            logger.error('Regeneration failed:', error.message);
            throw error;
        }
    }
}

module.exports = GeneratorService;