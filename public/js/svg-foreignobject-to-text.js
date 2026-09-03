/**
 * 把 mermaid 输出的 SVG 中的 `<foreignObject>` 子树扁平化为原生 `<text>` + `<tspan>`。
 *
 * 为什么需要：
 * mermaid 11.x 默认把 flowchart / stateDiagram-v2 / classDiagram / erDiagram /
 * pie / gantt / C4* 等图表的节点文字塞进 `<foreignObject><div xmlns=...xhtml>`。
 * 两条导出链路的消费方都不解析 XHTML 子树：
 *   - resvg-wasm（PNG 端）：SVG 1.1 子集实现，直接跳过 foreignObject
 *   - @klyratech/mermaid-to-visio（Visio 端）：captureSvgToDisplayList 只 walk
 *     `<text>` + 7 种基本图元，遇到 `<div>` 直接丢
 * 因此 mindmap / sequence / gitGraph / journey / timeline 等类型默认用 `<text>`
 * 无需转换；其他类型全部需要走这一步。
 *
 * 设计要点：
 * - 纯 regex + 字符串处理：避免引入 @xmldom/xmldom 等新依赖（CLAUDE.md 强调简单
 *   至上，npm install 会污染 package.json 与 lockfile）；regex 匹配
 *   `<foreignObject>...</foreignObject>` 非贪婪块，对 vendored mermaid 11.16.1
 *   的固定输出结构可靠
 * - 解析失败返回原串：上游 resvg/visio 库自身有兜底（vsdx 空但 OPC 合法 / resvg 报错
 *   而非崩溃），不抛错避免传导
 * - 几何复刻：foreignObject 的 (x,y,width,height) 当作可视文本盒，cx=x+w/2，
 *   cy=y+h/2；首行 baseline = y + (h - totalHeight)/2 + fontSize*0.85（SVG <text>
 *   的 y 是 baseline）；后续行用 <tspan dy=lineHeight> 累加
 * - 多行处理：`<p>` 子元素 → 每 `<p>` 一行；否则按 `<br>` 切；否则整段是一行
 * - 字体属性：取 foreignObject 内首个有 style 属性的元素（div/p）解析 font-* /
 *   color，回退到 SVG 根节点的同名属性，再回退默值（14px / #333 / normal）
 */

// 匹配一个完整 <foreignObject ...>...</foreignObject> 块（非贪婪、跨行）
const FO_BLOCK_RE = /<foreignObject\b([^>]*)>([\s\S]*?)<\/foreignObject>/gi;

function attrOf(tag, name) {
    const re = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i');
    const m = tag.match(re);
    return m ? m[1] : null;
}

function decodeEntities(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function cssGet(styleStr, prop) {
    if (!styleStr) return null;
    const re = new RegExp('(^|[\\s;])' + prop + '\\s*:\\s*([^;]+)', 'i');
    const m = styleStr.match(re);
    return m ? m[2].trim() : null;
}

function pickTextStyle(styles) {
    // styles: [{styleStr, classNames}]，越靠前越优先
    for (const s of styles) {
        if (!s.styleStr) continue;
        const ff = cssGet(s.styleStr, 'font-family');
        const fs = cssGet(s.styleStr, 'font-size');
        const fw = cssGet(s.styleStr, 'font-weight');
        const c = cssGet(s.styleStr, 'color');
        if (ff || fs || fw || c) {
            return { fontFamily: ff, fontSize: fs, fontWeight: fw, color: c };
        }
    }
    return { fontFamily: null, fontSize: null, fontWeight: null, color: null };
}

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function round(n) {
    return Math.round(n * 100) / 100;
}

function stripInlineTags(line) {
    // 把 <br> / <br/> 转成 \n 占位；其他内联标签（span/b/i 等）剥掉只留文本
    let s = line.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    return s;
}

function extractLines(innerHtml) {
    // 1) 剥外层 <div ...>...</div> 包裹（可能带 xmlns / style / class）
    let body = innerHtml;
    const divMatch = body.match(/^\s*<div\b[^>]*>([\s\S]*)<\/div>\s*$/i);
    if (divMatch) body = divMatch[1];

    // 2) 优先按 <p> 切（每段 = 一行）
    const pMatches = [];
    const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRe.exec(body)) !== null) pMatches.push(m[1]);
    if (pMatches.length > 0) {
        return pMatches
            .map(stripInlineTags)
            .flatMap((s) => s.split('\n'))
            .map((s) => decodeEntities(s).trim())
            .filter(Boolean);
    }

    // 3) 否则按 <br> 切
    const brSplit = decodeEntities(stripInlineTags(body))
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    if (brSplit.length > 1) return brSplit;

    // 4) 兜底：整段是一行
    const single = decodeEntities(stripInlineTags(body)).trim();
    return single ? [single] : [];
}

function collectStyleSources(innerHtml) {
    // 收集 foreignObject 里所有 div/p 标签的 style 与 class（越靠前越优先）
    const sources = [];
    const tagRe = /<(div|p)\b([^>]*)>/gi;
    let m;
    while ((m = tagRe.exec(innerHtml)) !== null) {
        const styleMatch = m[2].match(/\bstyle\s*=\s*"([^"]*)"/i);
        const classMatch = m[2].match(/\bclass\s*=\s*"([^"]*)"/i);
        sources.push({
            tag: m[1],
            styleStr: styleMatch ? decodeEntities(styleMatch[1]) : null,
            classNames: classMatch ? classMatch[1] : null
        });
    }
    return sources;
}

function rootSvgAttrs(svgString) {
    const m = svgString.match(/<svg\b([^>]*)>/i);
    return m ? m[1] : '';
}

function convertForeignObjectToText(svgString) {
    if (typeof svgString !== 'string' || !svgString) return svgString;
    // 没有 foreignObject 直接返回，避免无谓正则扫描
    if (!/<foreignObject\b/i.test(svgString)) return svgString;

    const svgAttrs = rootSvgAttrs(svgString);
    const rootFontFamily = attrOf(svgAttrs, 'font-family');
    const rootFontSize = attrOf(svgAttrs, 'font-size');
    const rootFill = attrOf(svgAttrs, 'fill') || attrOf(svgAttrs, 'color');

    return svgString.replace(FO_BLOCK_RE, (_match, attrs, inner) => {
        const x = parseFloat(attrOf(attrs, 'x') || '0') || 0;
        const y = parseFloat(attrOf(attrs, 'y') || '0') || 0;
        const w = parseFloat(attrOf(attrs, 'width') || '0') || 0;
        const h = parseFloat(attrOf(attrs, 'height') || '0') || 0;

        const lines = extractLines(inner);
        if (lines.length === 0) return ''; // 空 foreignObject 直接剔除

        // 字体属性：优先 foreignObject 内部样式，其次 SVG 根属性，再回退默值
        const styleSources = collectStyleSources(inner);
        const picked = pickTextStyle(styleSources);
        const fontFamily = picked.fontFamily || rootFontFamily || 'Arial';
        const fontSize = parseFloat(picked.fontSize || rootFontSize) || 14;
        const fill = picked.color || rootFill || '#333333';
        const fontWeight = picked.fontWeight || 'normal';

        // 几何分两种情形：
        //
        // (1) box-in-fo：FO 自带 width>0 && height>0（如手写 SVG / 旧版 mermaid），
        //     文本盒由 FO 自己的 (x,y,w,h) 决定 → 中心对齐 FO 中心。
        //
        // (2) real mermaid 11.16.1：FO 是 `<foreignObject width="0" height="0">` 的
        //     占位容器，文本位置由父 `<g class="label" transform="translate(0,0)">`
        //     与更外层 `<g class="node default" transform="translate(...)">` 决定。
        //     此时我们只输出父 <g> 局部坐标内的居中文本（cx=0，baseline 按 fontSize
        //     与行数居中），让父级 transform 把整组文字移到根坐标。
        //
        // 不统一处理的原因：(1) 与 (2) 的几何参照系不同——前者的 (x,y,w,h) 是 SVG
        // 根坐标，后者是父 g 局部坐标；混用会让 text 跑到错的根坐标位置。
        const lineHeight = Math.round(fontSize * 1.2);
        const totalHeight = lineHeight * lines.length;
        const foHasBox = w > 0 && h > 0;

        let cx, firstBaselineY;
        if (foHasBox) {
            cx = round(x + w / 2);
            firstBaselineY = round(y + (h - totalHeight) / 2 + fontSize * 0.85);
        } else {
            // 父 g 局部坐标内居中：text 视觉中心 = (0, 0)
            // 单行 baseline ≈ fontSize * 0.25（让 ascent+descent 包住 0）
            // 多行第一行 baseline ≈ -totalHeight/2 + fontSize * 0.85（顶对齐 + ascent）
            cx = 0;
            firstBaselineY = round(-totalHeight / 2 + fontSize * 0.85);
        }

        const textOpen = (
            `<text x="${cx}" y="${firstBaselineY}" text-anchor="middle"` +
            ` font-family="${escapeAttr(fontFamily)}"` +
            ` font-size="${fontSize}"` +
            ` font-weight="${escapeAttr(fontWeight)}"` +
            ` fill="${escapeAttr(fill)}">`
        );

        if (lines.length === 1) {
            return textOpen + escapeText(lines[0]) + '</text>';
        }

        // 多行：第一行 y 已在 text 上设，后续 tspan 用 dy 累加
        const tspans = lines.map((ln, i) => {
            const dy = i === 0 ? '0' : String(lineHeight);
            return `<tspan x="${cx}" dy="${dy}">${escapeText(ln)}</tspan>`;
        }).join('');
        return textOpen + tspans + '</text>';
    });
}

// 浏览器端暴露到 window，供 export.js 在 Visio 导出链路里调用。
// 与服务端 src/utils/svgForeignObjectToText.js 逻辑完全一致（同一份纯函数，
// 零依赖即可跨 Node / 浏览器复用；保留两份独立文件以避免模块加载链路分支）。
if (typeof window !== 'undefined') {
    window.svgForeignObjectToText = { convertForeignObjectToText };
}