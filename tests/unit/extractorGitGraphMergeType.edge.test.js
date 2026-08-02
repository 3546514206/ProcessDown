/**
 * Tests for fixGitGraphMergeType — strips Mermaid v10+ merge type keyword
 * (SQUASH / REBASE / FAST_FORWARD / FAST-FORWARD) from gitGraph merge lines.
 *
 * Regression target: LLM emits `merge feature/x type: SQUASH tag: "..."` per
 * v10+ docs, but vendored mermaid 3.0.9 (v9 gitGraph parser) only accepts
 * `type: NORMAL|REVERSE|HIGHLIGHT` as commit-style highlight, not as merge
 * algorithm. Parse fails with "but found: 'SQUASH'" / "but found: 'REBASE'".
 *
 * Strategy: strip the v10+ type segment entirely. Mapping to NORMAL would
 * be a lie (NORMAL is a highlight, not a merge algorithm in v9), so we just
 * drop the unsupported keyword. NORMAL itself is preserved when present.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
    fixGitGraphMergeType,
    autoFixMermaidCode
} = require('../../src/services/extractor');

describe('fixGitGraphMergeType — pure-function unit tests', () => {
    it('strips type: SQUASH from the user-reported line 16', () => {
        const input = 'gitGraph\n    merge feature/user-auth id: "merge: 用户认证模块合入主干" tag: "v1.0.0-alpha" type: SQUASH';
        const out = fixGitGraphMergeType(input);
        assert.strictEqual(out.fixed, true);
        assert.strictEqual(
            out.code,
            'gitGraph\n    merge feature/user-auth id: "merge: 用户认证模块合入主干" tag: "v1.0.0-alpha"'
        );
    });

    it('strips type: REBASE when it appears before tag', () => {
        const input = 'gitGraph\n    merge feature/order-refactor id: "perf: 优化订单列表查询性能" type: REBASE tag: "v1.0.0-rc1"';
        const out = fixGitGraphMergeType(input);
        assert.strictEqual(out.fixed, true);
        assert.strictEqual(
            out.code,
            'gitGraph\n    merge feature/order-refactor id: "perf: 优化订单列表查询性能" tag: "v1.0.0-rc1"'
        );
    });

    it('strips type: FAST_FORWARD (underscore form)', () => {
        const input = 'gitGraph\n    merge hotfix/x type: FAST_FORWARD';
        const out = fixGitGraphMergeType(input);
        assert.strictEqual(out.fixed, true);
        assert.strictEqual(out.code, 'gitGraph\n    merge hotfix/x');
    });

    it('strips type: FAST-FORWARD (hyphen form)', () => {
        const input = 'gitGraph\n    merge hotfix/x type: FAST-FORWARD tag: "v1.0.0-fc"';
        const out = fixGitGraphMergeType(input);
        assert.strictEqual(out.fixed, true);
        assert.strictEqual(out.code, 'gitGraph\n    merge hotfix/x tag: "v1.0.0-fc"');
    });

    it('preserves type: NORMAL — that is v9-legitimate commit-style highlight', () => {
        const input = 'gitGraph\n    merge feature/x type: NORMAL';
        const out = fixGitGraphMergeType(input);
        assert.strictEqual(out.fixed, false);
        assert.strictEqual(out.code, input);
    });

    it('preserves type: HIGHLIGHT on commit lines (v9-legitimate)', () => {
        const input = 'gitGraph\n    commit id: "feat: x" type: HIGHLIGHT';
        const out = fixGitGraphMergeType(input);
        assert.strictEqual(out.fixed, false);
        assert.strictEqual(out.code, input);
    });

    it('is case-insensitive on the type keyword', () => {
        const input = 'gitGraph\n    merge feature/x type: squash';
        const out = fixGitGraphMergeType(input);
        assert.strictEqual(out.fixed, true);
        assert.strictEqual(out.code, 'gitGraph\n    merge feature/x');
    });

    it('leaves a no-merge gitGraph alone', () => {
        const input = 'gitGraph\n    commit id: "initial"';
        const out = fixGitGraphMergeType(input);
        assert.strictEqual(out.fixed, false);
        assert.strictEqual(out.code, input);
    });

    it('returns code unchanged for non-gitGraph code', () => {
        const input = 'flowchart TD\n    A-->B';
        const out = fixGitGraphMergeType(input);
        assert.strictEqual(out.fixed, false);
        assert.strictEqual(out.code, input);
    });

    it('handles multiple merge lines in one graph', () => {
        const input = [
            'gitGraph',
            '    merge feature/payment id: "..." type: SQUASH',
            '    merge feature/order id: "..." type: REBASE tag: "v1"',
            '    merge hotfix/x'
        ].join('\n');
        const out = fixGitGraphMergeType(input);
        assert.strictEqual(out.fixed, true);
        assert.strictEqual(
            out.code,
            [
                'gitGraph',
                '    merge feature/payment id: "..."',
                '    merge feature/order id: "..." tag: "v1"',
                '    merge hotfix/x'
            ].join('\n')
        );
    });
});

describe('fixGitGraphMergeType — REAL full-graph regression', () => {
    // Both fixGitGraphCherryPick and fixGitGraphMergeType must compose so the
    // user's exact code (lines 16 + 33 had v10+ merge types) parses cleanly.
    it('the user-reported graph type-checks after autoFixMermaidCode', () => {
        const code = [
            'gitGraph',
            '    options',
            '        LR',
            '        mainBranchName: main',
            '    end',
            '',
            '    commit id: "初始化: 项目脚手架搭建"',
            '',
            '    branch feature/user-auth',
            '    checkout feature/user-auth',
            '    commit id: "feat: 实现JWT登录接口"',
            '    commit id: "test: 补充认证模块单元测试"',
            '',
            '    checkout main',
            '    commit id: "docs: 更新API文档v1.0"',
            '    merge feature/user-auth id: "merge: 用户认证模块合入主干" tag: "v1.0.0-alpha" type: SQUASH',
            '',
            '    branch feature/payment-gateway',
            '    checkout feature/payment-gateway',
            '    commit id: "feat: 对接支付宝SDK"',
            '    commit id: "fix: 修复支付回调签名校验"',
            '    commit id: "feat: 增加微信支付渠道"',
            '',
            '    branch feature/order-refactor',
            '    checkout feature/order-refactor',
            '    commit id: "refactor: 订单模型重构"',
            '    commit id: "perf: 优化订单列表查询性能"',
            '',
            '    branch release/v1.0.0',
            '    checkout release/v1.0.0',
            '    commit id: "chore: 版本号升级至1.0.0"',
            '    merge feature/payment-gateway id: "merge: 集成支付网关至发布分支" type: NORMAL',
            '    merge feature/order-refactor id: "perf: 优化订单列表查询性能" type: REBASE tag: "v1.0.0-rc1"',
            '',
            '    checkout main',
            '    merge release/v1.0.0 id: "merge: 发布分支v1.0.0合入主干" tag: "v1.0.0" type: NORMAL',
            '',
            '    branch hotfix/payment-timeout',
            '    checkout hotfix/payment-timeout',
            '    commit id: "fix: 修复支付超时未重试问题"',
            '    commit id: "test: 补充超时场景集成测试"',
            '',
            '    checkout main',
            '    merge hotfix/payment-timeout id: "merge: 热修复合入主干" tag: "v1.0.1" type: NORMAL',
            '',
            '    checkout release/v1.0.0',
            '    merge hotfix/payment-timeout id: "merge: 热修复合入发布分支" tag: "v1.0.1-patch" type: NORMAL',
            '',
            '    checkout main',
            '    branch feature/inventory-sync',
            '    checkout feature/inventory-sync',
            '    commit id: "feat: 库存同步定时任务原型"',
            '',
            '    checkout main',
            '    commit id: "ci: 配置自动化部署流水线"'
        ].join('\n');

        const out = autoFixMermaidCode(code);
        // 用户的图应该被识别为含 gitGraph 并被自动修复
        assert.ok(out.fixes.some(f => f.includes('SQUASH/REBASE/FAST_FORWARD')),
            `expected merge-type fix in fixes, got: ${JSON.stringify(out.fixes)}`);
        // 修复后的代码中不应再含 SQUASH/REBASE 关键字
        assert.ok(!/\btype:\s*SQUASH\b/i.test(out.code), 'SQUASH should be stripped');
        assert.ok(!/\btype:\s*REBASE\b/i.test(out.code), 'REBASE should be stripped');
        // NORMAL 必须保留
        assert.ok(/\btype:\s*NORMAL\b/i.test(out.code), 'NORMAL must be preserved');
        // 其他属性（id / tag）必须保留
        assert.ok(out.code.includes('tag: "v1.0.0-alpha"'),
            'tag: "v1.0.0-alpha" must be preserved');
        assert.ok(out.code.includes('tag: "v1.0.0-rc1"'),
            'tag: "v1.0.0-rc1" must be preserved');
        assert.ok(out.code.includes('id: "merge: 用户认证模块合入主干"'),
            'id / Chinese message must be preserved');
    });
});
