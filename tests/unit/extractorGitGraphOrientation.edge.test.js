/**
 * Tests for fixGitGraphOrientation — strips Mermaid v10.3.0+ direction
 * keyword (LR / TB / RL / BT) from a gitGraph header line.
 *
 * Regression target: LLM emits `gitGraph LR` per v10.3.0+ docs, but
 * vendored mermaid 3.0.9's gitGraph parser only accepts the bare
 * `gitGraph` keyword (or `gitGraph: { ... }` config block). Parse fails
 * with "Parse error on line 1".
 *
 * Strategy: drop the orientation token. The vendored renderer doesn't
 * honor it anyway, and silently falling back to the default direction
 * beats a hard parse failure.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
    fixGitGraphOrientation,
    autoFixMermaidCode
} = require('../../src/services/extractor');

describe('fixGitGraphOrientation — pure-function unit tests', () => {
    it('strips LR from a gitGraph LR header', () => {
        const input = 'gitGraph LR\n    commit id: "init"';
        const out = fixGitGraphOrientation(input);
        assert.strictEqual(out.fixed, true);
        assert.strictEqual(out.code, 'gitGraph\n    commit id: "init"');
    });

    it('strips TB (top-to-bottom)', () => {
        const input = 'gitGraph TB\n    commit\n    branch x\n    checkout x\n    commit';
        const out = fixGitGraphOrientation(input);
        assert.strictEqual(out.fixed, true);
        assert.ok(!out.code.match(/\bTB\b/));
        assert.ok(out.code.startsWith('gitGraph\n'));
    });

    it('strips RL and BT (v10.3.0+ directions)', () => {
        assert.strictEqual(
            fixGitGraphOrientation('gitGraph RL\n    commit').code,
            'gitGraph\n    commit'
        );
        assert.strictEqual(
            fixGitGraphOrientation('gitGraph BT\n    commit').code,
            'gitGraph\n    commit'
        );
    });

    it('is case-insensitive (lr, Tb, rL all match)', () => {
        assert.strictEqual(
            fixGitGraphOrientation('gitGraph lr\n    commit').fixed,
            true
        );
        assert.strictEqual(
            fixGitGraphOrientation('gitGraph Tb\n    commit').fixed,
            true
        );
        assert.strictEqual(
            fixGitGraphOrientation('gitGraph rL\n    commit').fixed,
            true
        );
    });

    it('leaves a bare `gitGraph` header alone', () => {
        const input = 'gitGraph\n    commit id: "init"';
        const out = fixGitGraphOrientation(input);
        assert.strictEqual(out.fixed, false);
        assert.strictEqual(out.code, input);
    });

    it('returns code unchanged for non-gitGraph code', () => {
        const input = 'flowchart LR\n    A-->B\n    flowchart TB\n    C-->D';
        const out = fixGitGraphOrientation(input);
        assert.strictEqual(out.fixed, false);
        assert.strictEqual(out.code, input);
    });

    it('does not touch LR/TB appearing in branch names or comments', () => {
        // 防止误伤：分支名含 LR/TB 不应被剥
        const input = [
            'gitGraph',
            '    commit id: "a"',
            '    branch feature/LR-fix',
            '    checkout feature/LR-fix',
            '    commit id: "b" msg: "fix TB rendering"'
        ].join('\n');
        const out = fixGitGraphOrientation(input);
        assert.strictEqual(out.fixed, false);
        assert.strictEqual(out.code, input);
    });

    it('preserves indentation on the gitGraph header (none expected)', () => {
        // gitGraph 关键字本身按 Mermaid 约定应在第 1 列；这里只确保不引入额外空格
        const out = fixGitGraphOrientation('gitGraph   LR\n    commit');
        assert.strictEqual(out.code, 'gitGraph\n    commit');
    });

    it('composes with fixGitGraphMergeType and fixGitGraphCherryPick (orientation-only call leaves merge/cherry-pick alone)', () => {
        const input = [
            'gitGraph LR',
            '    commit id: "init"',
            '    branch feature/x',
            '    checkout feature/x',
            '    commit id: "feat"',
            '    checkout main',
            '    merge feature/x type: SQUASH tag: "v1" &feature/x'
        ].join('\n');
        const out = fixGitGraphOrientation(input);
        assert.strictEqual(out.fixed, true);
        assert.ok(!out.code.match(/\bLR\b/), 'LR stripped');
        // 本函数只剥 orientation；SQUASH/&feature 由另外两个 fix 负责
        assert.ok(out.code.match(/\bSQUASH\b/), 'SQUASH left for the merge-type fix');
        assert.ok(out.code.includes('&feature/x'), 'cherry-pick suffix left for the cherry-pick fix');
    });
});

describe('fixGitGraphOrientation via autoFixMermaidCode — integration', () => {
    it('integration: orientation fix + fixes array contains the message', () => {
        const input = 'gitGraph LR\n    commit id: "init"\n    commit id: "feat"';
        const out = autoFixMermaidCode(input);
        assert.ok(!out.code.match(/\bLR\b/), 'LR removed');
        assert.ok(
            out.fixes.includes('Stripped v10.3.0+ orientation (LR/TB/RL/BT) from gitGraph header'),
            `fixes should contain expected message; got: ${JSON.stringify(out.fixes)}`
        );
    });

    it('integration: orientation + merge type + cherry-pick all fire together', () => {
        const input = [
            'gitGraph LR',
            '    commit id: "init"',
            '    branch feature/x',
            '    checkout feature/x',
            '    commit id: "feat"',
            '    checkout main',
            '    merge feature/x type: SQUASH tag: "v1" &feature/x'
        ].join('\n');
        const out = autoFixMermaidCode(input);
        assert.ok(!out.code.match(/\bLR\b/), 'LR stripped');
        assert.ok(!out.code.match(/\bSQUASH\b/), 'SQUASH stripped');
        assert.ok(!out.code.match(/&feature\/x/), 'cherry-pick suffix stripped');
        assert.ok(out.fixes.length >= 3, `expected ≥3 fixes; got: ${JSON.stringify(out.fixes)}`);
    });

    it('integration: realistic full graph with all three fixes composes to a renderable diagram', () => {
        // 这一段是用户实际场景下 LLM 容易输出的形态：LR 方向 + SQUASH merge + &branch 冗余
        const input = [
            'gitGraph LR',
            '    commit id: "init"',
            '    branch feature/auth',
            '    checkout feature/auth',
            '    commit id: "feat: login"',
            '    commit id: "test: auth spec"',
            '    checkout main',
            '    merge feature/auth type: SQUASH tag: "v1.0.0" &feature/auth',
            '    branch hotfix/x',
            '    checkout hotfix/x',
            '    commit id: "fix: bug"',
            '    checkout main',
            '    merge hotfix/x tag: "v1.0.1" type: FAST_FORWARD'
        ].join('\n');
        const out = autoFixMermaidCode(input);
        assert.ok(!out.code.match(/\bLR\b/), 'LR stripped');
        assert.ok(!out.code.match(/\bSQUASH\b/i), 'SQUASH stripped');
        assert.ok(!out.code.match(/\bFAST_FORWARD\b/i), 'FAST_FORWARD stripped');
        assert.ok(!out.code.match(/&feature\/auth/), 'cherry-pick on auth line stripped');
        // NORMAL 类型不出现在这里，但 tag 必须保留
        assert.ok(out.code.includes('tag: "v1.0.0"'), 'tag preserved');
        assert.ok(out.code.includes('tag: "v1.0.1"'), 'tag preserved');
        assert.ok(out.code.includes('id: "feat: login"'), 'commit id preserved');
    });
});
