/**
 * Logger Utility
 * Simple leveled logging with sensitive data masking.
 *
 * Logs are always written synchronously to run/processdown.log so output is
 * never lost to stdout block-buffering when piped/redirected (Node switches
 * console to 4KB block buffering on non-TTY stdout, which delays or drops the
 * small amount of startup logs). They are also mirrored to the console only
 * when stdout is a TTY (foreground use), avoiding double-writing when start.sh
 * redirects stdout to the same file.
 */

const fs = require('fs');
const path = require('path');

const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

class Logger {
    constructor() {
        this.level = LOG_LEVELS.info;
        this.logFile = this.initLogFile();
    }

    /**
     * Set up synchronous file logging under run/. Returns null (console-only
     * fallback) if the directory cannot be created, so logging never breaks
     * the application.
     */
    initLogFile() {
        try {
            const logDir = path.join(process.cwd(), 'run');
            fs.mkdirSync(logDir, { recursive: true });
            return path.join(logDir, 'processdown.log');
        } catch (e) {
            return null;
        }
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

    /**
     * Emit a formatted log line. Writes synchronously to the log file (never
     * lost to stdout block-buffering) and to the console only when stdout is
     * a TTY (avoids double-writing when start.sh redirects stdout to the
     * same run/processdown.log).
     */
    output(level, formatted) {
        if (process.stdout.isTTY) {
            const method = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log');
            console[method](formatted);
        }
        if (this.logFile) {
            try {
                fs.appendFileSync(this.logFile, formatted + '\n');
            } catch (e) {
                // ignore file write errors; logging must never break the app
            }
        }
    }

    debug(message, ...args) {
        if (this.level <= LOG_LEVELS.debug) {
            this.output('debug', this.formatMessage('debug', message, ...args));
        }
    }

    info(message, ...args) {
        if (this.level <= LOG_LEVELS.info) {
            this.output('info', this.formatMessage('info', message, ...args));
        }
    }

    warn(message, ...args) {
        if (this.level <= LOG_LEVELS.warn) {
            this.output('warn', this.formatMessage('warn', message, ...args));
        }
    }

    error(message, ...args) {
        if (this.level <= LOG_LEVELS.error) {
            this.output('error', this.formatMessage('error', message, ...args));
        }
    }
}

// Export singleton logger
const logger = new Logger();

module.exports = logger;
