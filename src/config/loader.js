/**
 * Configuration Loader
 * Loads and validates configuration from environment variables and config files
 */

const fs = require('fs');
const path = require('path');

// Required environment variables for LLM configuration
const REQUIRED_ENV_VARS = [
    'LLM_API_BASE_URL',
    'LLM_API_KEY',
    'LLM_MODEL'
];

// Optional environment variables
const OPTIONAL_ENV_VARS = [
    'SERVER_PORT',
    'API_AUTH_KEY',
    'ALLOWED_ORIGINS',
    'LOG_LEVEL',
    'NODE_ENV',
    'REQUEST_TIMEOUT'
];

/**
 * Load .env file if it exists
 */
function loadEnvFile() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const lines = envContent.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;

            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1).trim();

            // Remove quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }

            if (!process.env[key]) {
                process.env[key] = value;
            }
        }
    }
}

/**
 * Resolve environment variable references in a string
 * Supports ${VAR_NAME} syntax
 */
function resolveEnvVars(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        return process.env[varName] || match;
    });
}

/**
 * Validate required environment variables
 */
function validateConfig() {
    const missing = REQUIRED_ENV_VARS.filter(function(v) {
        return !process.env[v];
    });

    if (missing.length > 0) {
        console.error('\nError: Required environment variables are not set:');
        missing.forEach(function(v) { console.error('   - ' + v); });
        console.error('\nPlease set these variables in your .env file or environment.');
        console.error('See .env.example for reference.\n');
        process.exit(1);
    }

    // Validate URL format
    const baseUrl = process.env.LLM_API_BASE_URL;
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        console.error('\nError: LLM_API_BASE_URL must start with http:// or https://\n');
        process.exit(1);
    }

    console.log('Configuration validated');
}

/**
 * Load configuration from config file and merge with environment variables
 */
function loadConfig() {
    // Load .env file first
    loadEnvFile();

    // Validate required variables
    validateConfig();

    // Load additional config from config.json if exists
    const configPath = path.join(process.cwd(), 'config', 'config.json');
    let fileConfig = {};

    if (fs.existsSync(configPath)) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (e) {
            console.warn('Warning: Could not parse config.json:', e.message);
        }
    }

    // Build final config object
    const config = {
        server: {
            port: parseInt(process.env.SERVER_PORT) || fileConfig.server?.port || 3000,
            timeout: parseInt(process.env.REQUEST_TIMEOUT) || fileConfig.server?.timeout || 120
        },
        cors: {
            enabled: true,
            origins: process.env.ALLOWED_ORIGINS
                ? process.env.ALLOWED_ORIGINS.split(',').map(function(o) { return o.trim(); })
                : (fileConfig.cors?.origins || []).map(resolveEnvVars),
            originsSeparator: ','
        },
        rateLimit: {
            enabled: fileConfig.rateLimit?.enabled || true,
            maxRequests: fileConfig.rateLimit?.maxRequests || 100,
            windowMs: fileConfig.rateLimit?.windowMs || 60000
        },
        llm: {
            baseUrl: process.env.LLM_API_BASE_URL,
            apiKey: process.env.LLM_API_KEY,
            model: process.env.LLM_MODEL,
            temperature: fileConfig.llm?.temperature || 0.3,
            maxTokens: fileConfig.llm?.maxTokens || 2000,
            timeout: fileConfig.llm?.timeout || 120
        },
        logging: {
            level: process.env.LOG_LEVEL || fileConfig.logging?.level || 'info',
            maskSensitive: true
        },
        auth: {
            enabled: !!process.env.API_AUTH_KEY,
            apiKey: process.env.API_AUTH_KEY || null
        }
    };

    return config;
}

// Export singleton config
let configInstance = null;

function getConfig() {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}

module.exports = { getConfig, loadConfig, validateConfig };