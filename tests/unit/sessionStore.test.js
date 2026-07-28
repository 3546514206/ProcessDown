'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SessionStore, cleanupExpiredSessions } = require('../../src/services/sessionStore');

describe('SessionStore', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processdown-test-'));
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        // Clean up any existing files in tempDir between tests
        for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
            const entryPath = path.join(tempDir, entry.name);
            fs.rmSync(entryPath, { recursive: true, force: true });
        }
        store = new SessionStore({
            session: {
                dir: tempDir,
                maxHistory: 20,
                ttlDays: 7
            }
        });
    });

    describe('create()', () => {
        it('should return a valid UUID v4', () => {
            const sessionId = store.create();
            assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        });

        it('should create session folder on disk', () => {
            const sessionId = store.create();
            const sessionDir = path.join(tempDir, sessionId);
            assert.ok(fs.existsSync(sessionDir), 'Session folder should exist');
        });

        it('should create empty history.json file', () => {
            const sessionId = store.create();
            const historyPath = path.join(tempDir, sessionId, 'history.json');
            assert.ok(fs.existsSync(historyPath), 'history.json should exist');
            const content = fs.readFileSync(historyPath, 'utf-8');
            assert.strictEqual(content, '[]');
        });
    });

    describe('isValidId()', () => {
        it('should return true for valid lowercase UUID', () => {
            assert.ok(store.isValidId('550e8400-e29b-41d4-a716-446655440000'));
        });

        it('should return true for valid uppercase UUID', () => {
            assert.ok(store.isValidId('550E8400-E29B-41D4-A716-446655440000'));
        });

        it('should return true for valid mixed-case UUID', () => {
            assert.ok(store.isValidId('550e8400-E29B-41D4-a716-446655440000'));
        });

        it('should return false for empty string', () => {
            assert.strictEqual(store.isValidId(''), false);
        });

        it('should return false for non-string (null)', () => {
            assert.strictEqual(store.isValidId(null), false);
        });

        it('should return false for non-string (number)', () => {
            assert.strictEqual(store.isValidId(123), false);
        });

        it('should return false for non-string (object)', () => {
            assert.strictEqual(store.isValidId({}), false);
        });

        it('should return false for path traversal attempt', () => {
            assert.strictEqual(store.isValidId('../../etc/passwd'), false);
        });

        it('should return false for string with slashes', () => {
            assert.strictEqual(store.isValidId('550e8400/e29b/41d4/a716/446655440000'), false);
        });

        it('should return false for overly long string', () => {
            const longId = 'a'.repeat(1000);
            assert.strictEqual(store.isValidId(longId), false);
        });

        it('should return false for almost-UUID with wrong length', () => {
            assert.strictEqual(store.isValidId('550e8400-e29b-41d4-a716-44665544000'), false);
        });

        it('should return false for UUID with invalid characters', () => {
            assert.strictEqual(store.isValidId('550e8400-e29b-41d4-a716-44665544000g'), false);
        });
    });

    describe('readHistory()', () => {
        it('should return empty array for new session', () => {
            const sessionId = store.create();
            const history = store.readHistory(sessionId);
            assert.deepStrictEqual(history, []);
        });

        it('should recreate folder and return [] if folder does not exist', () => {
            const sessionId = '550e8400-e29b-41d4-a716-446655440000';
            const history = store.readHistory(sessionId);
            assert.deepStrictEqual(history, []);
            assert.ok(fs.existsSync(path.join(tempDir, sessionId, 'history.json')));
        });

        it('should return [] and recreate file if JSON is corrupted, with backup', () => {
            const sessionId = store.create();
            const historyPath = path.join(tempDir, sessionId, 'history.json');
            const corruptedContent = 'this is not json';
            fs.writeFileSync(historyPath, corruptedContent);

            const history = store.readHistory(sessionId);
            assert.deepStrictEqual(history, []);

            // File should be reset to valid empty array
            const content = fs.readFileSync(historyPath, 'utf-8');
            assert.strictEqual(content, '[]');

            // Backup file should exist with original content
            const files = fs.readdirSync(path.join(tempDir, sessionId));
            const backupFile = files.find(f => f.startsWith('history.json.corrupt-'));
            assert.ok(backupFile, 'Backup file should exist');
            const backupContent = fs.readFileSync(path.join(tempDir, sessionId, backupFile), 'utf-8');
            assert.strictEqual(backupContent, corruptedContent);
        });

        it('should return [] and recreate file if JSON is valid but not an array, with backup', () => {
            const sessionId = store.create();
            const historyPath = path.join(tempDir, sessionId, 'history.json');
            const nonArrayContent = '{"not": "an array"}';
            fs.writeFileSync(historyPath, nonArrayContent);

            const history = store.readHistory(sessionId);
            assert.deepStrictEqual(history, []);

            // File should be reset to valid empty array
            const content = fs.readFileSync(historyPath, 'utf-8');
            assert.strictEqual(content, '[]');

            // Backup file should exist with original content
            const files = fs.readdirSync(path.join(tempDir, sessionId));
            const backupFile = files.find(f => f.startsWith('history.json.corrupt-'));
            assert.ok(backupFile, 'Backup file should exist');
            const backupContent = fs.readFileSync(path.join(tempDir, sessionId, backupFile), 'utf-8');
            assert.strictEqual(backupContent, nonArrayContent);
        });

        it('should strip ts field from returned entries', () => {
            const sessionId = store.create();
            const historyPath = path.join(tempDir, sessionId, 'history.json');
            fs.writeFileSync(historyPath, JSON.stringify([
                { role: 'user', content: 'hello', ts: 1234567890 },
                { role: 'assistant', content: 'hi', ts: 1234567891 }
            ]));

            const history = store.readHistory(sessionId);
            assert.deepStrictEqual(history, [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi' }
            ]);
        });

        it('should truncate to maxHistory entries (slice from end)', () => {
            const smallStore = new SessionStore({
                session: { dir: tempDir, maxHistory: 4, ttlDays: 7 }
            });
            const sessionId = smallStore.create();
            const historyPath = path.join(tempDir, sessionId, 'history.json');

            const entries = [];
            for (let i = 0; i < 10; i++) {
                entries.push({ role: 'user', content: `msg${i}`, ts: 1234567890 + i });
            }
            fs.writeFileSync(historyPath, JSON.stringify(entries));

            const history = smallStore.readHistory(sessionId);
            assert.strictEqual(history.length, 4);
            assert.deepStrictEqual(history, [
                { role: 'user', content: 'msg6' },
                { role: 'user', content: 'msg7' },
                { role: 'user', content: 'msg8' },
                { role: 'user', content: 'msg9' }
            ]);
        });
    });

    describe('append()', () => {
        it('should append one round (user + assistant) with ts', () => {
            const sessionId = store.create();
            store.append(sessionId, 'user message', 'assistant message');

            const historyPath = path.join(tempDir, sessionId, 'history.json');
            const entries = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));

            assert.strictEqual(entries.length, 2);
            assert.strictEqual(entries[0].role, 'user');
            assert.strictEqual(entries[0].content, 'user message');
            assert.ok(entries[0].ts, 'user entry should have ts');
            assert.strictEqual(entries[1].role, 'assistant');
            assert.strictEqual(entries[1].content, 'assistant message');
            assert.ok(entries[1].ts, 'assistant entry should have ts');
        });

        it('should grow history with multiple appends', () => {
            const sessionId = store.create();
            store.append(sessionId, 'round1 user', 'round1 assistant');
            store.append(sessionId, 'round2 user', 'round2 assistant');

            const historyPath = path.join(tempDir, sessionId, 'history.json');
            const entries = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));

            assert.strictEqual(entries.length, 4);
            assert.strictEqual(entries[0].content, 'round1 user');
            assert.strictEqual(entries[3].content, 'round2 assistant');
        });

        it('should trim from head when exceeding maxHistory', () => {
            const smallStore = new SessionStore({
                session: { dir: tempDir, maxHistory: 4, ttlDays: 7 }
            });
            const sessionId = smallStore.create();

            smallStore.append(sessionId, 'round1 user', 'round1 assistant');
            smallStore.append(sessionId, 'round2 user', 'round2 assistant');
            smallStore.append(sessionId, 'round3 user', 'round3 assistant'); // This should push out round1

            const historyPath = path.join(tempDir, sessionId, 'history.json');
            const entries = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));

            assert.strictEqual(entries.length, 4);
            assert.strictEqual(entries[0].content, 'round2 user');
            assert.strictEqual(entries[3].content, 'round3 assistant');
        });

        it('should start fresh but keep current round if file is corrupted, with backup', () => {
            const sessionId = store.create();
            const historyPath = path.join(tempDir, sessionId, 'history.json');
            const corruptedContent = 'corrupted data';
            fs.writeFileSync(historyPath, corruptedContent);

            store.append(sessionId, 'user msg', 'assistant msg');

            const entries = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            assert.strictEqual(entries.length, 2);
            assert.strictEqual(entries[0].content, 'user msg');

            // Backup file should exist with original content
            const files = fs.readdirSync(path.join(tempDir, sessionId));
            const backupFile = files.find(f => f.startsWith('history.json.corrupt-'));
            assert.ok(backupFile, 'Backup file should exist');
            const backupContent = fs.readFileSync(path.join(tempDir, sessionId, backupFile), 'utf-8');
            assert.strictEqual(backupContent, corruptedContent);
        });

        it('should start fresh but keep current round if JSON is valid but not array, with backup', () => {
            const sessionId = store.create();
            const historyPath = path.join(tempDir, sessionId, 'history.json');
            const nonArrayContent = '{"valid": "json", "but": "not array"}';
            fs.writeFileSync(historyPath, nonArrayContent);

            store.append(sessionId, 'user msg', 'assistant msg');

            const entries = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            assert.strictEqual(entries.length, 2);
            assert.strictEqual(entries[0].content, 'user msg');

            // Backup file should exist with original content
            const files = fs.readdirSync(path.join(tempDir, sessionId));
            const backupFile = files.find(f => f.startsWith('history.json.corrupt-'));
            assert.ok(backupFile, 'Backup file should exist');
            const backupContent = fs.readFileSync(path.join(tempDir, sessionId, backupFile), 'utf-8');
            assert.strictEqual(backupContent, nonArrayContent);
        });

        it('should recreate folder and write current round if session folder does not exist, no backup', () => {
            const sessionId = '550e8400-e29b-41d4-a716-446655440000';
            const sessionDir = path.join(tempDir, sessionId);

            // Ensure folder does not exist
            assert.strictEqual(fs.existsSync(sessionDir), false);

            store.append(sessionId, 'user msg', 'assistant msg');

            // Folder should be created
            assert.ok(fs.existsSync(sessionDir));
            const historyPath = path.join(sessionDir, 'history.json');
            assert.ok(fs.existsSync(historyPath));

            const entries = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            assert.strictEqual(entries.length, 2);
            assert.strictEqual(entries[0].content, 'user msg');

            // No backup file (ENOENT case)
            const files = fs.readdirSync(sessionDir);
            const backupFile = files.find(f => f.startsWith('history.json.corrupt-'));
            assert.strictEqual(backupFile, undefined, 'No backup file should exist for ENOENT');
        });
    });
});

describe('cleanupExpiredSessions', () => {
    let tempDir;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processdown-cleanup-test-'));
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
            const entryPath = path.join(tempDir, entry.name);
            fs.rmSync(entryPath, { recursive: true, force: true });
        }
    });

    it('should return immediately if dir does not exist', () => {
        const config = { session: { dir: path.join(tempDir, 'nonexistent'), ttlDays: 7 } };
        // Should not throw
        cleanupExpiredSessions(config);
    });

    it('should delete expired session folders', () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440000';
        const sessionDir = path.join(tempDir, sessionId);
        fs.mkdirSync(sessionDir);
        const historyPath = path.join(sessionDir, 'history.json');
        fs.writeFileSync(historyPath, '[]');

        // Set mtime to 10 days ago (older than ttlDays=7)
        const oldTime = Date.now() - 10 * 86400000;
        fs.utimesSync(historyPath, new Date(oldTime / 1000), new Date(oldTime / 1000));

        const config = { session: { dir: tempDir, ttlDays: 7 } };
        cleanupExpiredSessions(config);

        assert.strictEqual(fs.existsSync(sessionDir), false, 'Expired session should be deleted');
    });

    it('should keep non-expired session folders', () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440001';
        const sessionDir = path.join(tempDir, sessionId);
        fs.mkdirSync(sessionDir);
        const historyPath = path.join(sessionDir, 'history.json');
        fs.writeFileSync(historyPath, '[]');

        // Leave mtime as current time (much newer than ttlDays=7)
        const config = { session: { dir: tempDir, ttlDays: 7 } };
        cleanupExpiredSessions(config);

        assert.ok(fs.existsSync(sessionDir), 'Non-expired session should remain');
    });

    it('should not block on broken folders (continue processing others)', () => {
        // Create a broken entry (file instead of folder)
        fs.writeFileSync(path.join(tempDir, 'not-a-folder'), 'content');

        // Create a valid expired session
        const sessionId = '550e8400-e29b-41d4-a716-446655440002';
        const sessionDir = path.join(tempDir, sessionId);
        fs.mkdirSync(sessionDir);
        const historyPath = path.join(sessionDir, 'history.json');
        fs.writeFileSync(historyPath, '[]');
        const oldTime = Date.now() - 10 * 86400000;
        fs.utimesSync(historyPath, new Date(oldTime / 1000), new Date(oldTime / 1000));

        const config = { session: { dir: tempDir, ttlDays: 7 } };
        // Should not throw
        cleanupExpiredSessions(config);

        // The valid expired session should still be deleted
        assert.strictEqual(fs.existsSync(sessionDir), false);
    });

    it('should use folder mtime as fallback when history.json is missing', () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440003';
        const sessionDir = path.join(tempDir, sessionId);
        fs.mkdirSync(sessionDir);
        // No history.json file

        // Set folder mtime to old
        const oldTime = Date.now() - 10 * 86400000;
        fs.utimesSync(sessionDir, new Date(oldTime / 1000), new Date(oldTime / 1000));

        const config = { session: { dir: tempDir, ttlDays: 7 } };
        cleanupExpiredSessions(config);

        assert.strictEqual(fs.existsSync(sessionDir), false);
    });

    it('should not delete any folders when ttlDays=0, including expired ones', () => {
        // Create an expired session
        const expiredId = '550e8400-e29b-41d4-a716-446655440004';
        const expiredDir = path.join(tempDir, expiredId);
        fs.mkdirSync(expiredDir);
        const expiredPath = path.join(expiredDir, 'history.json');
        fs.writeFileSync(expiredPath, '[]');
        const oldTime = Date.now() - 10 * 86400000;
        fs.utimesSync(expiredPath, new Date(oldTime / 1000), new Date(oldTime / 1000));

        // Create a non-expired session
        const freshId = '550e8400-e29b-41d4-a716-446655440005';
        const freshDir = path.join(tempDir, freshId);
        fs.mkdirSync(freshDir);
        fs.writeFileSync(path.join(freshDir, 'history.json'), '[]');

        const config = { session: { dir: tempDir, ttlDays: 0 } };
        cleanupExpiredSessions(config);

        // Both should still exist
        assert.ok(fs.existsSync(expiredDir), 'Expired session should not be deleted with ttlDays=0');
        assert.ok(fs.existsSync(freshDir), 'Non-expired session should remain');
    });

    it('should not delete any folders when ttlDays=-1, including expired ones', () => {
        // Create an expired session
        const expiredId = '550e8400-e29b-41d4-a716-446655440006';
        const expiredDir = path.join(tempDir, expiredId);
        fs.mkdirSync(expiredDir);
        const expiredPath = path.join(expiredDir, 'history.json');
        fs.writeFileSync(expiredPath, '[]');
        const oldTime = Date.now() - 10 * 86400000;
        fs.utimesSync(expiredPath, new Date(oldTime / 1000), new Date(oldTime / 1000));

        const config = { session: { dir: tempDir, ttlDays: -1 } };
        cleanupExpiredSessions(config);

        // Should still exist
        assert.ok(fs.existsSync(expiredDir), 'Expired session should not be deleted with ttlDays=-1');
    });
});
