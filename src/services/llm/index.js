/**
 * LLM Service
 * Handles calls to LLM APIs (OpenAI compatible format)
 */

const https = require('https');
const http = require('http');
const logger = require('../../utils/logger');

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
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
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
            temperature: this.temperature,
            max_tokens: this.maxTokens
        };

        logger.info('Sending request to LLM, model:', this.model);

        try {
            const response = await this.makeRequest(payload);
            return response.choices?.[0]?.message?.content || '';
        } catch (error) {
            logger.error('LLM chat error:', error.message);
            throw error;
        }
    }
}

module.exports = LLMService;