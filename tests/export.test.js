/**
 * Standalone test for the rewritten ExportService.
 * Generates a PNG from a Mermaid-style SVG with Chinese text
 * and writes it to /tmp/export-test.png for visual inspection.
 */

const path = require('path');
const fs = require('fs');
const ExportService = require('../src/services/export');
const logger = require('../src/utils/logger');

logger.setLevel('debug');

const sampleSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="500" height="240" viewBox="0 0 500 240" font-family="trebuchet ms,verdana,arial,sans-serif" font-size="14">
  <rect x="0" y="0" width="500" height="240" fill="#1e1e36"/>
  <rect x="40" y="40" width="120" height="50" rx="6" fill="#4a4a7a" stroke="#aaa" stroke-width="2"/>
  <text x="100" y="70" text-anchor="middle" fill="#fff" font-family="trebuchet ms">用户登录</text>
  <rect x="220" y="40" width="120" height="50" rx="6" fill="#4a4a7a" stroke="#aaa" stroke-width="2"/>
  <text x="280" y="70" text-anchor="middle" fill="#fff">验证信息</text>
  <polygon points="160,170 200,140 240,170 200,200" fill="#5a5a8a" stroke="#aaa" stroke-width="2"/>
  <text x="200" y="175" text-anchor="middle" fill="#fff">是否通过</text>
  <line x1="100" y1="90" x2="100" y2="170" stroke="#aaa" stroke-width="2"/>
  <line x1="160" y1="170" x2="280" y2="90" stroke="#aaa" stroke-width="2" stroke-dasharray="4"/>
  <text x="100" y="135" fill="#fff" font-size="12">提交</text>
  <text x="220" y="135" fill="#fff" font-size="12">查询数据库</text>
</svg>`;

(async () => {
    const exportService = new ExportService({});

    for (const scale of [1, 2, 4]) {
        const pngBuffer = await exportService.svgToPng(sampleSvg, scale, '#1e1e36');
        const outPath = path.join('/tmp', `export-test-${scale}x.png`);
        fs.writeFileSync(outPath, pngBuffer);
        console.log(`[${scale}x] PNG saved: ${outPath}, size=${pngBuffer.length} bytes`);
    }

    console.log('All scales done.');
})().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
