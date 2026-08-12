/**
 * Tests for the error-diagnosis logic in `public/js/mermaid-render.js`.
 *
 * Purpose (CROSSCHECK-R1 §6.3):
 *   "mermaid-render.js:33-87 的 4 条 gitGraph 错误诊断正则——BOTH 没有测试覆盖
 *    AND v11 错误格式变化。"
 *
 * Implementation:
 *   - mermaid-render.js is a browser script and cannot be required directly.
 *     We use `vm.runInNewContext` to inject a stub `mermaid` object, let the
 *     script run through the try/catch error-diagnosis branch, then read
 *     the resulting `.render-error` innerHTML to assert on the hint text.
 *   - No real mermaid.render() is invoked, so no browser dependency.
 *
 * 【Key finding】 - this test honestly records what actually hits in v11
 *   - line extraction regex (`/line\s+(\d+)/i`) -> still hits (v11 errors contain "line N")
 *   - gitGraph merge type (`/\btype:\s*(SQUASH|...)/i`) -> v11 errors only have
 *     'SQUASH' without type: prefix, **does NOT hit** (CROSSCHECK-R1 §6.3 risk realized)
 *   - gitGraph cherry-pick (`/&[A-Za-z0-9_./-]+/`) -> v11 errors write &<- with
 *     angle brackets; lone < is not in the character class, **does NOT hit** (same)
 *   - gitGraph orientation (dual condition) -> v11 errors still contain
 *     "Parse error on line 1" + code contains `gitGraph LR`, **STILL HITS**
 *     (the only one of the 4 still working in v11)
 *   - emoji diagnosis (`/emoji|got\s+'\u/`) -> v11 no longer has \u escape, **does NOT hit**
 *   - numeric token diagnosis (`/got\s+'\d+'/`) -> v11 uses keyword tokens (got 'EOF'), **does NOT hit**
 *
 * Conclusion: 3 of 4 gitGraph diagnoses silently fail in v11; the merge type and
 * cherry-pick diagnoses never show to users in v11 - this is a v11-upgrade UX
 * regression. Suggested fix (out of scope this round): change
 *   /type:\s*(SQUASH|...)/ to /got\s+'(SQUASH|REBASE|...)'/
 *   /&[A-Za-z0-9_./-]+/ to /&<-?[A-Za-z0-9_./-]+>?/
 * Marked as R3 follow-up.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RENDER_PATH = path.join(__dirname, '..', '..', 'public', 'js', 'mermaid-render.js');
const SOURCE = fs.readFileSync(RENDER_PATH, 'utf8');

function loadRenderer() {
    const container = {
        innerHTML: '',
        classList: {
            _set: new Set(),
            add() {}, remove() {}, toggle() {}, contains: () => false
        },
        querySelector: () => null
    };
    let registeredContainer = null;

    const sandbox = {
        console,
        document: {
            getElementById(id) {
                if (id === 'mermaid-container') {
                    registeredContainer = container;
                    return container;
                }
                return null;
            },
            addEventListener() {}, removeEventListener() {}
        },
        localStorage: {
            getItem: () => 'dark',
            setItem() {}, removeItem() {}
        },
        setTimeout, clearTimeout, Promise, Map, Set,
        mermaid: null,
        Date,
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox, { filename: 'mermaid-render.js' });
    vm.runInContext('mermaidRender.init();', sandbox);
    if (!registeredContainer) {
        throw new Error('mermaid-render.js failed to register container');
    }
    return { sandbox, container };
}

async function renderAndCapture(code, errorMessage) {
    const { sandbox, container } = loadRenderer();
    sandbox.mermaid = {
        async render(_id, _code) {
            const e = new Error(errorMessage);
            throw e;
        }
    };
    await sandbox.mermaidRender.render(code);
    return container.innerHTML;
}

describe('mermaid-render.js error-diagnosis regex coverage', () => {
    it('Case 1: gitGraph LR -> orientation diagnosis still hits in v11 (only one of 4 still works)', async () => {
        const err = "Parse error on line 1, column 10: Expecting token of type 'EOF' but found `LR`.";
        const code = 'gitGraph LR\n    commit';
        const html = await renderAndCapture(code, err);
        assert.match(html, /gitGraph 头部方向关键字/,
            'orientation diagnosis in v11 still hits (dual condition both met)');
        assert.match(html, /line 1/, 'line 1 captured by regex (for line-number context)');
    });

    it('Case 2: commit &feature/x -> cherry-pick diagnosis does NOT hit in v11 (risk realized)', async () => {
        const err = 'Lexer error on line 2, column 18: unexpected character: ->&<- at offset: 26';
        const code = 'gitGraph\n    commit id: "x" &feature/y';
        const html = await renderAndCapture(code, err);
        // v11 error writes &<- not &feature/y; regex /&[A-Za-z0-9_./-]+/
        // requires & followed by at least one legal char, < not in class, no hit.
        assert.doesNotMatch(html, /cherry-pick 语法/,
            'v11 error format &<- does not hit cherry-pick diagnosis (regex class lacks <, GAP for R3)');
        assert.match(html, /line 2/, 'line 2 context still shown correctly');
    });

    it('Case 2-compat: v9-style error message with &feature/x literal still hits cherry-pick', async () => {
        const err = 'Parse error on line 2: got "&feature/x" suffix';
        const code = 'gitGraph\n    commit id: "x" &feature/y';
        const html = await renderAndCapture(code, err);
        assert.match(html, /cherry-pick 语法/,
            'v9-style error (with &feature/x adjacent, no quote between) still hits - historical compat insurance');
    });

    it('Case 3: merge type: SQUASH -> merge type diagnosis does NOT hit in v11 (risk realized)', async () => {
        const err = "Parse error on line 5, column 25: Expecting ... but found: 'SQUASH'";
        const code = [
            'gitGraph',
            '    commit',
            '    branch feature/x',
            '    checkout feature/x',
            '    commit',
            '    checkout main',
            '    merge feature/x type: SQUASH'
        ].join('\n');
        const html = await renderAndCapture(code, err);
        // v11 errors only have "but found: SQUASH", regex requires literal type: prefix, no hit.
        assert.doesNotMatch(html, /gitGraph merge 行上的 type 关键字/,
            "v11 error format 'but found: SQUASH' does not hit merge type diagnosis (GAP for R3)");
        assert.match(html, /line 5/, 'line 5 context still shown correctly');
    });

    it('Case 3-compat: v9-style error with "type: SQUASH" literal still hits merge type', async () => {
        const err = 'Parse error on line 5: got type: SQUASH as unexpected token';
        const code = 'gitGraph\n    merge feature/x type: SQUASH';
        const html = await renderAndCapture(code, err);
        assert.match(html, /gitGraph merge 行上的 type 关键字/,
            'v9-style error (with type: SQUASH adjacent, no quotes between) still hits - historical compat insurance');
    });

    it('Case 4: merge type: REBASE -> same Case 3 (GAP + v9 compat symmetric)', async () => {
        const v11Err = "Parse error on line 4, column 25: ... but found: 'REBASE'";
        const codeV11 = 'gitGraph\n    branch feature/x\n    commit\n    merge feature/x type: REBASE';
        const htmlV11 = await renderAndCapture(codeV11, v11Err);
        assert.doesNotMatch(htmlV11, /gitGraph merge 行上的 type 关键字/,
            'v11 error format does not hit');

        const v9Err = 'Parse error on line 4: got type: REBASE as unexpected token';
        const codeV9 = 'gitGraph\n    branch feature/x\n    commit\n    merge feature/x type: REBASE';
        const htmlV9 = await renderAndCapture(codeV9, v9Err);
        assert.match(htmlV9, /gitGraph merge 行上的 type 关键字/,
            'v9-style error still hits');
    });

    it('Case 5: emoji diagnosis is v9-era regex (does not hit in v11)', async () => {
        const v9StyleEmojiErr = "got '\\uD83D\\uDD11'";
        const v11ActualEmojiErr = "got 'UNKNOWN'";

        const code = 'flowchart TD\n    A[开始] --> B';
        const htmlV9Style = await renderAndCapture(code, v9StyleEmojiErr);
        assert.match(htmlV9Style, /表情/,
            'v9-style error (with \\u) still hits - historical compat insurance');

        const htmlV11 = await renderAndCapture(code, v11ActualEmojiErr);
        assert.doesNotMatch(htmlV11, /表情/,
            'v11 error format has no \\u -> emoji diagnosis silently fails (v9-era regex)');
    });

    it('Case 6: numeric token diagnosis is v9-era regex (does not hit in v11)', async () => {
        const v9DigitErr = "Parse error: got '1'";
        const v11KeywordErr = "Parse error: got 'EOF'";

        const code = 'flowchart TD\n    A-->B';
        const htmlV9 = await renderAndCapture(code, v9DigitErr);
        assert.match(htmlV9, /特殊字符/,
            'v9 numeric token style still hits - historical compat insurance');

        const htmlV11 = await renderAndCapture(code, v11KeywordErr);
        assert.doesNotMatch(htmlV11, /特殊字符/,
            "v11 keyword token format: numeric token regex never hits (v9-era regex)");
    });

    it('non-gitGraph code: even with gitGraph-looking error, no gitGraph diagnosis', async () => {
        const err = "Parse error: but found: 'SQUASH'";
        const code = 'flowchart TD\n    A[type: SQUASH] --> B';
        const html = await renderAndCapture(code, err);
        assert.doesNotMatch(html, /gitGraph merge 行上的 type 关键字/,
            'flowchart should not trigger gitGraph merge diagnosis (SQUASH in error != gitGraph)');
    });

    it('line snippet: error line number is correctly extracted and highlighted', async () => {
        const err = 'Parse error on line 3, column 5: ...';
        const code = [
            'gitGraph',
            '    commit',
            '    INVALID_LINE_HERE',
            '    commit'
        ].join('\n');
        const html = await renderAndCapture(code, err);
        assert.match(html, /error-snippet/);
        assert.match(html, />> 3:\s+INVALID_LINE_HERE/,
            'line 3 marked as current (>>) with 2-line context each side');
        assert.match(html, /\b4:\s+commit/,
            'line 4 as plain context (no >> marker)');
    });

    it('happy path: mermaid.render success writes SVG to container, no error UI', async () => {
        const { sandbox, container } = loadRenderer();
        sandbox.mermaid = {
            async render(_id, _code) {
                return { svg: '<svg data-test="happy"><g>node</g></svg>' };
            }
        };
        await sandbox.mermaidRender.render('flowchart TD\n    A-->B');
        assert.match(container.innerHTML, /<svg data-test="happy">/);
        assert.doesNotMatch(container.innerHTML, /render-error/);
    });

    it('happy path: empty code -> clear() branch, no mermaid.render call', async () => {
        const { sandbox, container } = loadRenderer();
        let called = false;
        sandbox.mermaid = {
            async render() { called = true; return { svg: '' }; }
        };
        await sandbox.mermaidRender.render('');
        assert.equal(called, false, 'empty code should not trigger mermaid.render');
        assert.match(container.innerHTML, /placeholder/);
    });
});
