/**
 * Tests for fixGitGraphCherryPick — strips Mermaid v10+ `&<branch>` cherry-pick
 * suffix from gitGraph commit/merge lines so v9-renderable code survives.
 *
 * Regression target: gitGraph output where LLM emits `merge feature/auth ... &feature/auth`
 * or `commit id: "x" &feature/auth`, both of which v9 mermaid rejects.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
    fixGitGraphCherryPick,
    autoFixMermaidCode
} = require('../../src/services/extractor');

describe('fixGitGraphCherryPick — pure-function unit tests', () => {
    it('strips redundant &<branch> from a merge line', () => {
        const input = 'gitGraph\n    merge feature/user-auth type: SQUASH tag: "v1.0.0-alpha" msg: "merge: 用户认证模块合入主干" &feature/user-auth';
        const out = fixGitGraphCherryPick(input);
        assert.strictEqual(out.fixed, true);
        assert.strictEqual(
            out.code,
            'gitGraph\n    merge feature/user-auth type: SQUASH tag: "v1.0.0-alpha" msg: "merge: 用户认证模块合入主干"'
        );
    });

    it('strips &<branch> from a commit line', () => {
        const input = 'gitGraph\n    commit id: "order2-rb" tag: "v1.0.0-rc1" &feature/order-refactor';
        const out = fixGitGraphCherryPick(input);
        assert.strictEqual(out.fixed, true);
        assert.strictEqual(
            out.code,
            'gitGraph\n    commit id: "order2-rb" tag: "v1.0.0-rc1"'
        );
    });

    it('strips trailing whitespace after removal', () => {
        const input = 'gitGraph\n    merge feature/x type: NORMAL msg: "msg"    &feature/x   ';
        const out = fixGitGraphCherryPick(input);
        assert.strictEqual(out.fixed, true);
        assert.ok(!out.code.match(/&feature/));
        assert.ok(!out.code.match(/\s+$/m));
    });

    it('leaves non-cherry-pick gitGraph lines untouched', () => {
        const input = [
            'gitGraph',
            '    commit id: "a"',
            '    branch feature/x',
            '    checkout feature/x',
            '    commit id: "b" msg: "feat: x"',
            '    checkout main',
            '    merge feature/x tag: "v1.0" msg: "merge: x into main"'
        ].join('\n');
        const out = fixGitGraphCherryPick(input);
        assert.strictEqual(out.fixed, false);
        assert.strictEqual(out.code, input);
    });

    it('handles batch of cherry-pick lines in one block', () => {
        const input = [
            'gitGraph',
            '    merge feature/user-auth type: SQUASH tag: "v1.0.0-alpha" msg: "msg" &feature/user-auth',
            '    merge feature/payment-gateway type: NORMAL msg: "msg" &feature/payment-gateway',
            '    commit id: "order2-rb" tag: "v1.0.0-rc1" &feature/order-refactor',
            '    merge hotfix/payment-timeout type: NORMAL tag: "v1.0.1-patch" msg: "msg" &hotfix/payment-timeout'
        ].join('\n');
        const out = fixGitGraphCherryPick(input);
        assert.strictEqual(out.fixed, true);
        // All four cherry-pick suffixes gone
        assert.ok(!out.code.match(/&[A-Za-z0-9_./-]+/));
        // Underlying commit/merge structure preserved
        assert.ok(out.code.includes('merge feature/user-auth'));
        assert.ok(out.code.includes('merge feature/payment-gateway'));
        assert.ok(out.code.includes('commit id: "order2-rb"'));
        assert.ok(out.code.includes('merge hotfix/payment-timeout'));
    });

    it('does not touch classDiagram (false-positive defense)', () => {
        const input = 'classDiagram\n    A <|-- B\n    A <--> B : label';
        const out = fixGitGraphCherryPick(input);
        assert.strictEqual(out.fixed, false);
        assert.strictEqual(out.code, input);
    });

    it('does not touch flowchart lines that incidentally contain &', () => {
        const input = 'flowchart LR\n    A --> B\n    C --> D & E';
        const out = fixGitGraphCherryPick(input);
        assert.strictEqual(out.fixed, false);
        assert.strictEqual(out.code, input);
    });

    it('only matches &<branch> on commit/merge lines, not on branch/checkout lines', () => {
        // `branch feature/x` and `checkout feature/x` should NOT be cherry-picked away
        const input = [
            'gitGraph',
            '    branch feature/x',
            '    checkout feature/x',
            '    commit id: "a" &feature/x'
        ].join('\n');
        const out = fixGitGraphCherryPick(input);
        assert.strictEqual(out.fixed, true);
        assert.ok(out.code.includes('branch feature/x'), 'branch line preserved');
        assert.ok(out.code.includes('checkout feature/x'), 'checkout line preserved');
        assert.ok(!out.code.match(/&feature/), 'cherry-pick suffix removed');
    });

    it('handles branch names with hyphens, dots, slashes', () => {
        const input = [
            'gitGraph',
            '    commit id: "a" &feature/sub-1.0',
            '    merge release/v2.0 type: NORMAL &release/v2.0',
            '    commit id: "b" &team_alpha-x'
        ].join('\n');
        const out = fixGitGraphCherryPick(input);
        assert.strictEqual(out.fixed, true);
        assert.ok(!out.code.match(/&[A-Za-z0-9_./-]+/), 'all cherry-pick suffixes removed');
        assert.ok(out.code.includes('commit id: "a"'));
        assert.ok(out.code.includes('merge release/v2.0 type: NORMAL'));
    });
});

describe('fixGitGraphCherryPick via autoFixMermaidCode — integration', () => {
    it('integration: basic cherry-pick fix + fixes array contains the message', () => {
        const input = 'gitGraph\n    merge feature/x msg: "m" &feature/x';
        const out = autoFixMermaidCode(input);
        assert.ok(!out.code.match(/&feature/), 'cherry-pick suffix removed');
        assert.ok(
            out.fixes.includes('Stripped v10 cherry-pick suffix from gitGraph commit/merge'),
            `fixes should contain expected message; got: ${JSON.stringify(out.fixes)}`
        );
    });

    it('integration: cherry-pick coexists with emoji + tab fixes', () => {
        const input = [
            'gitGraph',
            '    commit id: "a" \tmsg: "feat: 实现X接口 😀" &feature/x'
        ].join('\n');
        const out = autoFixMermaidCode(input);
        // Tab replaced with 4 spaces
        assert.ok(!out.code.includes('\t'));
        // Emoji stripped
        assert.ok(!out.code.includes('😀'));
        // Cherry-pick suffix stripped
        assert.ok(!out.code.match(/&feature/));
        // All three fix messages present
        assert.ok(out.fixes.includes('Removed emoji characters'));
        assert.ok(out.fixes.includes('Replaced tabs with 4 spaces'));
        assert.ok(
            out.fixes.includes('Stripped v10 cherry-pick suffix from gitGraph commit/merge')
        );
    });
});