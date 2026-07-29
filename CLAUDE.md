# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

无构建步骤、无 linter。要求 Node.js >= 18；唯一运行时依赖是 `@resvg/resvg-wasm`。

```bash
# 启动（需要 LLM_API_BASE_URL、LLM_API_KEY、LLM_MODEL 环境变量，或 .env 文件）
node src/server/index.js          # 前台运行
./bin/start.sh start              # 后台运行：start | stop | restart | status

# 测试（node:test，178 项）
npm test                          # 跑 tests/unit/ 全部单元测试
node tests/export.test.js         # 手动 PNG 渲染脚本（无断言，渲染到 /tmp 供肉眼检查）
```

配置通过 `src/config/loader.js` 里手写的解析器从 `.env` 加载（不依赖 dotenv）。将 `.env.example` 复制为 `.env`。`bin/start.sh` 只向子进程导出部分变量，但 `loader.js` 会自行重新读取 `.env`，因此**文件本身才是配置真源**，优先级高于脚本的 export 列表。

**用户管理**：不引入数据库，用户数据落盘到 `run/users/<username>/`。画图功能需先登录（注册/登录见前端登录遮罩）。

## 架构

### 请求管道（`src/server/index.js`）
单个 `http.createServer` 跑一条手写的中间件链：`cors -> rateLimit -> auth -> validator -> parseBody -> [authUser] -> route`。每个中间件拒绝时同步 `res.end()`，链路在每步之后通过 `if (res.headersSent) return` 短路。静态文件（`/api/` 之外的路径）与 `/api/health`、`/api/config` 绕过鉴权。`parseBody` 先把 chunk 累积进 `Buffer` 再解码 UTF-8--刻意为之，为正确拼合跨 chunk 边界被切断的多字节中文字符--并按实际字节数强制 1MB 上限（validator 只检查 `Content-Length` 头，两层校验缺一不可）。

### 双层鉴权
两套正交的鉴权，叠加作用于 `/api/`：

1. **`auth.js`（X-API-Key，部署级，可选）**：由 `API_AUTH_KEY` 环境变量开启。作用于全部 `/api/`，但**跳过 `/api/health` 与 `/api/auth/*`**--否则设了 `API_AUTH_KEY` 后浏览器登录链路断（前端 `apiFetch` 不送 `X-API-Key`）。默认部署（未设 `API_AUTH_KEY`）下此层透传。
2. **`authUser.js`（Bearer token，用户登录态，必需）**：从 `Authorization: Bearer <token>` 提取，`userStore.verifyToken` 校验，成功注入 `req.user = username`，失败 401。仅作用于 `PROTECTED_USER_ROUTES`（见下）。`register`/`login`/`health`/`config` 不需要登录。

`PROTECTED_USER_ROUTES`（`server/index.js`）：`/api/generate`、`/api/regenerate`、`/api/export/png`、`/api/session`、`/api/session/check`、`/api/sessions`、`/api/auth/me`、`/api/auth/logout`。`regenerate`/`export/png` 同属"画图"语义，纳入保护以闭合"画图需先登录"的需求--否则默认部署下可被 curl 白嫖 LLM 或打 CPU。受保护路由在 switch 前先过 `authUser`，失败则 `headersSent` 短路，落不到 switch。

### 用户管理与认证（`src/services/userStore.js`）
文件系统后端的用户管理：每个用户在 `run/users/<username>/` 下拥有专有目录，含 `profile.json`（凭证 + 登录态）与 `sessions/<uuid>/history.json`（历史会话）。

- **username 白名单**：`/^[a-zA-Z0-9_-]{3,32}$/`，不含 `/ \ .. 空格`，`path.join(users.dir, username, ...)` 结构上不可逃出用户根目录。
- **密码**：`crypto.scryptSync(password, salt, 64)`，salt = `randomBytes(16)`，只存 hex hash + salt，**绝不落盘明文**。最小密码长度 6。
- **token**：`randomBytes(32).toString('hex')`（256 bit），下发给客户端的是 `${username}.${token}`（前缀含 username 方便后端定位用户文件），`profile.json` 只存 token 本身。`verifyToken` 拆出 username -> 读 profile -> `timingSafeEqual` 常量时间比较 -> `tokenIssuedAt + tokenTtlDays` 过期判定（`<=0` 永不过期）。
- **防枚举**：`login` 用户名/密码错误统一返回 `invalid_credentials`，不区分"用户不存在"与"密码错误"。`login` 的 `typeof password` 守卫位于 `_readProfile` 之后、`scryptSync` 之前--保持防枚举语义且杜绝 `TypeError -> 500`。
- **登录轮换**：`login` 每次签发新 token，旧 token 立即失效；`logout` 清空 `profile.token`。
- **`listSessions(username)`**：扫描 `sessions/*/history.json`，取首轮 user content 前 30 字作 summary，按 mtime 倒序，损坏会话跳过。供左侧抽屉渲染。

`profile.json` 结构：`{username, salt, passwordHash, token, tokenIssuedAt, createdAt, lastLoginAt}`。

### Mermaid 生成管道（`src/services/`）
`GeneratorService` 编排：`LLMService.chat`（OpenAI 兼容的 `/chat/completions`）-> `extractMermaidCode` -> `autoFixMermaidCode` -> `validateMermaidCode`。`src/services/extractor.js` 里的修复链是核心特性：剥离 `<think>` 推理标签、移除 emoji、把中文全角标点转成 ASCII、Tab 展开为 4 空格、并把错误包含 `else` 的 `opt` 块改写成 `alt`（通过基于栈的嵌套跟踪器匹配）。`LLMService` 用原生 `https`/`http`，按协议自动选择；`max_tokens` 在非正时（`-1` = 无限制）从 payload 中省略，这样开启 `<think>` 深度思考的慢模型不会在输出图表前就把 token 配额耗尽。

`/api/generate` 基于 `req.user` 派生该用户的 `SessionStore`（`sessionStoreFor(req)`），多轮 history 从用户会话目录读。无 `sessionId` 时不构造 per-user store，保持"无 sessionId 不落盘"的副作用边界。

### 会话（`src/services/sessionStore.js` + `src/routes/api.js`）
会话按用户落盘到 `run/users/<username>/sessions/<uuid>/history.json`（`[{role, content, ts}]`，沿用现有格式）。

- **`sessionStoreFor(req)`**（`api.js`）：按 `req.user` 派生 `path.join(users.dir, username, 'sessions')` 构造 `SessionStore`，进程内 `Map` 缓存（用户数有限，`SessionStore` 构造幂等）。
- **`SessionStore` 类接口不变**：构造接收 `config.session.dir`，方法签名（`create`/`exists`/`readHistory`/`append`/`isValidId`）与 R1 前一致，只是 dir 指向用户会话目录。`exists()` 纯 `stat` 探测不触发 `readHistory` 的透明重建副作用；`_loadRaw` 对损坏文件先备份（`.corrupt-<ts>`）再重置。
- **前端**：首次生成前懒调 `POST /api/session` 拿 uuid（per-user），sessionId 只存内存--浏览器刷新即丢。`GET /api/sessions` 列出用户所有会话供左侧抽屉渲染。
- **清理（重要约束）**：`cleanupExpiredSessions` **只清理旧的全局会话目录 `run/session/`**（`config.session.dir`，按 `SESSION_TTL_DAYS`）。**`run/users/` 下的用户账号与历史会话绝不自动清理**--曾经存在的 `cleanupExpiredUserSessions` 已移除，用户数据永久保留，只能手动删除。`AUTH_TOKEN_TTL_DAYS` 是登录态的逻辑过期（`verifyToken` 拒绝旧 token），不删除任何文件。

### PNG 导出（`src/services/export.js`）
服务端 SVG->PNG，基于 `@resvg/resvg-wasm`（纯 WASM，无原生依赖--`node_modules` 可在 macOS/Windows/Linux 之间直接拷贝）。WASM 初始化和内嵌的思源黑体（`assets/fonts/SourceHanSansSC-Regular.otf`）是模块级单例 promise（懒加载，失败可重试）。SVG 中所有 `font-family` 声明都被统一归一化为思源黑体，保证中文在各平台一致渲染。这正是 `prompts/system.txt` 禁止节点文本使用 HTML 标签的原因：resvg 不渲染 HTML 标签，导出 PNG 时这些内容会消失。前端 Mermaid 以 `securityLevel: 'loose'` 运行以获得渲染灵活性，而提示词把输出约束为纯文本--两者相容，并不矛盾。`/api/export/png` 受 `authUser` 保护，前端 `export.js` 走 `apiFetch`（带 Bearer，401 清登录态弹遮罩）。

### 前端（`public/js/`，无框架）
挂在 `window` 上的模块：`app`（输入/API/状态/登录态/抽屉）、`mermaidRender`（渲染 + 带行上下文的结构化错误诊断）、`components`（缩放/平移/背景/全屏/分隔条/快捷键）、`exportModule`（PNG 走服务端接口，SVG 走客户端 Blob）。通过 `window.*` 全局变量和 `localStorage` 通信。

- **登录遮罩**：未登录时 `login-mask` 覆盖主界面，含登录/注册表单。`apiFetch`（挂在 `window.app`）统一为请求加 `Authorization: Bearer <token>`，401 时清 localStorage 登录态并弹遮罩。token 存 `localStorage['pd_token']`，用户名存 `localStorage['pd_user']`，主题仍存 `localStorage['theme']`。
- **启动鉴权**：有 token 则 `GET /api/auth/me` 验证，失败显遮罩。
- **左侧可收回历史会话抽屉**（`history-drawer`）：登录后 `GET /api/sessions` 渲染列表（首轮提示词前 30 字摘要），点击某条会话调 `/api/session/check` 恢复 `sessionId` 与上一张图。顶栏"历史会话"按钮 toggle 开关，抽屉内 × 按钮 `closeDrawer` 收起。
- **已移除**：旧的"输入 uuid 恢复主页面"功能（`session-input`/`copySessionId`/`restoreSession`/`SESSION_ID_PATTERN`）已删除，`sessionInput.test.js` 同步删除。
- 代码编辑器在 600ms 防抖后自动重渲染图表。

### 日志（`src/utils/logger.js`）
单例 logger 同步写入 `run/processdown.log`，并**仅当 stdout 是 TTY 时**镜像到控制台--避免 `bin/start.sh` 把 stdout 重定向到同一文件时双重写入。API key、Authorization 头在落盘前通过正则脱敏。

## 约定与坑

- **`run/users/` 绝对禁止自动清理。** 用户账号与全部历史会话需永久保留，只能手动删除。`cleanupExpiredSessions` 仅作用于旧全局目录 `run/session/`，不碰 `run/users/`。任何新增的清理逻辑都不得遍历或删除 `run/users/` 下的内容。
- **启用登录后必须 TLS 反代。** 服务纯 HTTP 监听，register/login 请求体含明文密码、响应含 token。公网部署应 `SERVER_HOST=127.0.0.1` + 前置 Nginx/Caddy 终止 TLS（见 `.env.example` 与 README 的 TLS 前置要求）。
- **双层鉴权叠加**：`API_AUTH_KEY`（部署级 X-API-Key）与 Bearer（用户级）正交。`auth.js` 跳过 `/api/auth/*` 以保证设了 `API_AUTH_KEY` 后浏览器登录仍可用；`authUser` 作用于 `PROTECTED_USER_ROUTES`。新增需登录的路由时，同步加入 `PROTECTED_USER_ROUTES`（`server/index.js`）。
- **所有敏感配置只走环境变量。** `.env` 已被 gitignore；`.env.example` 是模板。`config/config.json`（若存在）只承载非敏感配置（端口/CORS/限流/llm 参数），`apiKey`/`token` 绝不可写入文件配置。
- **新增 Mermaid 图表类型时，需同步三处**：`prompts/system.txt`、`extractor.js` 的 `isMermaidCode` 模式列表、`extractMermaidCode` 中的关键字正则。
- **CORS `Allow-Headers` 含 `Authorization`**（`cors.js`），跨域部署时 Bearer 预检才能通过。同源（默认，前端由本服务 serve）不触发 CORS。
- **路径穿越防御**：username 走 `^[a-zA-Z0-9_-]{3,32}$` 白名单、sessionId 走 UUID 正则（`isValidId`），sessionId 操作始终限定在当前用户的 `sessions/` 目录下，跨用户不可访问他人会话。
- **沿用周围的注释风格**：本代码库偏好解释**为什么**的注释（如 `envInt` 关于 NaN 与 `??` 的说明、`parseBody` 关于 buffer 拼合的理由、`max_tokens` 省略的原因、`login` 守卫位置的理由、`run/users/` 不清理的约束）。编辑时请保留。
- **测试约定**：用 `node:test`，mock req/res 风格（见 `tests/unit/`）。`server/index.js` require 即 boot+listen 无法直接导入，涉及路由保护清单的测试用源码正则提取 + 真实 `authUser`+`createRouter` dispatch 组合（见 `protectedRoutes.edge.test.js`）。前端 DOM 逻辑无单元测试，靠手动冒烟。
