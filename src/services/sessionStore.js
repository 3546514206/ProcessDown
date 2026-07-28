/**
 * Session Store
 * Persists per-session conversation history to run/session/<uuid>/history.json.
 * Replaces the old in-memory Map keyed by remoteAddress (which caused
 * cross-talk behind reverse proxies and leaked memory).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

// Generic uuid shape (not strict v4 variant bits) so hand-crafted test ids pass.
// Only hex + hyphens are allowed, which makes path traversal impossible by construction.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SessionStore {
    constructor(config) {
        this.dir = config.session.dir;
        this.maxHistory = config.session.maxHistory;
        fs.mkdirSync(this.dir, { recursive: true });
    }

    isValidId(sessionId) {
        return typeof sessionId === 'string' && UUID_PATTERN.test(sessionId);
    }

    historyPath(sessionId) {
        return path.join(this.dir, sessionId, 'history.json');
    }

    /**
     * Pure existence probe: returns true only when history.json already exists
     * on disk. Does NOT create, throw, or read content - this is the safe way
     * to check whether a session is restorable. readHistory cannot be used for
     * that: it transparently recreates a missing folder+file as a side effect,
     * which would pollute run/session/ with empty stubs for every probed id.
     * "Exists but empty history" (just created, no generate yet) is true: the
     * folder+file are there, only no rounds have been appended. Checking the
     * file path alone is enough - a file cannot exist without its parent dir.
     */
    exists(sessionId) {
        if (!this.isValidId(sessionId)) return false;
        return fs.existsSync(this.historyPath(sessionId));
    }

    create() {
        const sessionId = crypto.randomUUID();
        fs.mkdirSync(path.join(this.dir, sessionId), { recursive: true });
        // Write the empty file immediately so "folder exists => readable" holds
        fs.writeFileSync(this.historyPath(sessionId), '[]');
        return sessionId;
    }

    /**
     * Load raw entries (with ts) as the single recovery path for both
     * readHistory and append. Always leaves a valid file behind:
     * - missing folder/file (e.g. cleaned up while a browser tab still holds
     *   the id) is transparently recreated as empty history;
     * - a corrupt file (unparseable, or valid JSON but not an array) can no
     *   longer serve as history, but its raw bytes may still hold recoverable
     *   fragments — back it up for forensics instead of silently overwriting.
     */
    _loadRaw(sessionId) {
        const filePath = this.historyPath(sessionId);
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (!Array.isArray(parsed)) throw new Error('history is not an array');
            return parsed;
        } catch (e) {
            if (e.code !== 'ENOENT') {
                try {
                    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
                    logger.warn('Corrupted history backed up, starting fresh:', filePath);
                } catch (backupErr) {
                    logger.warn('Could not back up corrupted history:', filePath, backupErr.message);
                }
            }
            fs.mkdirSync(path.join(this.dir, sessionId), { recursive: true });
            fs.writeFileSync(filePath, '[]');
            return [];
        }
    }

    /**
     * Read history for the LLM: [{role, content}, ...] without ts.
     */
    readHistory(sessionId) {
        // Defensive slice: append() already trims, this covers hand-edited files
        return this._loadRaw(sessionId)
            .slice(-this.maxHistory)
            .map(({ role, content }) => ({ role, content }));
    }

    /**
     * Append one round (user + assistant) and trim to maxHistory messages.
     * Synchronous on purpose: single-user low-frequency writes, and it avoids
     * "response sent but not yet on disk" ordering issues.
     */
    append(sessionId, userContent, assistantContent) {
        const entries = this._loadRaw(sessionId);
        const ts = Date.now();
        entries.push({ role: 'user', content: userContent, ts });
        entries.push({ role: 'assistant', content: assistantContent, ts });
        const trimmed = entries.length > this.maxHistory
            ? entries.slice(entries.length - this.maxHistory)
            : entries;
        fs.writeFileSync(this.historyPath(sessionId), JSON.stringify(trimmed, null, 2));
    }
}

/**
 * Delete session folders whose history.json mtime is older than ttlDays.
 * Runs once at server start. Note: appending to history.json does NOT refresh
 * the folder's own mtime, so we must stat the file, not the folder (falling
 * back to the folder mtime only when the file is missing).
 */
function cleanupExpiredSessions(config) {
    const dir = config.session.dir;
    if (!fs.existsSync(dir)) return;

    // ttlDays <= 0 (or NaN from a hand-edited config.json) means "never
    // clean": ttlMs = 0 would make `now - mtime > 0` true for every session
    // and wipe the whole directory
    if (!(config.session.ttlDays > 0)) return;

    const ttlMs = config.session.ttlDays * 86400000;
    const now = Date.now();

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const folderPath = path.join(dir, entry.name);
        try {
            const filePath = path.join(folderPath, 'history.json');
            const stat = fs.statSync(fs.existsSync(filePath) ? filePath : folderPath);
            if (now - stat.mtimeMs > ttlMs) {
                fs.rmSync(folderPath, { recursive: true, force: true });
                logger.info('Cleaned up expired session:', entry.name);
            }
        } catch (e) {
            // A single broken folder must not block startup
            logger.warn('Failed to inspect session folder:', folderPath, e.message);
        }
    }
}

module.exports = { SessionStore, cleanupExpiredSessions };
