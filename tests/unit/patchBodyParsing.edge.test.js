/**
 * 回归：server/index.js 曾只对 POST 调 parseBody，导致
 * PATCH /api/session/:id/diagram 的 req.body 恒为 undefined，patchDiagram 必 400，
 * 整个就地编辑特性在生产环境完全失效。既有测试直接调 router.patchDiagram 并手工
 * 塞 body，绕过了中间件链，所以全绿也没发现。
 *
 * 这里用源码正则断言中间件链确实覆盖 PATCH——server/index.js require 即 boot+listen，
 * 无法直接导入（与 protectedRoutes.edge.test.js 同一约定）。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'server', 'index.js'), 'utf8'
);

describe('server/index.js: PATCH 请求体必须被解析', () => {
    it('parseBody 的方法守卫包含 PATCH', () => {
        const guard = SERVER_SOURCE.match(/if \(req\.method === 'POST'[^)]*\) \{\s*\n\s*try \{\s*\n\s*req\.body = await parseBody\(req\)/);
        assert.ok(guard, '未找到 parseBody 的方法守卫，说明结构已变，请同步本测试');
        assert.match(guard[0], /PATCH/,
            "parseBody 必须同时覆盖 PATCH，否则 patchDiagram 永远拿不到 body");
    });

    it('PATCH 的 diagram 路由仍在 dispatch 默认分支里', () => {
        assert.match(SERVER_SOURCE,
            /\/\^\\\/api\\\/session\\\/\[\^\/\]\+\\\/diagram\$\/\.test\(parsedUrl\.pathname\) && req\.method === 'PATCH'/);
    });
});
