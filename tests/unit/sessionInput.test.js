'use strict';

// Frontend session-input logic tests.
//
// Why parse source instead of require('../../public/js/app.js')?
// app.js touches `document`/`localStorage` at module top level (elements
// object, state.theme init), so requiring it under node:test throws
// ReferenceError before any logic runs. The developer chose not to extract a
// pure module this round, so we pull the two pieces that ARE pure -- the
// SESSION_ID_PATTERN regex and the session-input keydown handler -- straight
// out of the app.js source text and exercise them. This avoids copying the
// regex by hand: if the developer edits it in app.js, these tests
// automatically see the new value (no source-drift risk). The backend
// SessionStore.isValidId is required separately and used as a cross-check
// oracle: the frontend pattern is documented as a mirror of the server-side
// UUID_PATTERN (src/services/sessionStore.js), so the two must agree.
//
// What is NOT covered here (needs DOM/clipboard/visual -> manual checklist):
//   - updateSessionDisplay writing state.sessionId into the input value
//   - copySessionId clipboard write + toast
//   - restoreSession fetch + toast + mermaidRender re-render
//   - isGenerating guard toast (only statically asserted below)
//   - layout: single box above the textarea (visual)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, '..', '..', 'public', 'js', 'app.js');
const SRC = fs.readFileSync(APP_JS, 'utf-8');

// --- Extract SESSION_ID_PATTERN from app.js source -------------------------
const regexMatch = SRC.match(/const\s+SESSION_ID_PATTERN\s*=\s*(\/.+?\/[gimsuy]*);/);
assert.ok(regexMatch, 'SESSION_ID_PATTERN not found in app.js -- extraction regex drifted');
// Materialize the literal. Source is our own repo, so Function construction
// is acceptable here; do NOT use this pattern on untrusted input.
const SESSION_ID_PATTERN = new Function('return ' + regexMatch[1])();

// --- Extract the session-input keydown handler body ------------------------
const handlerMatch = SRC.match(
    /elements\.sessionInput\.addEventListener\('keydown',\s*\(([^)]+)\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\);/
);
assert.ok(handlerMatch, 'sessionInput keydown handler not found -- extraction regex drifted');
const HANDLER_PARAM = handlerMatch[1];
const HANDLER_BODY = handlerMatch[2];

// --- Backend oracle: the frontend pattern mirrors this --------------------
const { SessionStore } = require('../../src/services/sessionStore');
const store = new SessionStore({
    session: { dir: '/tmp/pd-sessionInput-oracle-unused', maxHistory: 20, ttlDays: 7 }
});
const backendIsValidId = (s) => store.isValidId(s);

const VALID = '550e8400-e29b-41d4-a716-446655440000';

describe('Frontend SESSION_ID_PATTERN (extracted from app.js source)', () => {
    describe('normal cases', () => {
        it('accepts a lowercase UUID', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test(VALID), true);
        });
        it('accepts an uppercase UUID (case-insensitive flag)', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test(VALID.toUpperCase()), true);
        });
        it('accepts a mixed-case UUID', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test('550e8400-E29B-41d4-a716-446655440000'), true);
        });
    });

    describe('boundary cases', () => {
        it('rejects a UUID with an internal tab', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test(VALID.slice(0, 8) + '\t' + VALID.slice(9)), false);
        });
        it('rejects a UUID with a trailing newline', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test(VALID + '\n'), false);
        });
        it('rejects a UUID missing one hex digit (31 chars)', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test('550e8400-e29b-41d4-a716-44665544000'), false);
        });
        it('rejects a UUID with one extra hex digit (33 chars)', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test(VALID + '0'), false);
        });
        it('rejects a UUID with no hyphens', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test('550e8400e29b41d4a716446655440000'), false);
        });
        it('rejects a UUID with hyphens in the wrong grouping', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test('550e-8400-e29b-41d4-a716446655440000'), false);
        });
        it('rejects correct-shape string with non-hex chars (g/z)', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test('550e8400-e29b-41d4-a716-44665544000g'), false);
            assert.strictEqual(SESSION_ID_PATTERN.test('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'), false);
        });
    });

    describe('exception cases', () => {
        it('rejects empty string', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test(''), false);
        });
        it('rejects path-traversal attempt', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test('../../etc/passwd'), false);
        });
        it('rejects a string with slashes', () => {
            assert.strictEqual(SESSION_ID_PATTERN.test('550e8400/e29b/41d4/a716/446655440000'), false);
        });
        it('rejects non-string inputs the way .test() would (coerced)', () => {
            // RegExp.test coerces its argument to String. The frontend guards
            // this via .value.trim() always yielding a string, but pin the
            // regex behavior anyway: e.g. undefined -> "undefined" must fail.
            assert.strictEqual(SESSION_ID_PATTERN.test(undefined), false);
            assert.strictEqual(SESSION_ID_PATTERN.test(null), false);
            assert.strictEqual(SESSION_ID_PATTERN.test(123), false);
        });
    });

    describe('cross-check: agrees with backend SessionStore.isValidId', () => {
        // The frontend pattern is documented as a mirror of the server-side
        // UUID_PATTERN. They must agree across a corpus. NOTE: isValidId also
        // type-guards (typeof === 'string'); the regex itself does not, so we
        // feed strings here and rely on the frontend's .value.trim() for the
        // type guard in practice.
        const corpus = [
            VALID,
            VALID.toUpperCase(),
            '550e8400-e29b-41d4-a716-44665544000g',
            '550e8400e29b41d4a716446655440000',
            '550e-8400-e29b-41d4-a716446655440000',
            'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
            '../../etc/passwd',
            '',
            '550e8400/e29b/41d4/a716/446655440000',
            'a'.repeat(1000),
        ];
        for (const c of corpus) {
            it(`agrees on ${JSON.stringify(c).slice(0, 40)}`, () => {
                assert.strictEqual(
                    SESSION_ID_PATTERN.test(c),
                    backendIsValidId(c),
                    `frontend regex and backend isValidId disagree on ${JSON.stringify(c)}`
                );
            });
        }
    });
});

describe('restoreSession trim-then-validate pipeline (static + behavioral)', () => {
    // restoreSession does: const input = elements.sessionInput.value.trim();
    // then SESSION_ID_PATTERN.test(input). We cannot execute restoreSession
    // (DOM), so we (a) statically assert the source orders trim before test,
    // and (b) behaviorally exercise the replicated pipeline with the extracted
    // regex to pin the intended semantics for whitespace-padded input.
    it('source: restoreSession trims .value before testing SESSION_ID_PATTERN', () => {
        const trimIdx = SRC.indexOf('.value.trim()');
        const testIdx = SRC.indexOf('SESSION_ID_PATTERN.test(input)');
        assert.ok(trimIdx !== -1, '.value.trim() call not found in app.js');
        assert.ok(testIdx !== -1, 'SESSION_ID_PATTERN.test(input) call not found in app.js');
        assert.ok(trimIdx < testIdx, 'trim must come before the regex test in restoreSession');
    });

    it('pipeline accepts a UUID with surrounding whitespace after trim', () => {
        const pipeline = (raw) => SESSION_ID_PATTERN.test(raw.trim());
        assert.strictEqual(pipeline('  ' + VALID + '  '), true);
        assert.strictEqual(pipeline('\t' + VALID + '\n'), true);
    });

    it('pipeline rejects whitespace-only input (trim-empty) instead of throwing', () => {
        const pipeline = (raw) => SESSION_ID_PATTERN.test(raw.trim());
        assert.strictEqual(pipeline('    '), false);
        assert.strictEqual(pipeline('\t\t'), false);
    });
});

describe('session-input keydown handler (E3 fixed: Enter vs Ctrl/Shift/Alt/Meta+Enter)', () => {
    // The handler is a one-liner inside an addEventListener closure. We
    // replicate its decision predicate from the extracted body to make the
    // behavior explicit and testable. The predicate matches the CURRENT
    // (post-E3-fix) implementation character-for-character: plain Enter only,
    // every modifier excluded.
    const currentPredicate = (e) => e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;

    it('handler param is "e" and body was extracted (extraction sanity)', () => {
        assert.strictEqual(HANDLER_PARAM, 'e');
        assert.ok(HANDLER_BODY.includes("e.key === 'Enter'"), 'body should test e.key === Enter');
        assert.ok(HANDLER_BODY.includes('!e.ctrlKey'), 'body should guard !e.ctrlKey');
    });

    it('plain Enter triggers restore', () => {
        assert.strictEqual(currentPredicate({ key: 'Enter', ctrlKey: false }), true);
    });

    it('Ctrl+Enter does NOT trigger restore (bubbles to document -> generate)', () => {
        assert.strictEqual(currentPredicate({ key: 'Enter', ctrlKey: true }), false);
    });

    // E3 fixed: the predicate excludes every modifier. Shift/Alt/Meta+Enter
    // must NOT fire restore (a user hitting Shift+Enter -- a common "newline"
    // reflex -- would otherwise trigger a network restore by accident).
    const MODIFIERS = ['shiftKey', 'altKey', 'metaKey'];
    for (const mod of MODIFIERS) {
        it(`${mod}+Enter does NOT trigger restore (E3 fix)`, () => {
            const e = { key: 'Enter', ctrlKey: false, [mod]: true };
            assert.strictEqual(currentPredicate(e), false,
                `${mod}+Enter must not fire restore after the E3 fix`);
        });
    }

    it('source body contains all four modifier guards (regression sentinel for E3)', () => {
        // Guards against E3 regressing: if any modifier guard is removed from
        // app.js, this fails and the corresponding ${mod}+Enter case above
        // should also start failing.
        assert.ok(HANDLER_BODY.includes('!e.ctrlKey'), 'body must guard !e.ctrlKey');
        assert.ok(HANDLER_BODY.includes('!e.shiftKey'), 'body must guard !e.shiftKey');
        assert.ok(HANDLER_BODY.includes('!e.altKey'), 'body must guard !e.altKey');
        assert.ok(HANDLER_BODY.includes('!e.metaKey'), 'body must guard !e.metaKey');
    });

    it('non-Enter keys do not trigger restore', () => {
        assert.strictEqual(currentPredicate({ key: 'a', ctrlKey: false }), false);
        assert.strictEqual(currentPredicate({ key: 'Enter', ctrlKey: false }), true);
    });
});

describe('restoreSession guards (static source evidence)', () => {
    // restoreSession cannot be executed under node:test (DOM/fetch), so we
    // only statically confirm the two early-returns exist in the right order.
    // Behavioral verification (toasts, no fetch) is in the manual checklist.
    it('checks state.isGenerating before any fetch (D1 guard present)', () => {
        const genIdx = SRC.indexOf('if (state.isGenerating)');
        const fetchIdx = SRC.indexOf("fetch('/api/session/check'");
        assert.ok(genIdx !== -1, 'isGenerating guard not found');
        assert.ok(fetchIdx !== -1, 'session/check fetch not found');
        assert.ok(genIdx < fetchIdx, 'isGenerating guard must precede the fetch call');
    });

    it('empty-input guard precedes the regex test', () => {
        const emptyIdx = SRC.indexOf("if (!input)");
        const testIdx = SRC.indexOf('SESSION_ID_PATTERN.test(input)');
        assert.ok(emptyIdx !== -1, 'empty-input guard not found');
        assert.ok(emptyIdx < testIdx, 'empty guard must precede regex test');
    });
});
