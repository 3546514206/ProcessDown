/**
 * Logger Utility
 * Simple leveled logging with sensitive data masking
 */

const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

class Logger {
    constructor() {
        this.level = LOG_LEVELS.info;
    }

    setLevel(level) {
        if (LOG_LEVELS[level] !== undefined) {
            this.level = LOG_LEVELS[level];
        }
    }

    /**
     * Mask sensitive information in logs
     */
    maskSensitive(str) {
        if (typeof str !== 'string') return str;

        // Mask API keys, tokens, and similar sensitive data
        let masked = str
            .replace(/(api[_-]?key["']?\s*[=:]\s*)["']?([a-zA-Z0-9_-]{20,})/gi, '$1[REDACTED]')
            .replace(/(LLM_API_KEY["']?\s*[=:]\s*)["']?([a-zA-Z0-9_-]{20,})/gi, '$1[REDACTED]')
            .replace(/(Authorization["']?\s*[=:]\s*)["']?(Bearer\s+)?[a-zA-Z0-9_-]{20,}/gi, '$1[REDACTED]')
            .replace(/(api[_-]?secret["']?\s*[=:]\s*)["']?([a-zA-Z0-9_-]{20,})/gi, '$1[REDACTED]');

        // Mask URLs with potential API keys embedded
        masked = masked.replace(/([a-zA-Z0-9_-]{20,})@[a-zA-Z0-9._-]+/g, '[REDACTED]@[HOST]');

        return masked;
    }

    formatMessage(level, message, ...args) {
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

        // Process arguments for sensitive data
        const processedArgs = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    const str = JSON.stringify(arg);
                    return this.maskSensitive(str);
                } catch {
                    return '[Object]';
                }
            }
            return this.maskSensitive(String(arg));
        });

        return processedArgs.length > 0
            ? `${prefix} ${message} ${processedArgs.join(' ')}`
            : `${prefix} ${message}`;
    }

    debug(message, ...args) {
        if (this.level <= LOG_LEVELS.debug) {
            console.log(this.formatMessage('debug', message, ...args));
        }
    }

    info(message, ...args) {
        if (this.level <= LOG_LEVELS.info) {
            console.log(this.formatMessage('info', message, ...args));
        }
    }

    warn(message, ...args) {
        if (this.level <= LOG_LEVELS.warn) {
            console.warn(this.formatMessage('warn', message, ...args));
        }
    }

    error(message, ...args) {
        if (this.level <= LOG_LEVELS.error) {
            console.error(this.formatMessage('error', message, ...args));
        }
    }
}

// Export singleton logger
const logger = new Logger();

module.exports = logger;