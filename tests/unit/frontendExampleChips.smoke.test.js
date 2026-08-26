'use strict';

// Regression guard for the welcome-page example chips: public/index.html
// carries 4 `.example-chip` buttons with data-example-key attributes, and
// public/js/chat.js holds the matching EXAMPLE_PROMPTS constant. A typo in
// either side fails silently at runtime (bindExampleChips returns early on
// an unknown key -- deliberately, to avoid misleading fallbacks), so this test
// pins both key sets to the source and asserts they stay in sync.
//
// No jsdom: source-level regex extraction, same approach as
// protectedRoutes.edge.test.js (jsdom is not a declared devDependency here).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const htmlPath = path.join(repoRoot, 'public', 'index.html');
const chatPath = path.join(repoRoot, 'public', 'js', 'chat.js');

function htmlChipKeys() {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const keys = [];
    const re = /data-example-key="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) keys.push(m[1]);
    return keys;
}

function examplePrompts() {
    const src = fs.readFileSync(chatPath, 'utf8');
    const start = src.indexOf('const EXAMPLE_PROMPTS = {');
    assert.notStrictEqual(start, -1, 'EXAMPLE_PROMPTS 常量在 chat.js 中缺失');
    // 对象体到行首 `};` 结束；值是长中文字符串，逐行单引号 key 提取避免贪婪跨行。
    const end = src.indexOf('\n};', start);
    assert.notStrictEqual(end, -1, 'EXAMPLE_PROMPTS 对象未找到闭合 `};`');
    const body = src.slice(start, end);
    const entries = {};
    const re = /'([^']+)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(body)) !== null) entries[m[1]] = m[2];
    return entries;
}

test('欢迎页示例 chip 与 EXAMPLE_PROMPTS 的 key 集合一致', () => {
    const htmlKeys = htmlChipKeys();
    const prompts = examplePrompts();
    const promptKeys = Object.keys(prompts);

    const missing = htmlKeys.filter((k) => !(k in prompts));
    const extra = promptKeys.filter((k) => !htmlKeys.includes(k));
    assert.deepStrictEqual(
        { missing, extra },
        { missing: [], extra: [] },
        `示例 chip key 不同步 -- HTML 有而常量缺失: [${missing.join(', ')}]; ` +
        `常量有而 HTML 多余: [${extra.join(', ')}]`
    );
});

test('示例 chip 集合非空且恰为 4 个', () => {
    const htmlKeys = htmlChipKeys();
    const promptKeys = Object.keys(examplePrompts());
    assert.ok(htmlKeys.length > 0, 'HTML 中未找到任何 data-example-key');
    assert.strictEqual(htmlKeys.length, 4, `HTML chip 数量应为 4，实际 ${htmlKeys.length}`);
    assert.strictEqual(promptKeys.length, 4, `EXAMPLE_PROMPTS 数量应为 4，实际 ${promptKeys.length}`);
    assert.strictEqual(new Set(htmlKeys).size, 4, 'HTML chip key 存在重复');
});

test('每条示例提示词为非空字符串且长度不少于 100', () => {
    const prompts = examplePrompts();
    for (const [key, value] of Object.entries(prompts)) {
        assert.strictEqual(typeof value, 'string', `${key} 的提示词应为字符串`);
        assert.ok(value.trim().length > 0, `${key} 的提示词为空`);
        assert.ok(
            value.length >= 100,
            `${key} 的提示词长度 ${value.length} < 100，疑似被截断`
        );
    }
});
