/**
 * 真 mermaid flowchart-v2 输出 vs 库的解析——定位"导出 .vsdx 在 Visio 里空白"
 *
 * 沿用 tests/manual/visio-export.js 的 jsdom 装载方式（绕过 vendored mermaid
 * 的 IIFE 命名空间坑 + SVG 测量 API polyfill），但本次不绕：让 mermaid 真正
 * 渲染 flowchart-v2 走 htmlLabels:false，把 SVG 字符串落盘 + 直接喂库，
 * 报告库到底抽到几个 shape/text。
 *
 * 如果 stats.shapes=0 && stats.texts=0，就是 mermaid 输出与库的解析失配。
 * 输出文件供肉眼/库比对：
 *   /tmp/visio-probe.svg     —— mermaid 11.16.1 flowchart-v2 htmlLabels:false 的真实 SVG
 *   /tmp/visio-probe.vsdx    —— 喂完库的产物
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

const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM('<!doctype html><html><body><div id="holder"></div></body></html>', {
    url: 'http://127.0.0.1/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc
});
const w = dom.window;

// 绕过 IIFE 命名空间坑：见 tests/manual/visio-export.js
const mermaidWrapped = MERMAID_SRC
    .replace('var __esbuild_esm_mermaid_nm;',
        'var __esbuild_esm_mermaid_nm = globalThis.__esbuild_esm_mermaid_nm = globalThis.__esbuild_esm_mermaid_nm || {};')
    .replace('(__esbuild_esm_mermaid_nm||={}).mermaid=', '__esbuild_esm_mermaid_nm.mermaid=')
    .replace('globalThis.__esbuild_esm_mermaid_nm["mermaid"].default',
        '__esbuild_esm_mermaid_nm.mermaid.default');
w.eval(mermaidWrapped);

if (typeof w.mermaid !== 'object' || typeof w.mermaid.render !== 'function') {
    throw new Error('mermaid 未装载');
}

// SVG 测量 API polyfill
const SVGProto = w.SVGElement.prototype;
function numAttr(el, a) { return parseFloat(el.getAttribute(a)) || 0; }
function fontPxOf(el) { try { return parseFloat(w.getComputedStyle(el).fontSize) || 14; } catch (_) { return 14; } }
SVGProto.getBBox = function () {
    const tag = this.tagName.toLowerCase();
    if (tag === 'rect') return { x: numAttr(this,'x'), y: numAttr(this,'y'), width: numAttr(this,'width'), height: numAttr(this,'height') };
    if (tag === 'circle') { const r = numAttr(this,'r'); return { x: numAttr(this,'cx')-r, y: numAttr(this,'cy')-r, width: 2*r, height: 2*r }; }
    if (tag === 'ellipse') { const rx = numAttr(this,'rx'), ry = numAttr(this,'ry'); return { x: numAttr(this,'cx')-rx, y: numAttr(this,'cy')-ry, width: 2*rx, height: 2*ry }; }
    if (tag === 'line') { const x1=numAttr(this,'x1'),y1=numAttr(this,'y1'),x2=numAttr(this,'x2'),y2=numAttr(this,'y2'); return { x: Math.min(x1,x2), y: Math.min(y1,y2), width: Math.abs(x2-x1)||1, height: Math.abs(y2-y1)||1 }; }
    if (tag === 'text' || tag === 'tspan') { const fp = fontPxOf(this); const text = this.textContent || ''; return { x: numAttr(this,'x')||0, y: (numAttr(this,'y')||0)-fp, width: Math.max(text.length,1)*fp*0.6, height: fp*1.2 }; }
    if (tag === 'path') return { x:0, y:0, width:100, height:100 };
    return { x:0, y:0, width:50, height:20 };
};
SVGProto.getComputedTextLength = function () { return (this.textContent||'').length * fontPxOf(this) * 0.6; };
SVGProto.getTotalLength = function () { return 100; };
SVGProto.getPointAtLength = function (d) { return { x: d, y: 0 }; };
SVGProto.getCTM = function () { return { a:1,b:0,c:0,d:1,e:0,f:0 }; };
SVGProto.getScreenCTM = function () { return { a:1,b:0,c:0,d:1,e:0,f:0 }; };

// 库装载：剥 export 行，把 svgElementToVsdx 挂到 window
const visioStripped = VISIO_SRC.replace(/export\s*\{[^}]+\};?/m, '');
w.eval(visioStripped + '\nwindow.__svgElementToVsdx = svgElementToVsdx;');

(async () => {
    w.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'default',
        flowchart: { htmlLabels: false, useMaxWidth: false }
    });

    // 用和真实用户场景一致的简单中文 flowchart（保持窄，确保不被 useMaxWidth 压成怪形状）
    const DEFINITION = `flowchart TD
    A[开始] --> B{是否通过}
    B -->|是| C[生成报告]
    B -->|否| D[重新审核]
    C --> E[结束]
    D --> B`;

    console.log('=== 1) mermaid.render 输出 ===');
    const result = await w.mermaid.render('probe-' + Date.now(), DEFINITION);
    const svgString = typeof result === 'string' ? result : result && result.svg;
    if (!svgString) throw new Error('mermaid 未产出 svg');
    console.log('svgString.length =', svgString.length);

    // 落盘：用户肉眼检查 + 我后续比对的真源
    fs.writeFileSync('/tmp/visio-probe.svg', svgString);
    console.log('落盘到 /tmp/visio-probe.svg');

    // === 2) 体检：SVG 到底有什么 shape 类元素，inline style 长啥样 ===
    const holder = w.document.getElementById('holder');
    holder.innerHTML = svgString;
    const svgEl = holder.querySelector('svg');
    if (!svgEl) throw new Error('未找到 svg');

    const tagCounts = {};
    const styleSamples = [];
    const csSamples = [];
    svgEl.querySelectorAll('rect, path, polygon, polyline, circle, ellipse, line, text, g, foreignObject').forEach((n) => {
        const t = n.tagName.toLowerCase();
        tagCounts[t] = (tagCounts[t] || 0) + 1;
        if (['rect','path','polygon','circle','ellipse','line','text'].includes(t)) {
            const cs = w.getComputedStyle(n);
            const inline = (n.getAttribute('style') || '').slice(0, 80);
            const attrFill = n.getAttribute('fill'), attrStroke = n.getAttribute('stroke');
            if (styleSamples.length < 6) styleSamples.push({ tag: t, attrFill, attrStroke, inline });
            if (csSamples.length < 6) csSamples.push({ tag: t, csFill: cs.fill, csStroke: cs.stroke, csDisplay: cs.display });
        }
    });
    console.log('\n=== 2) SVG 结构 ===');
    console.log('viewBox =', svgEl.getAttribute('viewBox'));
    console.log('tagCounts =', JSON.stringify(tagCounts));
    console.log('前 6 个 shape 的 attr/inline style:');
    for (const s of styleSamples) console.log('  ', JSON.stringify(s));
    console.log('前 6 个 shape 的 getComputedStyle fill/stroke:');
    for (const s of csSamples) console.log('  ', JSON.stringify(s));

    // === 3) 喂库 ===
    console.log('\n=== 3) 库运行结果 ===');
    const out = await w.__svgElementToVsdx(svgEl, { title: 'flowchart-probe' });
    console.log('stats =', JSON.stringify(out && out.stats));
    console.log('bytes.length =', out && out.bytes && out.bytes.length);

    fs.writeFileSync('/tmp/visio-probe.vsdx', Buffer.from(out.bytes.buffer, out.bytes.byteOffset, out.bytes.byteLength));
    console.log('落盘到 /tmp/visio-probe.vsdx');

    // === 4) 体检：库的 page1.xml 有几个 ===
    const listing = execSync('unzip -l /tmp/visio-probe.vsdx', { encoding: 'utf8' });
    const lines = listing.split('\n').filter(l => /visio|pages|_rels|Content/i.test(l));
    console.log('\n=== 4) unzip -l ===');
    console.log(lines.join('\n'));

    try {
        const page1 = execSync('unzip -p /tmp/visio-probe.vsdx visio/pages/page1.xml', { encoding: 'utf8' });
        const shapeCount = (page1.match(/<Shape\s/g) || []).length;
        const textCount = (page1.match(/<Text>/g) || []).length;
        console.log('page1.xml <Shape> 数 =', shapeCount);
        console.log('page1.xml <Text> 数 =', textCount);
    } catch (e) {
        console.log('unzip page1.xml 失败：', e.message);
    }

    dom.window.close();
})().catch((err) => {
    console.error('probe 失败：', err.stack || err.message || err);
    try { dom.window.close(); } catch (_) {}
    process.exit(1);
});