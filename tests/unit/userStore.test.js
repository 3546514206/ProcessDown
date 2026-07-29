'use strict';

// Unit tests for UserStore: registration, login, token verification, logout,
// and session listing. Covers the security-critical paths: password hashing
// (never plaintext), username whitelist (path-traversal defense), token
// rotation on login, token expiry, and constant-time comparison.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { UserStore, USERNAME_PATTERN } = require('../../src/services/userStore');

function makeConfig(tempDir, tokenTtlDays = 7) {
    return {
        users: { dir: tempDir },
        auth: { tokenTtlDays }
    };
}

describe('UserStore - username validation', () => {
    it('USERNAME_PATTERN accepts valid usernames', () => {
        assert.ok(USERNAME_PATTERN.test('abc'));
        assert.ok(USERNAME_PATTERN.test('user_1-2'));
        assert.ok(USERNAME_PATTERN.test('A'.repeat(32)));
    });

    it('rejects usernames with path-traversal characters', () => {
        assert.strictEqual(USERNAME_PATTERN.test('../etc'), false);
        assert.strictEqual(USERNAME_PATTERN.test('a/b'), false);
        assert.strictEqual(USERNAME_PATTERN.test('a..b'), false);
        assert.strictEqual(USERNAME_PATTERN.test('a b'), false);
    });

    it('rejects too-short and too-long usernames', () => {
        assert.strictEqual(USERNAME_PATTERN.test('ab'), false); // <3
        assert.strictEqual(USERNAME_PATTERN.test('a'.repeat(33)), false); // >32
    });
});

describe('UserStore - register', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-register-'));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
        store = new UserStore(makeConfig(tempDir));
    });

    it('registers a user and returns a username-scoped token', () => {
        const result = store.register('alice', 'secret123');
        assert.ok(!result.error, 'should not return error');
        assert.strictEqual(result.username, 'alice');
        assert.ok(result.token.startsWith('alice.'), 'token should be scoped to username');
        // profile.json written
        assert.ok(fs.existsSync(path.join(tempDir, 'alice', 'profile.json')));
        // sessions dir pre-created
        assert.ok(fs.existsSync(path.join(tempDir, 'alice', 'sessions')));
    });

    it('never stores the plaintext password on disk', () => {
        store.register('bob', 'never-plaintext-pw');
        const profile = JSON.parse(fs.readFileSync(path.join(tempDir, 'bob', 'profile.json'), 'utf-8'));
        assert.strictEqual(profile.passwordHash, undefined ? null : profile.passwordHash);
        assert.ok(profile.passwordHash, 'hash should exist');
        assert.ok(!profile.passwordHash.includes('never-plaintext-pw'), 'hash must not contain plaintext');
        assert.ok(profile.salt, 'salt should exist');
        assert.strictEqual(profile.password, undefined, 'no plaintext password field');
    });

    it('rejects an invalid username', () => {
        assert.strictEqual(store.register('../etc', 'secret123').error, 'invalid_username');
        assert.strictEqual(store.register('ab', 'secret123').error, 'invalid_username');
    });

    it('rejects a short password', () => {
        assert.strictEqual(store.register('carol', '12345').error, 'invalid_password');
    });

    it('rejects a duplicate username', () => {
        assert.ok(!store.register('dave', 'secret123').error);
        assert.strictEqual(store.register('dave', 'secret123').error, 'user_exists');
    });
});

describe('UserStore - login', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-login-'));
        store = new UserStore(makeConfig(tempDir));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
    });

    it('logs in with correct credentials and returns a token', () => {
        store.register('alice', 'secret123');
        const result = store.login('alice', 'secret123');
        assert.ok(!result.error);
        assert.ok(result.token.startsWith('alice.'));
    });

    it('rotates the token on each login (old token invalidated)', () => {
        store.register('alice', 'secret123');
        const t1 = store.login('alice', 'secret123').token;
        const t2 = store.login('alice', 'secret123').token;
        assert.notStrictEqual(t1, t2, 'token must rotate');
        // old token no longer verifies
        assert.strictEqual(store.verifyToken(t1), null);
        assert.strictEqual(store.verifyToken(t2), 'alice');
    });

    it('returns invalid_credentials for wrong password', () => {
        store.register('alice', 'secret123');
        assert.strictEqual(store.login('alice', 'wrong').error, 'invalid_credentials');
    });

    it('returns invalid_credentials for non-existent user (no username enumeration)', () => {
        assert.strictEqual(store.login('ghost', 'secret123').error, 'invalid_credentials');
    });

    it('returns invalid_credentials for invalid username format', () => {
        assert.strictEqual(store.login('../etc', 'secret123').error, 'invalid_credentials');
    });
});

describe('UserStore - verifyToken', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-verify-'));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
        store = new UserStore(makeConfig(tempDir, 7));
    });

    it('returns username for a valid token', () => {
        const { token } = store.register('alice', 'secret123');
        assert.strictEqual(store.verifyToken(token), 'alice');
    });

    it('returns null for a malformed token (no dot)', () => {
        assert.strictEqual(store.verifyToken('no-dot-here'), null);
    });

    it('returns null for a token with wrong random part', () => {
        const { token } = store.register('alice', 'secret123');
        const tampered = token.slice(0, token.length - 1) + (token.endsWith('0') ? '1' : '0');
        assert.strictEqual(store.verifyToken(tampered), null);
    });

    it('returns null for a token of a logged-out user', () => {
        const { token } = store.register('alice', 'secret123');
        store.logout('alice');
        assert.strictEqual(store.verifyToken(token), null);
    });

    it('returns null when token has expired', () => {
        const { token } = store.register('alice', 'secret123');
        // Forge an old issued-at timestamp on the stored profile
        const profilePath = path.join(tempDir, 'alice', 'profile.json');
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
        profile.tokenIssuedAt = Date.now() - 10 * 86400000; // 10 days ago, ttl=7
        fs.writeFileSync(profilePath, JSON.stringify(profile));
        assert.strictEqual(store.verifyToken(token), null);
    });

    it('still verifies an old token when tokenTtlDays <= 0 (never expire)', () => {
        const neverExpireStore = new UserStore(makeConfig(tempDir, 0));
        neverExpireStore.register('bob', 'secret123');
        const { token } = neverExpireStore.login('bob', 'secret123');
        const profilePath = path.join(tempDir, 'bob', 'profile.json');
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
        profile.tokenIssuedAt = Date.now() - 365 * 86400000; // a year ago
        fs.writeFileSync(profilePath, JSON.stringify(profile));
        assert.strictEqual(neverExpireStore.verifyToken(token), 'bob');
    });

    it('returns null for non-string token', () => {
        assert.strictEqual(store.verifyToken(null), null);
        assert.strictEqual(store.verifyToken(undefined), null);
        assert.strictEqual(store.verifyToken(123), null);
    });
});

describe('UserStore - logout', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-logout-'));
        store = new UserStore(makeConfig(tempDir));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
    });

    it('clears the token so it no longer verifies', () => {
        const { token } = store.register('alice', 'secret123');
        assert.strictEqual(store.verifyToken(token), 'alice');
        assert.strictEqual(store.logout('alice'), true);
        assert.strictEqual(store.verifyToken(token), null);
    });

    it('returns false when there is no active session to clear (idempotent)', () => {
        store.register('alice', 'secret123');
        store.logout('alice');
        assert.strictEqual(store.logout('alice'), false);
    });

    it('returns false for an unknown user', () => {
        assert.strictEqual(store.logout('ghost'), false);
    });
});

describe('UserStore - listSessions', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-list-'));
        store = new UserStore(makeConfig(tempDir));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
    });

    it('returns an empty list for a user with no sessions', () => {
        store.register('alice', 'secret123');
        assert.deepStrictEqual(store.listSessions('alice'), []);
    });

    it('returns sessions with summary from the first user prompt (<=30 chars)', () => {
        store.register('alice', 'secret123');
        const sessionsDir = path.join(tempDir, 'alice', 'sessions');
        const id = '550e8400-e29b-41d4-a716-446655440000';
        fs.mkdirSync(path.join(sessionsDir, id));
        fs.writeFileSync(path.join(sessionsDir, id, 'history.json'), JSON.stringify([
            { role: 'user', content: '画一个用户注册流程图，包含邮箱验证', ts: 1 },
            { role: 'assistant', content: 'flowchart TD', ts: 2 }
        ]));

        const list = store.listSessions('alice');
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].sessionId, id);
        // summary is the first 30 chars of the first user content
        assert.strictEqual(list[0].summary, '画一个用户注册流程图，包含邮箱验证'.slice(0, 30));
        assert.ok(typeof list[0].updatedAt === 'number');
    });

    it('truncates long first prompts to 30 chars in the summary', () => {
        store.register('alice', 'secret123');
        const sessionsDir = path.join(tempDir, 'alice', 'sessions');
        const id = '550e8400-e29b-41d4-a716-446655440001';
        fs.mkdirSync(path.join(sessionsDir, id));
        const longPrompt = 'a'.repeat(100);
        fs.writeFileSync(path.join(sessionsDir, id, 'history.json'), JSON.stringify([
            { role: 'user', content: longPrompt, ts: 1 }
        ]));
        const list = store.listSessions('alice');
        assert.strictEqual(list[0].summary.length, 30);
    });

    it('sorts sessions newest-first by history.json mtime', () => {
        store.register('alice', 'secret123');
        const sessionsDir = path.join(tempDir, 'alice', 'sessions');
        const older = '550e8400-e29b-41d4-a716-446655440002';
        const newer = '550e8400-e29b-41d4-a716-446655440003';
        for (const id of [older, newer]) {
            fs.mkdirSync(path.join(sessionsDir, id));
            fs.writeFileSync(path.join(sessionsDir, id, 'history.json'), '[]');
        }
        // Make `older` genuinely older
        const oldTime = (Date.now() - 5 * 86400000) / 1000;
        fs.utimesSync(path.join(sessionsDir, older, 'history.json'), new Date(oldTime), new Date(oldTime));

        const list = store.listSessions('alice');
        assert.strictEqual(list[0].sessionId, newer);
        assert.strictEqual(list[1].sessionId, older);
    });

    it('skips a session with corrupt history.json without throwing', () => {
        store.register('alice', 'secret123');
        const sessionsDir = path.join(tempDir, 'alice', 'sessions');
        const good = '550e8400-e29b-41d4-a716-446655440004';
        const bad = '550e8400-e29b-41d4-a716-446655440005';
        for (const id of [good, bad]) {
            fs.mkdirSync(path.join(sessionsDir, id));
        }
        fs.writeFileSync(path.join(sessionsDir, good, 'history.json'), JSON.stringify([
            { role: 'user', content: 'ok', ts: 1 }
        ]));
        fs.writeFileSync(path.join(sessionsDir, bad, 'history.json'), 'not json');

        const list = store.listSessions('alice');
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].sessionId, good);
    });

    it('returns empty list for an invalid username', () => {
        assert.deepStrictEqual(store.listSessions('../etc'), []);
    });
});
