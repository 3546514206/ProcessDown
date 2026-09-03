/**
 * Standalone test for the rewritten ExportService.
 * Generates a PNG from Mermaid-style SVGs (含 foreignObject 节点) and writes them
 * to /tmp/export-test-*.png for visual inspection.
 *
 * 手写 SVG 模拟 mermaid 11.x 输出的常见图表类型（flowchart / stateDiagram-v2 /
 * classDiagram / erDiagram / pie / gantt）的节点文字形态——全部走 <foreignObject>。
 * 验证 src/services/export.js 在 PNG 出口前调用 convertForeignObjectToText 把
 * foreignObject 归一化为 <text> + <tspan>，避免 SVG 1.1 子集实现直接跳过
 * foreignObject 导致文字丢失。
 */

const path = require('path');
const fs = require('fs');
const ExportService = require('../src/services/export');
const logger = require('../src/utils/logger');

logger.setLevel('debug');

// 通用 SVG header（mermaid 默认 viewBox 与 font-family）
const svgOpen = (vbW, vbH) =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${vbW}" height="${vbH}" ` +
    `viewBox="0 0 ${vbW} ${vbH}" font-family="trebuchet ms,verdana,arial,sans-serif" ` +
    `font-size="14">`;

// 模拟 mermaid 节点文字：被包在 foreignObject > div > p 里
const foNode = (x, y, w, h, text) =>
    `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:trebuchet ms;font-size:14px;color:#fff">` +
    `<p>${text}</p>` +
    `</div></foreignObject>`;

const samples = [
    // flowchart LR + 中文节点
    {
        name: 'flowchart',
        svg: svgOpen(500, 240) +
            `<rect x="0" y="0" width="500" height="240" fill="#1e1e36"/>` +
            `<rect x="40" y="40" width="120" height="50" rx="6" fill="#4a4a7a" stroke="#aaa" stroke-width="2"/>` +
            foNode(40, 40, 120, 50, '用户登录') +
            `<rect x="220" y="40" width="120" height="50" rx="6" fill="#4a4a7a" stroke="#aaa" stroke-width="2"/>` +
            foNode(220, 40, 120, 50, '验证信息') +
            `<line x1="160" y1="65" x2="220" y2="65" stroke="#aaa" stroke-width="2"/>` +
            `<polygon points="380,170 420,140 460,170 420,200" fill="#5a5a8a" stroke="#aaa" stroke-width="2"/>` +
            foNode(380, 140, 80, 60, '是否通过') +
            `</svg>`
    },

    // stateDiagram-v2：起始/结束符 + 状态节点
    {
        name: 'state',
        svg: svgOpen(500, 200) +
            `<rect x="0" y="0" width="500" height="200" fill="#fff"/>` +
            `<circle cx="50" cy="100" r="20" fill="#fff" stroke="#333" stroke-width="2"/>` +
            foNode(30, 80, 40, 40, '[*]') +
            `<rect x="120" y="80" width="100" height="40" rx="4" fill="#ECECFF" stroke="#9370DB"/>` +
            foNode(120, 80, 100, 40, '待处理') +
            `<rect x="260" y="80" width="100" height="40" rx="4" fill="#ECECFF" stroke="#9370DB"/>` +
            foNode(260, 80, 100, 40, '处理中') +
            `<line x1="70" y1="100" x2="120" y2="100" stroke="#333"/>` +
            `<line x1="220" y1="100" x2="260" y2="100" stroke="#333"/>` +
            `</svg>`
    },

    // classDiagram：类框 + 多行属性（多 <p> 切行）
    {
        name: 'class',
        svg: svgOpen(500, 240) +
            `<rect x="0" y="0" width="500" height="240" fill="#fff"/>` +
            `<rect x="40" y="40" width="160" height="100" fill="#ECECFF" stroke="#9370DB"/>` +
            `<foreignObject x="40" y="40" width="160" height="100">` +
            `<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial;font-size:12px;color:#333">` +
            `<p>用户类</p>` +
            `<p>+ id : int</p>` +
            `<p>+ name : String</p>` +
            `<p>+ login() : bool</p>` +
            `</div></foreignObject>` +
            `<rect x="280" y="40" width="160" height="60" fill="#ECECFF" stroke="#9370DB"/>` +
            foNode(280, 40, 160, 60, '订单类') +
            `</svg>`
    },

    // erDiagram：实体块 + 多行字段
    {
        name: 'er',
        svg: svgOpen(500, 200) +
            `<rect x="0" y="0" width="500" height="200" fill="#fff"/>` +
            `<rect x="40" y="40" width="180" height="80" fill="#fff" stroke="#333"/>` +
            `<foreignObject x="40" y="40" width="180" height="80">` +
            `<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial;font-size:11px;color:#333">` +
            `<p>USER</p>` +
            `<p>PK id : int</p>` +
            `<p>username : string</p>` +
            `</div></foreignObject>` +
            `<line x1="220" y1="80" x2="280" y2="80" stroke="#333"/>` +
            `</svg>`
    },

    // pie：扇形 + 文字标签
    {
        name: 'pie',
        svg: svgOpen(400, 300) +
            `<rect x="0" y="0" width="400" height="300" fill="#fff"/>` +
            `<circle cx="200" cy="150" r="100" fill="#ECECFF" stroke="#9370DB"/>` +
            foNode(200, 145, 100, 30, 'A 50%') +
            `</svg>`
    },

    // gantt：任务条 + 标签
    {
        name: 'gantt',
        svg: svgOpen(600, 200) +
            `<rect x="0" y="0" width="600" height="200" fill="#fff"/>` +
            `<rect x="100" y="60" width="200" height="20" fill="#9370DB"/>` +
            foNode(100, 50, 200, 40, '需求调研') +
            `</svg>`
    }
];

(async () => {
    const exportService = new ExportService({});

    for (const sample of samples) {
        for (const scale of [1, 2]) {
            const pngBuffer = await exportService.svgToPng(sample.svg, scale, '#ffffff');
            const outPath = path.join('/tmp', `export-test-${sample.name}-${scale}x.png`);
            fs.writeFileSync(outPath, pngBuffer);
            console.log(`[${sample.name} ${scale}x] PNG saved: ${outPath}, size=${pngBuffer.length} bytes`);
        }
    }

    console.log('\nAll samples done. 打开 /tmp/export-test-*-*.png 人眼检查文字是否清晰可读。');
})().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});