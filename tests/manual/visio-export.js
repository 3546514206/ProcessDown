/**
 * Visio (.vsdx) 导出手动冒烟脚本（无断言）
 *
 * 用 vendored mermaid 11.16.1 + vendored @klyratech/mermaid-to-visio
 * 在 jsdom 沙箱里跑通三张代表图，写盘 /tmp/visio-smoke-*.vsdx，
 * 再用系统 `unzip -l` 校验 OPC 必备 part 是否齐全。
 *
 * 沿用 tests/export.test.js 的"手动跑 + 写盘 + 打印结果"风格，
 * 不做 node:test 断言（这一步是给人眼 + 系统工具复核的，
 * 真正的契约单测在 tests/unit/frontendExportVisio.*.test.js 12 项）。
 *
 * 跑法：
 *   node tests/manual/visio-export.js
 *   unzip -l /tmp/visio-smoke-flowchart.vsdx
 *   xmllint --noout <(unzip -p /tmp/visio-smoke-flowchart.vsdx visio/pages/page1.xml)
 *
 * 注意：jsdom 缺 SVG 测量 API（getBBox / getComputedTextLength 等），本脚本给
 * SVGElement.prototype 打了一套 polyfill（基于标签几何 + 字符估算）才能让 mermaid
 * 完成渲染。polyfill 不影响 vendored visio 库本身的真实行为——库还是吃真 SVG DOM，
 * 走相同的 captureSvgToDisplayList / buildVsdxFromDisplayList / buildVsdxPackage 链路。
 *
 * flowchart 在 jsdom 下会走 `<foreignObject>` 路径（即使 htmlLabels:false），与真实
 * 浏览器不一致，所以本脚本 flowchart 用手写 SVG；sequence/state 用真 mermaid。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const MERMAID_VENDOR = path.join(ROOT, 'public', 'vendor', 'mermaid.min.js');
const VISIO_VENDOR = path.join(ROOT, 'public', 'vendor', 'mermaid-to-visio.esm.js');

const MERMAID_SRC = fs.readFileSync(MERMAID_VENDOR, 'utf8');
const VISIO_SRC = fs.readFileSync(VISIO_VENDOR, 'utf8');

// === jsdom 装载：跑 vendored mermaid（esbuild IIFE 包装需要预定义命名空间） ===
const vc = new VirtualConsole();
vc.on('jsdomError', () => { /* 沙箱里一些 jsdomError 不影响流程，静默 */ });

const dom = new JSDOM('<!doctype html><html><body><div id="holder"></div></body></html>', {
    url: 'http://127.0.0.1/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc
});
const w = dom.window;

// mermaid 11.x vendored bundle 是 esbuild IIFE 包装：
//   var __esbuild_esm_mermaid_nm;(__esbuild_esm_mermaid_nm||={}).mermaid=(...)();
// 不预定义 __esbuild_esm_mermaid_nm 时 || {} 兜底导致赋值丢到匿名对象，
// 末尾 globalThis["mermaid"] = ...default 读不到。预定义一个 window 上的占位对象修。
const mermaidWrapped = MERMAID_SRC
    .replace('var __esbuild_esm_mermaid_nm;',
        'var __esbuild_esm_mermaid_nm = globalThis.__esbuild_esm_mermaid_nm = globalThis.__esbuild_esm_mermaid_nm || {};')
    .replace('(__esbuild_esm_mermaid_nm||={}).mermaid=', '__esbuild_esm_mermaid_nm.mermaid=')
    .replace('globalThis.__esbuild_esm_mermaid_nm["mermaid"].default',
        '__esbuild_esm_mermaid_nm.mermaid.default');
w.eval(mermaidWrapped);

if (typeof w.mermaid !== 'object' || typeof w.mermaid.render !== 'function') {
    throw new Error('vendored mermaid 未正确装载，typeof window.mermaid=' + typeof w.mermaid);
}

// === SVG 测量 API polyfill：jsdom 的 SVGGraphicsElement 不实现 getBBox 等 ===
const SVGProto = w.SVGElement.prototype;
function numAttr(el, a) { return parseFloat(el.getAttribute(a)) || 0; }
function fontPxOf(el) {
    try { return parseFloat(w.getComputedStyle(el).fontSize) || 14; } catch (_) { return 14; }
}
SVGProto.getBBox = function () {
    const tag = this.tagName.toLowerCase();
    if (tag === 'rect') return { x: numAttr(this, 'x'), y: numAttr(this, 'y'), width: numAttr(this, 'width'), height: numAttr(this, 'height') };
    if (tag === 'circle') { const r = numAttr(this, 'r'); return { x: numAttr(this, 'cx') - r, y: numAttr(this, 'cy') - r, width: 2 * r, height: 2 * r }; }
    if (tag === 'ellipse') { const rx = numAttr(this, 'rx'), ry = numAttr(this, 'ry'); return { x: numAttr(this, 'cx') - rx, y: numAttr(this, 'cy') - ry, width: 2 * rx, height: 2 * ry }; }
    if (tag === 'line') { const x1 = numAttr(this, 'x1'), y1 = numAttr(this, 'y1'), x2 = numAttr(this, 'x2'), y2 = numAttr(this, 'y2'); return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1) || 1, height: Math.abs(y2 - y1) || 1 }; }
    if (tag === 'text' || tag === 'tspan') {
        const fp = fontPxOf(this);
        const text = this.textContent || '';
        return { x: numAttr(this, 'x') || 0, y: (numAttr(this, 'y') || 0) - fp, width: Math.max(text.length, 1) * fp * 0.6, height: fp * 1.2 };
    }
    if (tag === 'path') return { x: 0, y: 0, width: 100, height: 100 }; // 粗略，库只看 transform+getTotalLength
    return { x: 0, y: 0, width: 50, height: 20 };
};
SVGProto.getComputedTextLength = function () { return (this.textContent || '').length * fontPxOf(this) * 0.6; };
SVGProto.getSubStringLength = function (start, len) { return ((this.textContent || '').substring(start, start + len).length) * fontPxOf(this) * 0.6; };
SVGProto.getNumberOfChars = function () { return (this.textContent || '').length; };
SVGProto.getTotalLength = function () { return 100; };
SVGProto.getPointAtLength = function (d) { return { x: d, y: 0 }; };
SVGProto.getCTM = function () { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; };
SVGProto.getScreenCTM = function () { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; };
SVGProto.selectSubString = function () {};

// === 注入 vendored visio lib（去掉 export 行，把 svgElementToVsdx 挂到 window） ===
const visioStripped = VISIO_SRC.replace(/export\s*\{[^}]+\};?/m, '');
w.eval(visioStripped + '\nwindow.__svgElementToVsdx = svgElementToVsdx;');

// === 三张代表图：flowchart(手写)+ sequence(真 mermaid) + state(真 mermaid) ===

// flowchart：jsdom 下 mermaid 11.x 的 flowchart-v2 即便 htmlLabels:false 也会走
// <foreignObject> 兜底（与真实浏览器不同），所以本图用手写 SVG：节点矩形 + 连线 +
// <text>，覆盖库消费的真实几何形态
const FLOWCHART_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 220 96" width="220" height="96">
  <style>.node-rect{fill:#ECECFF;stroke:#9370DB;stroke-width:1px;}
  .node-text{font-family:"trebuchet ms",verdana,arial,sans-serif;font-size:14px;fill:#333;}
  .edge-line{stroke:#333333;stroke-width:1px;fill:none;}
  .arrow{fill:#333333;stroke:#333333;}</style>
  <rect class="node-rect" x="0" y="0" width="60" height="30" rx="4"/>
  <text class="node-text" x="30" y="20" text-anchor="middle">用户登录</text>
  <rect class="node-rect" x="140" y="0" width="60" height="30" rx="4"/>
  <text class="node-text" x="170" y="20" text-anchor="middle">验证密码</text>
  <line class="edge-line" x1="60" y1="15" x2="140" y2="15" marker-end="url(#arr)"/>
  <polygon class="arrow" points="135,12 140,15 135,18"/>
  <text class="node-text" x="100" y="11" text-anchor="middle" style="font-size:10px;">提交</text>
</svg>`;

const SEQUENCE_DEFINITION = `sequenceDiagram
    participant U as 用户
    participant S as 认证服务器
    U->>S: 提交登录
    S-->>U: 返回结果`;

const STATE_DEFINITION = `stateDiagram-v2
    [*] --> 待处理
    待处理 --> 处理中
    处理中 --> 完成
    完成 --> [*]`;

/**
 * Render an svgString into a real DOM via jsdom, hand to the vendored lib,
 * and write the .vsdx to /tmp.  Return a result descriptor.
 */
async function renderToVsdx(label, svgString, opts = {}) {
    const holder = w.document.getElementById('holder');
    holder.innerHTML = svgString;
    const svgEl = holder.querySelector('svg');
    if (!svgEl) throw new Error(`[${label}] 找不到 <svg> 根`);

    const out = await w.__svgElementToVsdx(svgEl, { title: label });
    const bytes = out && out.bytes;
    // jsdom 跨 realm：bytes.constructor.name === 'Uint8Array' 是可靠的判断
    // （instanceof Uint8Array 在跨 realm 时会 false，因为 prototype 不同）
    if (!bytes || bytes.constructor.name !== 'Uint8Array') throw new Error(`[${label}] 库未产出 bytes`);

    const outPath = path.join('/tmp', `visio-smoke-${label}.vsdx`);
    fs.writeFileSync(outPath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { label, outPath, bytes: bytes.length, stats: out.stats };
}

async function renderMermaidToVsdx(label, definition) {
    // mermaid 全局初始化：htmlLabels:false 是成败关键（库只吃 <text>）。
    // jsdom 下 flowchart-v2 仍走 <foreignObject>，所以本脚本 flowchart 用手写 SVG；
    // sequence / state 用真 mermaid 输出（这两类在 jsdom 下产 <text>）。
    const result = await w.mermaid.render(`smoke-${label}-${Date.now()}`, definition);
    const svgString = typeof result === 'string' ? result : result && result.svg;
    if (!svgString) throw new Error(`[${label}] mermaid 未产出 svg 字符串`);
    return renderToVsdx(label, svgString);
}

// === 跑三张图 ===
(async () => {
    // 全局初始化一次（reset 给单测之间的隔离，本脚本就一次）
    w.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'default',
        flowchart: { htmlLabels: false, useMaxWidth: true },
        sequence: { useMaxWidth: true },
        state: { useMaxWidth: true }
    });

    const results = [];
    results.push(await renderToVsdx('flowchart', FLOWCHART_SVG));
    results.push(await renderMermaidToVsdx('sequence', SEQUENCE_DEFINITION));
    results.push(await renderMermaidToVsdx('state', STATE_DEFINITION));

    console.log('=== visio 手动冒烟结果 ===');
    for (const r of results) {
        console.log(`[${r.label}] -> ${r.outPath} (${r.bytes} bytes) stats=${JSON.stringify(r.stats)}`);
    }

    // unzip -l 校验必备 part
    console.log('\n=== unzip -l 校验 OPC 必备 part ===');
    const REQUIRED = [
        '[Content_Types].xml',
        '_rels/.rels',
        'visio/document.xml',
        'visio/_rels/document.xml.rels',
        'visio/pages/pages.xml',
        'visio/pages/_rels/pages.xml.rels',
        'visio/pages/page1.xml'
    ];
    let allOk = true;
    for (const r of results) {
        let listing;
        try {
            listing = execSync(`unzip -l "${r.outPath}"`, { encoding: 'utf8' });
        } catch (e) {
            console.log(`[${r.label}] unzip 失败：${e.message}`);
            allOk = false;
            continue;
        }
        const missing = REQUIRED.filter((p) => !listing.includes(' ' + p + '\n') && !listing.includes(' ' + p + ' '));
        if (missing.length === 0) {
            console.log(`[${r.label}] OK 9/9 part 齐全`);
        } else {
            console.log(`[${r.label}] 缺：${missing.join(', ')}`);
            allOk = false;
        }
    }

    // xmllint 校验 visio/pages/page1.xml 合法
    console.log('\n=== xmllint --noout 校验 visio/pages/page1.xml ===');
    for (const r of results) {
        try {
            execSync(`unzip -p "${r.outPath}" visio/pages/page1.xml | xmllint --noout -`, { stdio: 'pipe' });
            console.log(`[${r.label}] page1.xml 合法`);
        } catch (e) {
            console.log(`[${r.label}] page1.xml 不合法：${(e.stderr || e.message || '').toString().slice(0, 300)}`);
            allOk = false;
        }
    }

    dom.window.close();
    if (!allOk) {
        console.error('\n至少一个图未通过 OPC 校验');
        process.exit(1);
    }
    console.log('\n全部通过。');
})().catch((err) => {
    console.error('冒烟失败：', err.stack || err.message || err);
    try { dom.window.close(); } catch (_) {}
    process.exit(1);
});