/**
 * convertForeignObjectToText 服务端单元测试（node:test）
 *
 * 覆盖场景：
 *  1. 单行文字 foreignObject → 转换为单个 <text>
 *  2. 多行 <p> foreignObject → <text> + 多个 <tspan x dy>
 *  3. 多个 foreignObject 同时存在 → 全部转换
 *  4. 含 <br> 的 foreignObject → 按 <br> 切行
 *  5. 字体属性提取（font-size / font-weight / color / font-family）
 *  6. 空 foreignObject → 直接移除
 *  7. 非法/异常 SVG → 返回原字符串（不抛错）
 *  8. SVG 顶层结构与命名空间不被破坏
 *  9. viewBox 保留
 * 10. 已有原生 <text> 不受影响（仅替换 foreignObject）
 *
 * 跑法：npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { convertForeignObjectToText } = require('../../src/utils/svgForeignObjectToText');

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">';
const SVG_CLOSE = '</svg>';

describe('convertForeignObjectToText 服务端单元测试', () => {
    it('单行文字 foreignObject 转为单个 <text>', () => {
        const input = SVG_OPEN +
            '<foreignObject x="10" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial;font-size:14px;color:#333">' +
            '<p>用户登录</p>' +
            '</div>' +
            '</foreignObject>' +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        assert.ok(!/<foreignObject/i.test(out), '不应再含 foreignObject');
        assert.ok(/<text\b[^>]*>用户登录<\/text>/.test(out), '应包含文字"用户登录"');
        // 中心 x = 10 + 80/2 = 50，text-anchor=middle
        assert.ok(/<text\b[^>]*x="50"/.test(out), '中心 x 应为 50');
        assert.ok(/<text\b[^>]*text-anchor="middle"/.test(out), 'text-anchor 应为 middle');
        // 字号 14 应保留
        assert.ok(/<text\b[^>]*font-size="14"/.test(out), 'font-size 应保留');
        // 单行不应产生 tspan
        assert.ok(!/<tspan\b/i.test(out), '单行不应出现 <tspan>');
    });

    it('多行 <p> 转为 <text> + 多个 <tspan x dy>', () => {
        const input = SVG_OPEN +
            '<foreignObject x="10" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial;font-size:14px;color:#333">' +
            '<p>测试中文 A</p>' +
            '<p>测试中文 B</p>' +
            '</div>' +
            '</foreignObject>' +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        assert.ok(!/<foreignObject/i.test(out), '不应再含 foreignObject');
        const tspanMatches = out.match(/<tspan\b[^>]*>[^<]*<\/tspan>/g) || [];
        assert.equal(tspanMatches.length, 2, '应有 2 个 tspan（2 行），实际 ' + tspanMatches.length);
        assert.ok(tspanMatches.some((t) => />测试中文 A</.test(t)), '应包含"测试中文 A"');
        assert.ok(tspanMatches.some((t) => />测试中文 B</.test(t)), '应包含"测试中文 B"');
        // 每个 tspan 都有 x 属性（vendored visio 库按 x 属性切行）+ dy
        assert.ok(tspanMatches.every((t) => /\bx="\d+/.test(t) && /\bdy="\d+/.test(t)),
            '每个 tspan 必须有 x 与 dy 属性');
    });

    it('多个 foreignObject 同时存在，全部转换', () => {
        const input = SVG_OPEN +
            '<foreignObject x="10" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:14px">' +
            '<p>节点 A</p>' +
            '</div>' +
            '</foreignObject>' +
            '<rect x="100" y="10" width="20" height="20" fill="#ccc"/>' +
            '<foreignObject x="50" y="60" width="100" height="30">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:12px">' +
            '<p>节点 B</p>' +
            '</div>' +
            '</foreignObject>' +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        assert.equal((out.match(/<foreignObject/gi) || []).length, 0, '两个 foreignObject 都应被转换');
        assert.ok(out.includes('节点 A'), '应保留"节点 A"');
        assert.ok(out.includes('节点 B'), '应保留"节点 B"');
        assert.ok(/<rect\b/.test(out), '中间的 <rect> 不应被破坏');
    });

    it('含 <br> 的 foreignObject 按 <br> 切行', () => {
        const input = SVG_OPEN +
            '<foreignObject x="10" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:14px">' +
            'Line1<br/>Line2<br/>Line3' +
            '</div>' +
            '</foreignObject>' +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        const tspanMatches = out.match(/<tspan\b[^>]*>[^<]*<\/tspan>/g) || [];
        assert.equal(tspanMatches.length, 3, '<br> 应切出 3 行，实际 ' + tspanMatches.length);
        assert.ok(tspanMatches.some((t) => />Line1</.test(t)));
        assert.ok(tspanMatches.some((t) => />Line2</.test(t)));
        assert.ok(tspanMatches.some((t) => />Line3</.test(t)));
    });

    it('字体属性提取：font-size / font-weight / color / font-family', () => {
        const input = SVG_OPEN +
            '<foreignObject x="10" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Verdana,sans-serif;font-size:18px;font-weight:bold;color:#ff0000">' +
            '<p>Styled</p>' +
            '</div>' +
            '</foreignObject>' +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        // font-family 取第一个（库端 split(",")[0]），但这里我们直接写完整到属性里
        assert.ok(/<text\b[^>]*font-family="[^"]*"/.test(out), 'font-family 属性应存在');
        assert.ok(/<text\b[^>]*font-size="18"/.test(out), 'font-size=18 应保留');
        assert.ok(/<text\b[^>]*font-weight="bold"/.test(out), 'font-weight=bold 应保留');
        assert.ok(/<text\b[^>]*fill="#ff0000"/.test(out), 'color 应转为 fill="#ff0000"');
    });

    it('空 foreignObject 直接移除', () => {
        const input = SVG_OPEN +
            '<foreignObject x="10" y="10" width="80" height="40"></foreignObject>' +
            '<foreignObject x="50" y="60" width="80" height="40"><div xmlns="http://www.w3.org/1999/xhtml"></div></foreignObject>' +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        assert.equal((out.match(/<foreignObject/gi) || []).length, 0, '两个空 foreignObject 都应被移除');
        assert.equal((out.match(/<text\b/gi) || []).length, 0, '空 foreignObject 不应产生 <text>');
        // svg 根标签本身仍保留
        assert.ok(out.startsWith('<svg'), 'svg 根标签应保留');
        assert.ok(out.endsWith('</svg>'), 'svg 闭合标签应保留');
    });

    it('非法/异常输入返回原字符串，不抛错', () => {
        // null / undefined / 空串 / 非字符串：均不应抛错
        assert.equal(convertForeignObjectToText(null), null);
        assert.equal(convertForeignObjectToText(undefined), undefined);
        assert.equal(convertForeignObjectToText(''), '');
        assert.equal(convertForeignObjectToText(123), 123, '非字符串原样返回');

        // 含 unclosed foreignObject（异常情况）：不应抛错
        const broken = '<svg><foreignObject x="1" y="2" width="3" height="4"><div>oops';
        assert.doesNotThrow(() => convertForeignObjectToText(broken));
    });

    it('SVG 顶层结构与命名空间不被破坏', () => {
        const input =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100">' +
            '<foreignObject x="10" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:14px"><p>test</p></div>' +
            '</foreignObject>' +
            '</svg>';

        const out = convertForeignObjectToText(input);

        // 顶层声明保留
        assert.ok(out.startsWith('<?xml'), 'xml 声明应保留');
        assert.ok(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(out), 'svg 命名空间应保留');
        assert.ok(/xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/.test(out), 'xlink 命名空间应保留');
        // XHTML 命名空间应消失（已经被扁平化）
        assert.ok(!/xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/.test(out), 'XHTML 命名空间应被移除');
    });

    it('viewBox 保留', () => {
        const input = SVG_OPEN +
            '<foreignObject x="10" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml"><p>test</p></div>' +
            '</foreignObject>' +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        assert.ok(/viewBox="0 0 200 100"/.test(out), 'viewBox 应原样保留');
    });

    it('已有原生 <text> 不受影响（仅替换 foreignObject）', () => {
        const input = SVG_OPEN +
            '<text x="10" y="50" font-size="12" fill="#999">原有文本</text>' +
            '<foreignObject x="100" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:14px"><p>新文本</p></div>' +
            '</foreignObject>' +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        // 原 <text> 应保留
        assert.ok(/<text\b[^>]*x="10"[^>]*>原有文本<\/text>/.test(out),
            '原有 <text x="10">应原样保留');
        // 新增的转换后 <text> 来自 foreignObject
        assert.ok(/原有文本/.test(out) && /新文本/.test(out), '原文本与新文本都应存在');
        // 应有 2 个 <text>
        const textMatches = out.match(/<text\b/g) || [];
        assert.equal(textMatches.length, 2, '应有 2 个 <text>（原 1 + 转换 1）');
    });

    it('rootSvgAttrs 回退：无内联样式时使用 SVG 根属性', () => {
        // svg 根有 font-family，foreignObject 内部没设字体 → 应回退到根属性
        const input =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" font-family="Verdana" font-size="20">' +
            '<foreignObject x="10" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml"><p>root</p></div>' +
            '</foreignObject>' +
            '</svg>';

        const out = convertForeignObjectToText(input);

        assert.ok(/<text\b[^>]*font-family="Verdana"/.test(out),
            '无内联样式时应回退到 SVG 根 font-family="Verdana"');
        assert.ok(/<text\b[^>]*font-size="20"/.test(out),
            '无内联样式时应回退到 SVG 根 font-size=20');
    });

    it('无 foreignObject 的输入原样返回（零开销快路径）', () => {
        const input = SVG_OPEN +
            '<rect x="10" y="10" width="80" height="40" fill="#abc"/>' +
            '<text x="50" y="40">pure text</text>' +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        assert.equal(out, input, '不含 foreignObject 应原样返回');
    });

    it('XHTML 实体（&amp; &lt; &gt; &quot;）正确处理：解码后再次 XML 转义输出', () => {
        // decode 是中间步骤（让文本可处理），最终 SVG 输出必须再次 XML 转义防止结构破坏
        const input = SVG_OPEN +
            '<foreignObject x="10" y="10" width="80" height="40">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:14px">' +
            '<p>A &amp; B</p>' +
            '<p>&lt;tag&gt;</p>' +
            '</div>' +
            '</foreignObject>' +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        // &amp; 不应双重转义为 &amp;amp;（这才是真正的 bug 信号）
        assert.ok(!/&amp;amp;/.test(out), '不应双重转义 &amp; 为 &amp;amp;');
        assert.ok(!/&amp;lt;/.test(out), '不应双重转义 &lt; 为 &amp;lt;');
        assert.ok(!/&amp;gt;/.test(out), '不应双重转义 &gt; 为 &amp;gt;');
        // 文本内容应正确呈现：& 是合法字符，< > 必须再次转义为 XML 实体
        assert.ok(/A &amp; B/.test(out), '& 应在输出中正确呈现为 &amp;');
        assert.ok(/&lt;tag&gt;/.test(out), '<tag> 在输出中应再次转义为 &lt;tag&gt;');
    });
});

// === 真实 mermaid 11.16.1 输出结构回归测试 ====================================
// 这些是受影响的图表类型——mermaid 11.x 默认把节点文字塞进 `<foreignObject>`，
// 而我们的方案就是把它们扁平化为 `<text>/<tspan>`。下面的 SVG 片段直接照搬
// `/tmp/mermaid-probe/svg-*-A-default.svg` 里的实际结构（FO width="0" height="0"，
// 外层 `<g class="label" transform="translate(0,0)">`，div 套 span 套 p）。
// 断言重点：转换后不再含 `<foreignObject>`，文字内容保留，text 落在父 g 局部原点。
describe('真实 mermaid 11.16.1 输出结构回归（5 类受 foreignObject 影响）', () => {
    // 通用：real mermaid 输出的父 g + 零尺寸 FO 容器模板
    const wrap = (gAttrs, pText) =>
        `<g ${gAttrs}>` +
        `<foreignObject width="0" height="0">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; white-space: nowrap; line-height: 1.5; text-align: center;">` +
        `<span><p>${pText}</p></span>` +
        `</div></foreignObject></g>`;

    it('flowchart 节点文字（real mermaid FO width=0 height=0）应正确扁平化', () => {
        const input = SVG_OPEN + wrap('class="label" style="" transform="translate(0, 0)"', '开始') + SVG_CLOSE;
        const out = convertForeignObjectToText(input);

        assert.ok(!/<foreignObject/i.test(out), 'flowchart: 不应再含 foreignObject');
        assert.ok(!/<div\b/i.test(out), 'flowchart: XHTML div 应被剥离');
        assert.ok(/开始/.test(out), 'flowchart: 中文"开始"应保留');
        assert.ok(/<text\b[^>]*>/.test(out), 'flowchart: 应产出 <text>');
        // real mermaid FO width=0：父 g 局部坐标内居中 → cx=0
        assert.ok(/<text\b[^>]*x="0"/.test(out), 'flowchart: 父 g 局部原点 cx=0');
        assert.ok(/<text\b[^>]*text-anchor="middle"/.test(out), 'flowchart: text-anchor=middle');
        assert.ok(/<text\b[^>]*font-size="14"/.test(out), 'flowchart: font-size 14（默认）');
    });

    it('classDiagram 类名（real mermaid FO width=0 height=0）应正确扁平化', () => {
        // class label 有 style="font-weight: bolder" 在父 g 上，但 FO 内 div 没有 style
        // → text 应回退到 SVG 根 font 属性或默值
        const input = SVG_OPEN + wrap('class="label" style="font-weight: bolder" transform="translate(0,0)"', 'Animal') + SVG_CLOSE;
        const out = convertForeignObjectToText(input);

        assert.ok(!/<foreignObject/i.test(out), 'class: 不应再含 foreignObject');
        assert.ok(/Animal/.test(out), 'class: 类名"Animal"应保留');
        assert.ok(/<text\b[^>]*x="0"/.test(out), 'class: 父 g 局部原点 cx=0');
        // text 应被创建（即便内部 div 无显式 font-weight，父 g 的 bolder 通过 collectStyleSources 也收不到）
        assert.ok(/<text\b[^>]*>/.test(out), 'class: 应产出 <text>');
    });

    it('stateDiagram-v2 状态节点（real mermaid FO width=0 height=0）应正确扁平化', () => {
        const input = SVG_OPEN + wrap('class="label" style="" transform="translate(0, 0)"', '处理中') + SVG_CLOSE;
        const out = convertForeignObjectToText(input);

        assert.ok(!/<foreignObject/i.test(out), 'state: 不应再含 foreignObject');
        assert.ok(/处理中/.test(out), 'state: 中文"处理中"应保留');
        assert.ok(/<text\b[^>]*x="0"/.test(out), 'state: 父 g 局部原点 cx=0');
        assert.ok(/<text\b[^>]*text-anchor="middle"/.test(out), 'state: text-anchor=middle');
    });

    it('erDiagram 实体标签（real mermaid FO width=0 height=0）应正确扁平化', () => {
        // ER 边标签常见形态
        const input = SVG_OPEN + wrap('class="label" data-id="id_x_0" transform="translate(0, 0)"', 'places') + SVG_CLOSE;
        const out = convertForeignObjectToText(input);

        assert.ok(!/<foreignObject/i.test(out), 'er: 不应再含 foreignObject');
        assert.ok(/places/.test(out), 'er: 关系标签"places"应保留');
        assert.ok(/<text\b[^>]*x="0"/.test(out), 'er: 父 g 局部原点 cx=0');
    });

    it('blockDiagram 块名（real mermaid FO width=0 height=0）应正确扁平化', () => {
        // block div 没有 text-align: center，结构略有不同
        const input = SVG_OPEN +
            `<g class="label" style="" transform="translate(0, 0)">` +
            `<foreignObject width="0" height="0">` +
            `<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; white-space: nowrap; line-height: 1.5;">` +
            `<span><p>块A</p></span>` +
            `</div></foreignObject></g>` +
            SVG_CLOSE;
        const out = convertForeignObjectToText(input);

        assert.ok(!/<foreignObject/i.test(out), 'block: 不应再含 foreignObject');
        assert.ok(!/<div\b/i.test(out), 'block: XHTML div 应被剥离');
        assert.ok(/块A/.test(out), 'block: 中文"块A"应保留');
        assert.ok(/<text\b[^>]*x="0"/.test(out), 'block: 父 g 局部原点 cx=0');
    });

    it('完整 mermaid 节点组（节点 g + rect + label g + FO）端到端：转换后只剩 text', () => {
        // 模拟 mermaid flowchart 完整节点：父 g transform 决定根坐标，FO width=0
        // 父 <g> 与 <text> 的 getCTM 应把文本视觉中心落在节点中心（视觉对齐正确）
        const input = SVG_OPEN +
            `<g class="node default" id="A" transform="translate(133, 18)">` +
            `<rect class="basic label-container" x="-30" y="-15" width="60" height="30"/>` +
            `<g class="label" style="" transform="translate(0, 0)">` +
            `<rect></rect>` +
            `<foreignObject width="0" height="0">` +
            `<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; white-space: nowrap; line-height: 1.5; text-align: center;">` +
            `<span class="nodeLabel"><p>开始</p></span>` +
            `</div></foreignObject>` +
            `</g></g>` +
            SVG_CLOSE;

        const out = convertForeignObjectToText(input);

        assert.ok(!/<foreignObject/i.test(out), '完整节点：foreignObject 必须被扁平化');
        assert.ok(/<g class="node default"[^>]*transform="translate\(133, 18\)"/.test(out),
            '完整节点：父 <g> 及其 transform 必须保留');
        assert.ok(/<rect class="basic label-container"[^>]*x="-30"/.test(out),
            '完整节点：节点 rect 必须保留');
        assert.ok(/开始/.test(out), '完整节点：中文"开始"必须保留');
        // 文本 x=0（在父 label g 局部坐标系内）；父 label g 无 transform，再往上的父 g 把整组平移到 (133, 18)
        assert.ok(/<text\b[^>]*x="0"/.test(out),
            '完整节点：text x=0（在 label g 局部原点），父 transform 自然把视觉中心对齐到节点中心');
    });
});