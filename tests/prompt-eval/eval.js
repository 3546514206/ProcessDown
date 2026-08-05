/**
 * 提示词评估脚本：用一组"未指定图表类型"的模糊提示词调用 LLM，
 * 用 extractor 提取输出并归一化图表类型，对比期望类型算准确率。
 *
 * 用法：node tests/prompt-eval/eval.js
 * 输出：控制台准确率摘要 + tests/prompt-eval/results.json
 *
 * expected 可以是字符串，或字符串数组（歧义用例，命中任一即正确）。
 * 归一化全部转小写对比，避免 sequenceDiagram vs sequencediagram 误判。
 */
const path = require('path');
const fs = require('fs');
const { getConfig } = require('../../src/config/loader');
const LLMService = require('../../src/services/llm');
const { extractMermaidCode } = require('../../src/services/extractor');

const config = getConfig();
const llm = new LLMService(config);
const systemPrompt = fs.readFileSync(path.join(process.cwd(), 'prompts', 'system.txt'), 'utf-8');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf-8'));

// 把 mermaid 代码开头的图表关键字归一化为小写，便于对比。
// 跳过 frontmatter（11.16.1 原生支持，LLM 可能输出）。
function normalizeType(code) {
    if (!code) return 'none';
    const c = code.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '').trim();
    const m = c.match(/^\s*([A-Za-z0-9_-]+)/);
    if (!m) return 'unknown';
    const t = m[1].toLowerCase();
    if (t === 'graph') return 'flowchart';
    if (t.startsWith('c4')) return 'c4';
    if (t.startsWith('sankey')) return 'sankey';
    if (t.startsWith('xychart')) return 'xychart';
    if (t.startsWith('block')) return 'block';
    if (t.startsWith('architecture')) return 'architecture';
    if (t.startsWith('radar')) return 'radar';
    if (t.startsWith('venn')) return 'venn';
    if (t.startsWith('ishikawa') || t === 'fishbone') return 'ishikawa';
    if (t.startsWith('wardley')) return 'wardley';
    if (t.startsWith('cynefin')) return 'cynefin';
    if (t.startsWith('treeview')) return 'treeview';
    if (t.startsWith('swimlane')) return 'swimlane';
    if (t.startsWith('treemap')) return 'treemap';
    return t;
}

// 把 expected 类型名归一化为与 normalizeType 输出一致的形式：
// 去 -beta 后缀、C4* -> c4、转小写。这样 'radar-beta' 与 got 'radar' 对齐，
// 'C4Container' 与 got 'c4' 对齐，避免归一化不对称导致的误判。
function normalizeExpected(e) {
    const t = String(e).toLowerCase().replace(/-beta$/, '');
    if (t.startsWith('c4')) return 'c4';
    return t;
}

function matchExpected(got, expected) {
    const g = got.toLowerCase();
    if (Array.isArray(expected)) return expected.some(e => normalizeExpected(e) === g);
    return normalizeExpected(expected) === g;
}

async function evalOne(c) {
    const messages = [{ role: 'user', content: `请根据以下描述生成 Mermaid 图表代码：\n\n${c.prompt}` }];
    try {
        const resp = await llm.chat(messages, systemPrompt);
        const code = extractMermaidCode(resp);
        const got = normalizeType(code);
        const head = code ? code.replace(/\s+/g, ' ').slice(0, 70) : '(no mermaid)';
        return { ...c, got, match: matchExpected(got, c.expected), head };
    } catch (e) {
        return { ...c, got: 'error:' + String(e.message).slice(0, 50), match: false, head: '' };
    }
}

async function main() {
    const pad = 22;
    console.log(`Model: ${config.llm.model} | Cases: ${cases.length} | system.txt: ${systemPrompt.length} chars\n`);
    const results = await Promise.all(cases.map(evalOne));
    let correct = 0;
    const mismatches = [];
    for (const r of results) {
        const mark = r.match ? '✓' : '✗';
        const exp = Array.isArray(r.expected) ? r.expected.join('|') : r.expected;
        console.log(`${mark} ${r.id} expected=${String(exp).padEnd(pad)} got=${String(r.got).padEnd(16)} | ${r.prompt.slice(0, 24)}`);
        if (r.match) correct++; else mismatches.push(`${r.id}: got=${r.got} expected=${exp} | ${r.head}`);
    }
    const acc = Math.round(correct / cases.length * 100);
    console.log(`\n=== Accuracy: ${correct}/${cases.length} (${acc}%) ===`);
    if (mismatches.length) { console.log('\nMismatches:'); console.log(mismatches.join('\n')); }
    fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ accuracy: correct / cases.length, correct, total: cases.length, results }, null, 2));
    console.log('\nresults.json written.');
}

main().catch(e => { console.error(e); process.exit(1); });
