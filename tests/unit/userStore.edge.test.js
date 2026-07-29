'use strict';

// Edge-case supplements for UserStore (R1 user-auth layer).
// The developer's userStore.test.js covers happy paths and the explicitly
// required branches. This file targets boundaries those tests miss:
//   - non-string inputs to register/login (defensive type space)
//   - token shape boundaries (empty user/random parts, corrupt profile)
//   - listSessions skip conditions (missing file, non-array, non-string content)
//   - security assertions on stored lengths (token/salt/hash bit sizes)
// Tests here intentionally avoid overlapping with existing cases.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { UserStore } = require('../../src/services/userStore');

function makeConfig(tempDir, tokenTtlDays = 7) {
    return {
        users: { dir: tempDir },
        auth: { tokenTtlDays }
    };
}

describe('UserStore edge - register input boundaries', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-reg-edge-'));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
        store = new UserStore(makeConfig(tempDir));
    });

    it('accepts the minimum username length (3 chars) through register()', () => {
        const r = store.register('abc', 'secret123');
        assert.ok(!r.error, '3-char username should register');
        assert.strictEqual(r.username, 'abc');
    });

    it('accepts the maximum username length (32 chars) through register()', () => {
        const name = 'A'.repeat(32);
        const r = store.register(name, 'secret123');
        assert.ok(!r.error, '32-char username should register');
    });

    it('accepts the minimum password length (exactly 6 chars)', () => {
        // MIN_PASSWORD_LENGTH = 6, so 6 chars is the inclusive boundary.
        const r = store.register('minpw', 'abcdef');
        assert.ok(!r.error, '6-char password should register');
    });

    it('rejects an empty-string password', () => {
        assert.strictEqual(store.register('emptypw', '').error, 'invalid_password');
    });

    it('rejects non-string username (null/undefined/number/object)', () => {
        assert.strictEqual(store.register(null, 'secret123').error, 'invalid_username');
        assert.strictEqual(store.register(undefined, 'secret123').error, 'invalid_username');
        assert.strictEqual(store.register(123, 'secret123').error, 'invalid_username');
        assert.strictEqual(store.register({ a: 1 }, 'secret123').error, 'invalid_username');
    });

    it('rejects non-string password (null/undefined/number/object)', () => {
        assert.strictEqual(store.register('alice', null).error, 'invalid_password');
        assert.strictEqual(store.register('alice', undefined).error, 'invalid_password');
        assert.strictEqual(store.register('alice', 123456).error, 'invalid_password');
        assert.strictEqual(store.register('alice', { a: 1 }).error, 'invalid_password');
    });

    it('a failed duplicate register does not overwrite the original credentials', () => {
        const r1 = store.register('alice', 'pw-one');
        assert.ok(!r1.error);
        // Second register with a different password must be rejected...
        assert.strictEqual(store.register('alice', 'pw-two').error, 'user_exists');
        // ...and the original password must still work while the new one must not.
        assert.ok(!store.login('alice', 'pw-one').error, 'original password must remain valid');
        assert.strictEqual(store.login('alice', 'pw-two').error, 'invalid_credentials');
    });
});

describe('UserStore edge - login input handling', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-login-edge-'));
        store = new UserStore(makeConfig(tempDir));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
    });

    it('invalidates the register-issued token after the first login (rotation across register->login)', () => {
        // The existing suite only proves login-vs-login rotation. This pins
        // that the token handed out by register() itself is killed by login().
        const t0 = store.register('alice', 'secret123').token;
        assert.strictEqual(store.verifyToken(t0), 'alice');
        const t1 = store.login('alice', 'secret123').token;
        assert.notStrictEqual(t0, t1);
        assert.strictEqual(store.verifyToken(t0), null, 'register token must die after login');
        assert.strictEqual(store.verifyToken(t1), 'alice');
    });

    it('updates lastLoginAt on login', async () => {
        store.register('alice', 'secret123');
        const regProfile = JSON.parse(fs.readFileSync(path.join(tempDir, 'alice', 'profile.json'), 'utf-8'));
        // Sleep past Date.now()'s 1ms resolution so the advance is observable.
        await new Promise(r => setTimeout(r, 5));
        store.login('alice', 'secret123');
        const loginProfile = JSON.parse(fs.readFileSync(path.join(tempDir, 'alice', 'profile.json'), 'utf-8'));
        assert.ok(typeof loginProfile.lastLoginAt === 'number');
        assert.ok(loginProfile.lastLoginAt > regProfile.lastLoginAt, 'lastLoginAt should advance');
    });

    it('returns invalid_credentials when password is non-string and the user exists', () => {
        // login() guards `typeof password !== 'string'` (symmetric with
        // register), so a non-string password for an existing user is rejected
        // before scryptSync, returning invalid_credentials rather than throwing
        // a TypeError that would surface as a 500.
        store.register('alice', 'secret123');
        assert.strictEqual(store.login('alice', null).error, 'invalid_credentials');
        assert.strictEqual(store.login('alice', undefined).error, 'invalid_credentials');
        assert.strictEqual(store.login('alice', 123456).error, 'invalid_credentials');
    });
});

describe('UserStore edge - verifyToken shape boundaries', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-verify-edge-'));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
        store = new UserStore(makeConfig(tempDir, 7));
    });

    it('returns null for a token whose username part does not exist on disk', () => {
        // Valid username shape + valid hex, but no profile.json for this user.
        assert.strictEqual(store.verifyToken('ghosts.' + 'a'.repeat(64)), null);
    });

    it('returns null when the username part is empty (".<hex>")', () => {
        assert.strictEqual(store.verifyToken('.' + 'a'.repeat(64)), null);
    });

    it('returns null when the random part is empty ("<user>.")', () => {
        store.register('alice', 'secret123');
        assert.strictEqual(store.verifyToken('alice.'), null);
    });

    it('returns null when the random part is shorter than the stored token', () => {
        const { token } = store.register('alice', 'secret123');
        const shortHex = token.split('.')[1].slice(0, 10);
        assert.strictEqual(store.verifyToken('alice.' + shortHex), null);
    });

    it('returns null when profile.json is corrupt (unparseable)', () => {
        const { token } = store.register('alice', 'secret123');
        fs.writeFileSync(path.join(tempDir, 'alice', 'profile.json'), 'not json');
        assert.strictEqual(store.verifyToken(token), null);
    });
});

describe('UserStore edge - logout input handling', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-logout-edge-'));
        store = new UserStore(makeConfig(tempDir));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
    });

    it('returns false for an invalid username format (not just unknown valid-format users)', () => {
        // The existing suite only checks a valid-format unknown user ('ghost').
        assert.strictEqual(store.logout('../etc'), false);
        assert.strictEqual(store.logout('ab'), false);
        assert.strictEqual(store.logout(null), false);
        assert.strictEqual(store.logout(undefined), false);
    });

    it('returns false (does not throw) when profile.json is corrupt', () => {
        store.register('alice', 'secret123');
        fs.writeFileSync(path.join(tempDir, 'alice', 'profile.json'), 'not json');
        assert.strictEqual(store.logout('alice'), false);
    });
});

describe('UserStore edge - listSessions skip conditions', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-list-edge-'));
        store = new UserStore(makeConfig(tempDir));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
    });

    function seedSession(username, id, history) {
        const dir = path.join(tempDir, username, 'sessions', id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history));
    }

    it('skips a session folder that has no history.json', () => {
        store.register('alice', 'secret123');
        const good = '550e8400-e29b-41d4-a716-446655440000';
        seedSession('alice', good, [{ role: 'user', content: 'ok', ts: 1 }]);
        fs.mkdirSync(path.join(tempDir, 'alice', 'sessions', 'no-history-id'));
        const list = store.listSessions('alice');
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].sessionId, good);
    });

    it('skips a session whose history.json is valid JSON but not an array', () => {
        store.register('alice', 'secret123');
        const good = '550e8400-e29b-41d4-a716-446655440000';
        seedSession('alice', good, [{ role: 'user', content: 'ok', ts: 1 }]);
        const badDir = path.join(tempDir, 'alice', 'sessions', 'not-array-id');
        fs.mkdirSync(badDir);
        fs.writeFileSync(path.join(badDir, 'history.json'), '{"not":"an array"}');
        const list = store.listSessions('alice');
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].sessionId, good);
    });

    it('returns an empty summary when no user message exists (assistant-only history)', () => {
        store.register('alice', 'secret123');
        const id = '550e8400-e29b-41d4-a716-446655440000';
        seedSession('alice', id, [{ role: 'assistant', content: 'flowchart TD', ts: 1 }]);
        const list = store.listSessions('alice');
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].summary, '');
    });

    it('ignores user entries whose content is not a string', () => {
        store.register('alice', 'secret123');
        const id = '550e8400-e29b-41d4-a716-446655440000';
        seedSession('alice', id, [
            { role: 'user', content: 12345, ts: 1 },
            { role: 'assistant', content: 'flowchart TD', ts: 2 }
        ]);
        const list = store.listSessions('alice');
        assert.strictEqual(list[0].summary, '');
    });

    it('skips regular files placed directly in the sessions dir', () => {
        store.register('alice', 'secret123');
        const good = '550e8400-e29b-41d4-a716-446655440000';
        seedSession('alice', good, [{ role: 'user', content: 'ok', ts: 1 }]);
        fs.writeFileSync(path.join(tempDir, 'alice', 'sessions', 'stray.txt'), 'x');
        const list = store.listSessions('alice');
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].sessionId, good);
    });

    it('returns an empty list for a valid-format username that never registered', () => {
        // sessions dir does not exist -> existsSync false -> []
        assert.deepStrictEqual(store.listSessions('ghosts'), []);
    });
});

describe('UserStore edge - security assertions on stored artifacts', () => {
    let tempDir;
    let store;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-sec-'));
        store = new UserStore(makeConfig(tempDir));
    });
    after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    beforeEach(() => {
        for (const e of fs.readdirSync(tempDir, { withFileTypes: true })) {
            fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
        }
    });

    it('issues a 256-bit token (64 hex chars) scoped to the username', () => {
        const { token } = store.register('alice', 'secret123');
        const [user, hex] = token.split('.');
        assert.strictEqual(user, 'alice');
        assert.strictEqual(hex.length, 64, 'token random part must be 64 hex chars (32 bytes)');
        assert.match(hex, /^[0-9a-f]{64}$/, 'token random part must be lowercase hex');
    });

    it('stores a 16-byte salt (32 hex) and 64-byte hash (128 hex)', () => {
        store.register('alice', 'secret123');
        const profile = JSON.parse(fs.readFileSync(path.join(tempDir, 'alice', 'profile.json'), 'utf-8'));
        assert.match(profile.salt, /^[0-9a-f]{32}$/);
        assert.match(profile.passwordHash, /^[0-9a-f]{128}$/);
    });

    it('produces different hashes and salts for two users with the same password', () => {
        store.register('alice', 'same-password');
        store.register('bob', 'same-password');
        const pa = JSON.parse(fs.readFileSync(path.join(tempDir, 'alice', 'profile.json'), 'utf-8'));
        const pb = JSON.parse(fs.readFileSync(path.join(tempDir, 'bob', 'profile.json'), 'utf-8'));
        assert.notStrictEqual(pa.salt, pb.salt, 'salts must differ');
        assert.notStrictEqual(pa.passwordHash, pb.passwordHash, 'hashes must differ');
    });

    it('never persists the plaintext password nor the user-scoped token string on disk', () => {
        store.register('alice', 'never-store-me');
        const raw = fs.readFileSync(path.join(tempDir, 'alice', 'profile.json'), 'utf-8');
        assert.ok(!raw.includes('never-store-me'), 'plaintext password must not appear anywhere in the file');
        const profile = JSON.parse(raw);
        // profile.token holds the hex-only random part; the full "alice.hex"
        //下发串 must not be stored.
        assert.ok(!profile.token.includes('.'), 'only the random part is stored, not the user-scoped token');
        assert.strictEqual(profile.password, undefined, 'no plaintext password field');
    });
});

// cleanupExpiredUserSessions 已移除：run/users/ 下的用户数据绝不自动清理。
