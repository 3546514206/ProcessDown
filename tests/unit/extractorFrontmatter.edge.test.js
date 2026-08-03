'use strict';

/**
 * Tests for stripFrontmatter + the extractMermaidCode/autoFixMermaidCode
 * regression introduced when checkSession started re-purifying stored
 * assistant content.
 *
 * Bug context: historical sessions stored assistant content under the
 * purification logic that was current at write time. When extractor was
 * later enhanced (fixGitGraphOrientation, frontmatter stripping), old
 * history retained incompatible syntax (gitGraph LR:, --- frontmatter ---)
 * that made the frontend mermaid.render throw on restore. checkSession now
 * re-runs extract+autoFix on the last assistant content before returning it.
 *
 * This file covers:
 *   1. stripFrontmatter pure-function unit tests (normal / boundary / exception)
 *   2. extractMermaidCode + autoFixMermaidCode integration (regression for the
 *      gitGraph-orientation and frontmatter paths that checkSession depends on)
 *
 * stripFrontmatter is exported alongside the other internal helpers
 * (fixGitGraphOrientation etc.) so its falsy/non-string guards can be tested
 * directly -- extractMermaidCode short-circuits on falsy input before
 * stripFrontmatter is ever reached, so those branches are only coverable by
 * calling the function itself.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
    stripFrontmatter,
    extractMermaidCode,
    autoFixMermaidCode
} = require('../../src/services/extractor');

describe('stripFrontmatter - pure-function unit tests', () => {

    describe('normal cases', () => {
        it('strips a frontmatter block and keeps the gitGraph body', () => {
            const input = '---\nconfig:\n  theme: base\n---\ngitGraph\n    commit id: "init"';
            assert.strictEqual(
                stripFrontmatter(input),
                'gitGraph\n    commit id: "init"'
            );
        });

        it('strips frontmatter with multi-line YAML config', () => {
            const input = [
                '---',
                'title: My Diagram',
                'config:',
                '  theme: base',
                '  look: handDrawn',
                '---',
                'flowchart TD',
                '    A-->B'
            ].join('\n');
            assert.strictEqual(
                stripFrontmatter(input),
                'flowchart TD\n    A-->B'
            );
        });

        it('strips frontmatter followed by a sequenceDiagram', () => {
            const input = '---\nconfig\n---\nsequenceDiagram\nA->>B: hello';
            assert.strictEqual(
                stripFrontmatter(input),
                'sequenceDiagram\nA->>B: hello'
            );
        });
    });

    describe('boundary cases', () => {
        it('leaves pure mermaid (no frontmatter) unchanged', () => {
            const input = 'gitGraph\n    commit id: "init"';
            assert.strictEqual(stripFrontmatter(input), input);
        });

        it('leaves a flowchart with no frontmatter unchanged', () => {
            const input = 'flowchart TD\n    A-->B\n    B-->C';
            assert.strictEqual(stripFrontmatter(input), input);
        });

        it('returns empty string when frontmatter has no body after it', () => {
            // After stripping the ---/config/--- block, nothing remains.
            // .trim() collapses the leftover whitespace to "".
            assert.strictEqual(stripFrontmatter('---\nconfig\n---\n'), '');
        });

        it('strips only the FIRST frontmatter block when multiple --- blocks exist', () => {
            // Non-greedy [\\s\\S]*? matches up to the first closing --- line,
            // so a second ---/.../--- block survives. This documents the
            // single-pass behavior: stripFrontmatter is called once per
            // extractMermaidCode return point, it does not loop.
            const input = '---\na\n---\n---\nb\n---\ngitGraph\n    commit';
            assert.strictEqual(
                stripFrontmatter(input),
                '---\nb\n---\ngitGraph\n    commit'
            );
        });

        it('does NOT strip --- appearing in a sequenceDiagram body (not at start)', () => {
            // sequenceDiagram uses --- as a separator between interactions in
            // some dialects; the ^ anchor ensures only a leading --- block is
            // stripped, so body --- is safe.
            const input = 'sequenceDiagram\nA->>B: hello\n---\nB->>A: hi';
            assert.strictEqual(stripFrontmatter(input), input);
        });

        it('does NOT strip --- inside a gitGraph commit message', () => {
            const input = 'gitGraph\n    commit id: "feat: --- sep"\n    commit';
            assert.strictEqual(stripFrontmatter(input), input);
        });

        it('handles CRLF line endings', () => {
            const input = '---\r\nconfig\r\n---\r\ngitGraph\r\n    commit';
            // frontmatter stripped; remaining body keeps its CRLF endings
            assert.strictEqual(
                stripFrontmatter(input),
                'gitGraph\r\n    commit'
            );
        });

        it('tolerates trailing whitespace on the --- delimiter lines', () => {
            // [ \\t]* in the regex absorbs trailing spaces/tabs on the --- lines.
            const input = '---   \nconfig\n---   \ngitGraph\n    commit';
            assert.strictEqual(
                stripFrontmatter(input),
                'gitGraph\n    commit'
            );
        });
    });

    describe('exception / falsy cases', () => {
        it('returns empty string unchanged', () => {
            assert.strictEqual(stripFrontmatter(''), '');
        });

        it('returns null unchanged (falsy guard)', () => {
            assert.strictEqual(stripFrontmatter(null), null);
        });

        it('returns undefined unchanged (falsy guard)', () => {
            assert.strictEqual(stripFrontmatter(undefined), undefined);
        });

        it('returns false unchanged (falsy non-string guard)', () => {
            // !code catches all falsy values; false is returned as-is rather
            // than being coerced. Documents the defensive guard's reach.
            assert.strictEqual(stripFrontmatter(false), false);
        });

        it('returns 0 unchanged (falsy non-string guard)', () => {
            assert.strictEqual(stripFrontmatter(0), 0);
        });

        it('throws TypeError for a truthy non-string (number)', () => {
            // The falsy guard does not cover truthy non-strings; .replace is
            // called on a Number and throws. This is accepted because
            // extractMermaidCode only ever passes strings (its own callers
            // feed it string LLM output / history content). Recorded here so
            // a future widening of the guard is a conscious decision.
            assert.throws(
                () => stripFrontmatter(123),
                TypeError
            );
        });

        it('throws TypeError for a truthy non-string (object)', () => {
            assert.throws(
                () => stripFrontmatter({}),
                TypeError
            );
        });
    });
});

describe('extractMermaidCode + autoFixMermaidCode - integration regression', () => {
    // These mirror the purification that checkSession now applies to stored
    // assistant content. Each case feeds a raw assistant-style string through
    // the full extract -> autoFix pipeline and asserts the renderable output.

    it('regression: gitGraph LR: header -> gitGraph (orientation + colon stripped)', () => {
        // The bug report's canonical case: old history stored `gitGraph LR:`
        // which the vendored parser rejects. fixGitGraphOrientation must
        // strip the LR token AND the trailing colon, leaving bare `gitGraph`
        // (vendored only accepts `gitGraph` or `gitGraph: { ... }`).
        const input = 'gitGraph LR:\n    commit id: "init"';
        const extracted = extractMermaidCode(input);
        assert.strictEqual(extracted, 'gitGraph LR:\n    commit id: "init"');
        const fixed = autoFixMermaidCode(extracted).code;
        assert.strictEqual(fixed, 'gitGraph\n    commit id: "init"');
    });

    it('regression: frontmatter + gitGraph -> frontmatter stripped', () => {
        const input = '---\nconfig:\n  theme: base\n---\ngitGraph\n    commit id: "init"';
        const extracted = extractMermaidCode(input);
        assert.strictEqual(extracted, 'gitGraph\n    commit id: "init"');
        const fixed = autoFixMermaidCode(extracted).code;
        // No further fixes needed; output equals extracted.
        assert.strictEqual(fixed, 'gitGraph\n    commit id: "init"');
    });

    it('regression: frontmatter + gitGraph LR -> both issues fixed in one pass', () => {
        // extract strips frontmatter first, then autoFix strips orientation.
        const input = '---\nconfig\n---\ngitGraph LR\n    commit';
        const extracted = extractMermaidCode(input);
        assert.strictEqual(extracted, 'gitGraph LR\n    commit');
        const fixed = autoFixMermaidCode(extracted).code;
        assert.strictEqual(fixed, 'gitGraph\n    commit');
    });

    it('idempotent: already-purified code is unchanged on re-run', () => {
        // checkSession must be safe to call repeatedly on already-clean
        // history -- running extract+autoFix twice must not drift.
        const clean = 'gitGraph\n    commit id: "init"';
        const extracted = extractMermaidCode(clean);
        assert.strictEqual(extracted, clean);
        const fixed = autoFixMermaidCode(extracted).code;
        assert.strictEqual(fixed, clean);
    });

    it('idempotent: already-fixed gitGraph is unchanged on re-run', () => {
        const clean = 'gitGraph\n    commit';
        const extracted = extractMermaidCode(clean);
        assert.strictEqual(extracted, clean);
        const fixed = autoFixMermaidCode(extracted).code;
        assert.strictEqual(fixed, clean);
    });

    it('non-mermaid content -> extract returns null (checkSession fallback path)', () => {
        // When extract returns null, checkSession keeps the original content.
        // This asserts the null branch that checkSession's fallback depends on.
        assert.strictEqual(extractMermaidCode('hello world this is just text'), null);
        assert.strictEqual(extractMermaidCode(''), null);
        assert.strictEqual(extractMermaidCode(null), null);
    });

    it('mermaid code block with frontmatter -> frontmatter stripped', () => {
        // Covers the ```mermaid ... ``` return point (the first stripFrontmatter
        // integration site in extractMermaidCode).
        const input = '```mermaid\n---\nconfig\n---\ngitGraph\n    commit\n```';
        const extracted = extractMermaidCode(input);
        assert.strictEqual(extracted, 'gitGraph\n    commit');
    });

    it('untagged code block with frontmatter -> frontmatter stripped', () => {
        // Covers the bare ``` ... ``` return point (second integration site).
        const input = '```\n---\nconfig\n---\nflowchart TD\n    A-->B\n```';
        const extracted = extractMermaidCode(input);
        assert.strictEqual(extracted, 'flowchart TD\n    A-->B');
    });
});
