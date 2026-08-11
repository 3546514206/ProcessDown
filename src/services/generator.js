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
     * Generate Mermaid code from natural language.
     * history: prior rounds [{role, content}] from the session store, oldest
     * first. The current instruction goes last so the model treats it as the
     * authoritative request. We deliberately do NOT dedupe history's last
     * assistant message against currentMermaid: the user may have hand-edited
     * the diagram in the editor, in which case the "Current diagram:" block in
     * this turn's user message is the precise present state while history only
     * provides conversational context.
     */
    async generate(prompt, currentMermaid = null, history = []) {
        logger.info('Generating Mermaid code for prompt:', prompt.substring(0, 100));

        const messages = [...history];

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
                logger.warn('LLM response did not contain Mermaid code. Raw response (length: ' + response.length + '):', response);
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

    /**
     * 流式生成 Mermaid 代码。messages 构造与 generate 一致；逐 delta 透传
     * thinking/content 给调用方（SSE 路由）。流式期间累积 content，结束后跑
     * extractMermaidCode + autoFixMermaidCode 得到最终代码，再回调 onDone。
     * signal 由调用方传入，客户端断开时中止上游请求。
     */
    async generateStream(prompt, currentMermaid = null, history = [], callbacks = {}, signal) {
        logger.info('Streaming Mermaid code for prompt:', prompt.substring(0, 100));

        const messages = [...history];
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

        let accumulated = '';
        const onContent = (delta) => {
            accumulated += delta;
            if (callbacks.onContent) callbacks.onContent(delta);
        };

        try {
            await this.llm.chatStream(messages, this.systemPrompt, {
                onThinking: callbacks.onThinking,
                onContent
            }, signal);
        } catch (error) {
            // abort 是客户端断开，不在此处兜底修复，直接上抛由路由识别
            if (error && error.code === 'ABORTED') throw error;
            logger.error('Streaming generation failed:', error.message);
            throw error;
        }

        // 流结束：与 generate 链路一致的 extract + autoFix，单一真源
        const extractedCode = extractMermaidCode(accumulated);
        let finalCode = extractedCode || accumulated;
        const fixes = [];
        let extracted = !!extractedCode;
        if (extractedCode) {
            const fixResult = autoFixMermaidCode(extractedCode);
            if (fixResult.fixes.length > 0) {
                logger.info('Auto-fixed Mermaid code:', fixResult.fixes.join(', '));
                finalCode = fixResult.code;
                fixes.push(...fixResult.fixes);
            }
        } else {
            logger.warn('Stream response did not contain recognizable Mermaid code');
        }
        // 与非流式 generate 一致：记录 validate 警告（仅日志，不阻断）
        const validation = validateMermaidCode(finalCode);
        if (validation.warnings && validation.warnings.length > 0) {
            logger.warn('Mermaid code warnings:', validation.warnings.join('; '));
        }
        if (!validation.valid) {
            logger.warn('Mermaid code validation issues:', validation.errors.join('; '));
        }
        if (callbacks.onDone) callbacks.onDone({ mermaid: finalCode, fixes, extracted });
        return { mermaid: finalCode, fixes, extracted };
    }

    /**
     * Probe LLM reachability for health checks.
     */
    async checkLlm() {
        return this.llm.ping();
    }
}

module.exports = GeneratorService;