/**
 * LLM Service
 * Handles calls to LLM APIs (OpenAI compatible format)
 */

const https = require('https');
const http = require('http');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const logger = require('../../utils/logger');

/**
 * 流式 <think> 标签分离器：把含 `<think>...</think>` 的 content 流拆成
 * thinking 与 content 两路回调。标签可能跨 chunk 到达，用缓冲 + 后缀前缀
 * 匹配保留可能的半个标签，避免把 `<th` 误判为正文。未闭合标签在 finalize
 * 兜底（流结束时仍在 think 内则全部归 thinking）。
 *
 * 仅匹配小写 `<think>`/`</think>`（DeepSeek-R1 / QwQ 等的实际形态）；其余
 * 大小写变体由 extractMermaidCode 的 case-insensitive 剥离兜底，不影响
 * 最终落盘的 mermaid 代码。
 */
function createThinkSplitter(onThinking, onContent) {
    const OPEN = '<think>';
    const CLOSE = '</think>';
    let inThink = false;
    let buf = '';

    // text 末尾最长的、同时是 tag 前缀的子串长度（需 hold 住等下一段 chunk）
    function suffixPrefixLen(text, tag) {
        const max = Math.min(text.length, tag.length - 1);
        for (let i = max; i > 0; i--) {
            if (text.slice(-i) === tag.slice(0, i)) return i;
        }
        return 0;
    }

    function feed(text) {
        buf += text;
        let progress = true;
        while (progress) {
            progress = false;
            const tag = inThink ? CLOSE : OPEN;
            const idx = buf.indexOf(tag);
            if (idx !== -1) {
                if (idx > 0) (inThink ? onThinking : onContent)(buf.slice(0, idx));
                buf = buf.slice(idx + tag.length);
                inThink = !inThink;
                progress = true;
            } else {
                // 没找到完整标签：放出安全部分，hold 住可能是半个标签的尾部
                const hold = suffixPrefixLen(buf, tag);
                const emitLen = buf.length - hold;
                if (emitLen > 0) {
                    (inThink ? onThinking : onContent)(buf.slice(0, emitLen));
                    buf = buf.slice(emitLen);
                }
            }
        }
    }

    function finalize() {
        if (buf) {
            (inThink ? onThinking : onContent)(buf);
            buf = '';
        }
    }

    return { feed, finalize };
}

class LLMService {
    constructor(config) {
        this.baseUrl = config.llm.baseUrl;
        this.apiKey = config.llm.apiKey;
        this.model = config.llm.model;
        this.temperature = config.llm.temperature;
        this.maxTokens = config.llm.maxTokens;
        this.timeout = config.llm.timeout * 1000; // Convert to ms
    }

    /**
     * Make HTTP/HTTPS request to LLM API
     */
    makeRequest(payload) {
        return new Promise((resolve, reject) => {
            const baseUrlObj = new URL(this.baseUrl);
            const isHttps = baseUrlObj.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            let requestPath = baseUrlObj.pathname;
            if (!requestPath.endsWith('/chat/completions')) {
                requestPath = requestPath.replace(/\/$/, '') + '/chat/completions';
            }

            const options = {
                hostname: baseUrlObj.hostname,
                port: baseUrlObj.port || (isHttps ? 443 : 80),
                path: requestPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                timeout: this.timeout
            };

            logger.debug('LLM request URL:', `${options.hostname}${options.path}`);

            const req = httpModule.request(options, (res) => {
                // 收集 Buffer 后一次性 concat 解码，避免逐 chunk toString 把跨 TCP 边界的
                // 多字节中文拆成 U+FFFD（与 server/index.js parseBody 同一处理）
                const chunks = [];

                res.on('data', chunk => {
                    chunks.push(chunk);
                });

                res.on('end', () => {
                    const data = Buffer.concat(chunks).toString('utf8');
                    try {
                        const parsed = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(parsed);
                        } else {
                            logger.error('LLM API error:', res.statusCode, parsed);
                            reject(new Error(parsed.error?.message || `API error: ${res.statusCode}`));
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse API response: ${e.message}`));
                    }
                });
            });

            req.on('error', (e) => {
                logger.error('LLM request error:', e.message);
                reject(new Error(`Request failed: ${e.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timeout after ${this.timeout}ms`));
            });

            req.write(JSON.stringify(payload));
            req.end();
        });
    }

    /**
     * Send chat completion request
     */
    async chat(messages, systemPrompt) {
        const fullMessages = [];

        // Add system prompt if provided
        if (systemPrompt) {
            fullMessages.push({
                role: 'system',
                content: systemPrompt
            });
        }

        // Add conversation history
        fullMessages.push(...messages);

        const payload = {
            model: this.model,
            messages: fullMessages,
            temperature: this.temperature
        };
        // max_tokens omitted when non-positive (-1 = unlimited; 0/NaN also
        // guarded) so the model generates up to its own context limit. Needed
        // for slow models whose <think> block would otherwise exhaust a small
        // token budget before the diagram is output.
        if (this.maxTokens > 0) {
            payload.max_tokens = this.maxTokens;
        }

        logger.info('Sending request to LLM, model:', this.model);

        try {
            const response = await this.makeRequest(payload);
            return response.choices?.[0]?.message?.content || '';
        } catch (error) {
            logger.error('LLM chat error:', error.message);
            throw error;
        }
    }

    /**
     * TCP-only reachability probe for health checks. Verifies the LLM
     * endpoint is accepting connections without sending a chat request,
     * so it stays fast (sub-second) even when the model itself is slow --
     * air-gapped local LLMs can take tens of seconds per completion.
     * Does not throw; returns a status object instead.
     */
    async ping(timeoutMs = 2000) {
        const baseUrlObj = new URL(this.baseUrl);
        const port = parseInt(baseUrlObj.port) || (baseUrlObj.protocol === 'https:' ? 443 : 80);
        const host = baseUrlObj.hostname;
        return new Promise(resolve => {
            const socket = new net.Socket();
            let settled = false;
            let timer;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                resolve(result);
            };
            timer = setTimeout(() => {
                finish({ reachable: false, model: this.model, error: 'TCP connect timeout' });
            }, timeoutMs);
            socket.once('connect', () => {
                finish({ reachable: true, model: this.model });
            });
            socket.once('error', (err) => {
                finish({ reachable: false, model: this.model, error: err.message });
            });
            socket.connect(port, host);
        });
    }

    /**
     * 底层流式 HTTPS 请求：按 SSE 协议逐行解析 `data: <json>`，对每个 delta
     * 调 handlers.onDelta，流结束 resolve。与 makeRequest 的区别仅在响应处理
     * （流式累积 vs 一次性 JSON.parse），URL/headers 构建刻意保持一致以便审阅。
     * signal 用于客户端断开时中止上游 LLM 请求，避免空跑耗 token。
     */
    makeStreamRequest(payload, signal, handlers) {
        return new Promise((resolve, reject) => {
            const baseUrlObj = new URL(this.baseUrl);
            const isHttps = baseUrlObj.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            let requestPath = baseUrlObj.pathname;
            if (!requestPath.endsWith('/chat/completions')) {
                requestPath = requestPath.replace(/\/$/, '') + '/chat/completions';
            }

            const options = {
                hostname: baseUrlObj.hostname,
                port: baseUrlObj.port || (isHttps ? 443 : 80),
                path: requestPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Accept': 'text/event-stream'
                },
                timeout: this.timeout
            };

            const req = httpModule.request(options, (res) => {
                // 非 2xx：累积完整错误体再 reject（与 makeRequest 语义一致）
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const errChunks = [];
                    res.on('data', c => { errChunks.push(c); });
                    res.on('end', () => {
                        const data = Buffer.concat(errChunks).toString('utf8');
                        let msg = `API error: ${res.statusCode}`;
                        try {
                            const parsed = JSON.parse(data);
                            msg = parsed.error?.message || msg;
                        } catch (e) { /* 非 JSON 错误体保留状态码描述 */ }
                        logger.error('LLM stream API error:', res.statusCode, data);
                        reject(new Error(msg));
                    });
                    return;
                }

                // StringDecoder 保留跨 chunk 的不完整 UTF-8 字节序列，避免中文 3 字节
                // 字符被 TCP 拆分后逐 chunk toString 损坏为 U+FFFD（与 server/index.js
                // parseBody 用 Buffer.concat 同一问题，流式路径用 StringDecoder 解决）。
                const decoder = new StringDecoder('utf8');
                let lineBuf = '';
                res.on('data', (chunk) => {
                    lineBuf += decoder.write(chunk);
                    // SSE 事件以换行分隔；按 \n 切片，最后一段可能不完整，留作下轮拼接
                    const lines = lineBuf.split('\n');
                    lineBuf = lines.pop();
                    for (const line of lines) {
                        handleLine(line);
                    }
                });
                res.on('end', () => {
                    lineBuf += decoder.end(); // 冲刷残留字节
                    if (lineBuf.trim()) handleLine(lineBuf);
                    resolve();
                });
                res.on('error', (e) => reject(streamError(e, signal)));

                function handleLine(line) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) return;
                    const jsonStr = trimmed.slice(5).trim();
                    if (jsonStr === '[DONE]') return; // 结束标记：交由 res end 兜底 resolve
                    try {
                        const parsed = JSON.parse(jsonStr);
                        const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                        if (delta && handlers.onDelta) handlers.onDelta(delta);
                    } catch (e) {
                        // 畸形 SSE 数据（StringDecoder 已消除 UTF-8 跨 chunk 损坏）；
                        // 半截行不会到达这里（split+pop 保证只处理完整行）。静默跳过。
                    }
                }
            });

            req.on('error', (e) => reject(streamError(e, signal)));
            req.on('timeout', () => {
                req.destroy();
                // 用 streamError：若客户端已 abort 则归类为 ABORTED，路由静默收尾而非走 error 事件
                reject(streamError(new Error(`Request timeout after ${this.timeout}ms`), signal));
            });

            // 调用方传入已 abort 的 signal：不发请求，直接 ABORTED 上抛
            if (signal && signal.aborted) {
                req.destroy();
                reject(streamError(new Error('aborted'), signal));
                return;
            }
            // 流式过程中客户端断开 -> abort -> destroy 上游请求 + 主动 reject
            // （destroy 不保证触发 'error'，显式 reject 更稳）
            if (signal) {
                signal.addEventListener('abort', () => {
                    req.destroy();
                    reject(streamError(new Error('aborted'), signal));
                }, { once: true });
            }

            req.write(JSON.stringify(payload));
            req.end();
        });
    }

    /**
     * 流式 chat：payload 加 stream:true，逐 delta 回调。
     * 思考与正文分离：reasoning_content（DeepSeek/QwQ 原生字段）直接归 onThinking；
     * content 经 createThinkSplitter 拆出内嵌的 <think> 段，think 部分归 onThinking、
     * 其余归 onContent。流结束 finalize 冲刷缓冲。max_tokens 省略规则与 chat 一致。
     */
    async chatStream(messages, systemPrompt, callbacks = {}, signal) {
        const fullMessages = [];
        if (systemPrompt) {
            fullMessages.push({ role: 'system', content: systemPrompt });
        }
        fullMessages.push(...messages);

        const payload = {
            model: this.model,
            messages: fullMessages,
            temperature: this.temperature,
            stream: true
        };
        if (this.maxTokens > 0) {
            payload.max_tokens = this.maxTokens;
        }

        const onThinking = callbacks.onThinking || (() => {});
        const onContentRaw = callbacks.onContent || (() => {});
        const splitter = createThinkSplitter(onThinking, onContentRaw);

        logger.info('Sending streaming request to LLM, model:', this.model);

        await this.makeStreamRequest(payload, signal, {
            onDelta: (delta) => {
                if (delta.reasoning_content) onThinking(delta.reasoning_content);
                if (delta.content) splitter.feed(delta.content);
            }
        });
        // 流结束冲刷 <think> 状态机残留缓冲
        splitter.finalize();
    }
}

// abort 优先识别：客户端主动断开（signal abort）导致的 destroy 不应当作 LLM 错误上抛
function streamError(e, signal) {
    if (signal && signal.aborted) {
        const err = new Error('aborted');
        err.code = 'ABORTED';
        return err;
    }
    return new Error(`Request failed: ${e.message}`);
}

module.exports = LLMService;