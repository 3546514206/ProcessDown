/**
 * Flowchart Generator Service
 * Orchestrates the generation of Mermaid code from natural language
 */

const logger = require('../utils/logger');
const LLMService = require('./llm');
const { extractMermaidCode, validateMermaidCode, autoFixMermaidCode, stripLlmSpecialTokens } = require('./extractor');
const fs = require('fs');
const path = require('path');

class GeneratorService {
    constructor(config) {
        this.llm = new LLMService(config);
        this.systemPrompt = this.loadSystemPrompt();
    }

    /**
     * 按渲染主题在 system prompt 后追加配色适配指令。
     * 主题是运行期变量（用户可随时深浅切换），不能写死进 prompts/system.txt，
     * 只能在代码里动态追加；三个生成入口共用本方法，不复制文案。
     */
    buildSystemPrompt(theme) {
        const themeHint = theme === 'dark'
            ? '当前图表将在深色主题（深色背景）下渲染。若需用 classDef 或主题变量自定义配色，请保证文字与填充在深色背景上对比度足够，避免深底深字或过暗的颜色。'
            : '当前图表将在浅色主题（白色背景）下渲染。若需用 classDef 或主题变量自定义配色，请保证文字与填充在白色背景上对比度足够，避免深底深字或过浅的颜色。';
        return `${this.systemPrompt}\n\n${themeHint}`;
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
     *
     * welcomeCode：欢迎场景 chip 的预制代码（prompts/welcome/<key>.md 抽出）。
     * 传入时把它并入最后一条 user 消息的 content 末尾——LLM 大概率照抄或基本
     * 等价，从而让新用户首屏即拿到能渲染的图。welcomeCode 缺失/为空时此参
     * 不生效，走原 LLM 真生成路径，用户自主输入即落在此分支。
     */
    async generate(prompt, currentMermaid = null, history = [], theme = 'light', welcomeCode = null) {
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

        if (typeof welcomeCode === 'string' && welcomeCode.trim()) {
            // 预制代码并入最后一条 user 消息，而不是追加尾部 system 消息：生产
            // DeepSeek 系后端不接受「user 之后再跟 system」的非标准消息排列
            // （R1 系对 system 角色本就支持不佳），该排列曾导致模型零输出直接
            // EOS，且流式 delta 泄漏 <｜end▁of▁sentence｜> 字面量（见 extractor
            // 的 stripLlmSpecialTokens）。并入 user content 对任何 chat template
            // 都安全，且不污染 history——history 由会话存储读取，这里的合入仅
            // 存在于本次请求的内存 messages 中。
            const last = messages[messages.length - 1];
            last.content += `\n\n参考代码（请直接输出以下 Mermaid 代码，保持内容一致，仅做必要修正）：\n\`\`\`mermaid\n${welcomeCode}\n\`\`\``;
        }

        try {
            const response = await this.llm.chat(messages, this.buildSystemPrompt(theme));
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
    async regenerate(mermaid, instruction, theme = 'light') {
        logger.info('Regenerating with instruction:', instruction.substring(0, 100));

        const messages = [{
            role: 'user',
            content: `Current diagram:\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n${instruction}`
        }];

        try {
            const response = await this.llm.chat(messages, this.buildSystemPrompt(theme));
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
     * signal 由调用方传入，客户端断开时中止上游请求。theme 为渲染主题
     * （'dark'|'light'），仅追加 system prompt 配色指令，置尾参以免破坏
     * 既有 (prompt, currentMermaid, history, callbacks, signal) 调用方。
     */
    async generateStream(prompt, currentMermaid = null, history = [], callbacks = {}, signal, theme = 'light', welcomeCode = null) {
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

        if (typeof welcomeCode === 'string' && welcomeCode.trim()) {
            // 预制代码并入最后一条 user 消息，而不是追加尾部 system 消息：生产
            // DeepSeek 系后端不接受「user 之后再跟 system」的非标准消息排列
            // （R1 系对 system 角色本就支持不佳），该排列曾导致模型零输出直接
            // EOS，且流式 delta 泄漏 <｜end▁of▁sentence｜> 字面量（见 extractor
            // 的 stripLlmSpecialTokens）。并入 user content 对任何 chat template
            // 都安全，且不污染 history--history 由会话存储读取，这里的合入仅
            // 存在于本次请求的内存 messages 中。
            const last = messages[messages.length - 1];
            last.content += `\n\n参考代码（请直接输出以下 Mermaid 代码，保持内容一致，仅做必要修正）：\n\`\`\`mermaid\n${welcomeCode}\n\`\`\``;
        }

        let accumulated = '';
        const onContent = (delta) => {
            accumulated += delta;
            if (callbacks.onContent) callbacks.onContent(delta);
        };

        try {
            await this.llm.chatStream(messages, this.buildSystemPrompt(theme), {
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
        // 回退内容也要过特殊 token 剥离：后端泄漏的 <｜end▁of▁sentence｜> 若混在回退
        // 串里原样下发，前端 mermaid 渲染必炸（"No diagram type detected"）。
        let finalCode = extractedCode || stripLlmSpecialTokens(accumulated);
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