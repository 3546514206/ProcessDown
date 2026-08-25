# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

无构建步骤、无 linter。要求 Node.js >= 18；唯一运行时依赖是 `@resvg/resvg-wasm`。

```bash
# 启动（需要 LLM_API_BASE_URL、LLM_API_KEY、LLM_MODEL 环境变量，或 .env 文件）
node src/server/index.js          # 前台运行
./bin/start.sh start              # 后台运行：start | stop | restart | status

# 测试（node:test，当前 422 项：389 过 / 33 挂，红的原因见"约定与坑"的测试约定）
npm test                          # 跑 tests/unit/ 全部单元测试
node tests/export.test.js         # 手动 PNG 渲染脚本（无断言，渲染到 /tmp 供肉眼检查）
node tests/prompt-eval/eval.js    # 提示词类型识别评估器（48 用例，调真实 LLM，慢）
```

配置通过 `src/config/loader.js` 里手写的解析器从 `.env` 加载（不依赖 dotenv）。将 `.env.example` 复制为 `.env`。`bin/start.sh` 的 `load_env` 用 `set -a; source .env; set +a` 把 `.env` 全部变量导出给子进程；`loader.js` 仍会自行重新读取 `.env`（只填进程环境里未设置的键，环境变量优先），因此**文件本身才是配置真源**。另注意 start/restart 在启动前自动 `git pull` 同步远程代码（无 `.git` 目录或 pull 失败只警告不中断，回退用本地代码启动）。

**用户管理**：不引入数据库，用户数据落盘到 `run/users/<username>/`。画图功能需先登录（注册/登录见前端登录遮罩）。

## 架构

### 请求管道（`src/server/index.js`）
单个 `http.createServer` 跑一条手写的中间件链：`cors -> rateLimit -> auth -> validator -> parseBody -> [authUser] -> route`。每个中间件拒绝时同步 `res.end()`，链路在每步之后通过 `if (res.headersSent) return` 短路，链路末端 `errorHandler` 兜住未捕获异常。静态文件（`/api/` 之外的路径）不走 auth 层；`/api/` 内仅 `/api/health` 与 `/api/auth/*` 豁免 X-API-Key，**`/api/config` 在设了 `API_AUTH_KEY` 后同样要求 X-API-Key**。`parseBody` 对 POST/PATCH 生效（PATCH 必须在列：`PATCH /api/session/:id/diagram` 的 body 是编辑内容本体），先把 chunk 累积进 `Buffer` 再解码 UTF-8--刻意为之，为正确拼合跨 chunk 边界被切断的多字节中文字符--并按实际字节数强制 1MB 上限（validator 只检查 `Content-Length` 头，两层校验缺一不可）。静态文件用 `createReadStream` 流式传输（3.3MB 的 vendor mermaid.min.js 一次性读入内存在慢网络/反代下易超时），缓存分两档：`public/vendor/`（带 `?v=` 版本号 busting）走 `max-age=86400` 强缓存，应用自身 JS/CSS 迭代频繁走 `no-cache`。

### 双层鉴权
两套正交的鉴权，叠加作用于 `/api/`：

1. **`auth.js`（X-API-Key，部署级，可选）**：由 `API_AUTH_KEY` 环境变量开启。作用于全部 `/api/`，但**跳过 `/api/health` 与 `/api/auth/*`**--否则设了 `API_AUTH_KEY` 后浏览器登录链路断（前端 `apiFetch` 不送 `X-API-Key`）。默认部署（未设 `API_AUTH_KEY`）下此层透传。
2. **`authUser.js`（Bearer token，用户登录态，必需）**：从 `Authorization: Bearer <token>` 提取，`userStore.verifyToken` 校验，成功注入 `req.user = username`，失败 401。仅作用于 `PROTECTED_USER_ROUTES`（见下）。`register`/`login`/`health`/`config` 不需要用户登录（`config` 仍受第 1 层 X-API-Key 约束）。

`PROTECTED_USER_ROUTES`（`server/index.js`）：`/api/generate`、`/api/generate/stream`、`/api/regenerate`、`/api/export/png`、`/api/session`、`/api/session/check`、`/api/sessions`、`/api/auth/me`、`/api/auth/logout`。形参化的 `PATCH /api/session/:id/diagram` 走并列的 `PROTECTED_USER_ROUTE_PATTERNS`（正则 `^\/api\/session\/[^/]+\/diagram$`--路径含动态段，Set 无法承载），dispatch 时两类都查，PATCH 在 switch 的 default 分支落地。`regenerate`/`export/png` 同属"画图"语义，纳入保护以闭合"画图需先登录"的需求--否则默认部署下可被 curl 白嫖 LLM 或打 CPU。受保护路由在 switch 前先过 `authUser`，失败则 `headersSent` 短路，落不到 switch。

`/api/health` 的 LLM 探活是 opt-in（`HEALTH_CHECK_LLM=true`）：用 TCP 连接探针而非真实 chat 请求，air-gapped 慢模型下每次 health check 都打一次 completion 不现实。

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
`GeneratorService` 编排：`LLMService.chat`（OpenAI 兼容的 `/chat/completions`）-> `extractMermaidCode` -> `autoFixMermaidCode` -> `validateMermaidCode`；流式版 `generateStream` 走 `LLMService.chatStream`，逐 delta 回调 onThinking/onContent/onDone。`src/services/extractor.js` 里的修复链是核心特性：剥离 `<think>` 推理标签、移除 emoji、把中文全角标点转成 ASCII（**书名号《》刻意不转**--`<>` 会被解析成形状定界符，11.16.1 原生渲染 CJK 书名号）、Tab 展开为 4 空格、把错误包含 `else` 的 `opt` 块改写成 `alt`（基于栈的嵌套跟踪器）、修复 erDiagram 引号关系标签（`fixErdRelationshipLabels`）、剥 gitGraph 的 v10+ 语法（cherry-pick 后缀 / merge type / 头部方向，`fixGitGraphCherryPick`/`fixGitGraphMergeType`/`fixGitGraphOrientation`），以及行尾空白清理。`stripFrontmatter` 函数仍在并导出，但 `extractMermaidCode` **不再调用**它--vendored mermaid 11.16.1 原生解析 frontmatter（提取 title 与 config），剥离反而丢合法配置；保留供回归测试与将来兜底路径复用。`LLMService` 用原生 `https`/`http`，按协议自动选择；`max_tokens` 在非正时（`-1` = 无限制）从 payload 中省略，这样开启 `<think>` 深度思考的慢模型不会在输出图表前就把 token 配额耗尽。

流式层（`llm/index.js`）：`makeStreamRequest` 按 SSE 协议逐行解析 `data:` 行，`StringDecoder` 保留跨 chunk 的不完整 UTF-8 字节（流式版的 parseBody Buffer.concat 问题）；`createThinkSplitter` 处理 `<think>` 标签跨 chunk 分离（后缀-前缀匹配 hold 住半个标签）与 `reasoning_content` 直通；客户端断开经 AbortController 中止上游请求，归类为 `ABORTED` 错误码而非 LLM 错误。前端图表渲染用 vendored mermaid 11.16.1（`public/vendor/mermaid.min.js`），zenuml 不在 bundle 内，`isMermaidCode` 刻意不收录以免"提取通过 -> 渲染失败"。

`/api/generate` 基于 `req.user` 派生该用户的 `SessionStore`（`sessionStoreFor(req)`），多轮 history 从用户会话目录读。无 `sessionId` 时不构造 per-user store，保持"无 sessionId 不落盘"的副作用边界。生成成功时同时写 history.json（审计轨迹）与 diagram.json（当前规范图表），响应含 `history` 字段（`slice(-10)`）供前端回放。

`POST /api/generate/stream` 是流式版本：SSE 响应，事件协议 `thinking`/`content`/`done`/`error` + 结束标记 `[DONE]`，`X-Accel-Buffering: no` 防 Nginx 反代缓冲。校验失败先返回 400 JSON（与非流式一致），通过后才升级为 `text/event-stream`，后续错误以 `error` 事件送达。客户端断开经 `req` 的 `close` 事件触发 `AbortController` 中止上游 LLM 请求。onDone 与 `/api/generate` 同样双写 history.json 与 diagram.json。

### 会话（`src/services/sessionStore.js` + `src/routes/api.js`）
会话按用户落盘到 `run/users/<username>/sessions/<uuid>/history.json`（`[{role, content, ts}]`，沿用现有格式）。

- **`sessionStoreFor(req)`**（`api.js`）：按 `req.user` 派生 `path.join(users.dir, username, 'sessions')` 构造 `SessionStore`，进程内 `Map` 缓存（用户数有限，`SessionStore` 构造幂等）。
- **`SessionStore`**：构造接收 `{dir, maxHistory}`（`sessionStoreFor` 还传了 `ttlDays`，但类本身不消费它）；方法含 `isValidId`/`historyPath`/`exists`/`create`/`readHistory`/`append`，以及 diagram 覆盖层三件套 `diagramPath`/`saveDiagram`/`readDiagram`。`exists()` 纯 `stat` 探测不触发 `readHistory` 的透明重建副作用；`_loadRaw` 对损坏文件先备份（`.corrupt-<ts>`）再重置；`saveDiagram` 用 tmp+rename 原子写（写一半被 kill 只留 `.tmp` 垃圾，不会让 diagram.json 半截损坏）；`readDiagram` 对损坏文件同样备份后返回 null，让 `checkSession` 回退到 history 派生路径。
- **diagram.json 是"当前规范图表"可编辑覆盖层**，与 history.json（不可变的审计轨迹）平行：LLM 生成与用户手动编辑都会写它，恢复时优先于 history 最后一条 assistant content。
- **`POST /api/session/check`**：返回完整 history（每条 assistant content 逐条 extract+autoFix 净化后返回，**不写盘**--旧会话残留的不兼容写法会害前端渲染失败）与 `lastMermaid`（diagram.json 优先派生；`typeof === 'string'` 而非 truthy，保留空串的"清空覆盖层"语义）。diagram-only 的会话（PATCH 先于首次生成落盘）也算"存在"，否则用户的编辑会无声丢失。
- **`PATCH /api/session/:id/diagram`**：写 diagram.json 覆盖层，`code` 必须是字符串且上限 200KB（与 mermaid 源码实际体积对齐）。编辑先于首次落盘的时序是合法的，不加"会话必须已存在"前置校验。
- **前端**：首次生成前懒调 `POST /api/session` 拿 uuid（per-user），sessionId 只存内存--浏览器刷新即丢。`GET /api/sessions` 列出用户所有会话（含 `updatedAt` 供前端分组）供左侧抽屉渲染。
- **清理（重要约束）**：`cleanupExpiredSessions` **只清理旧的全局会话目录 `run/session/`**（`config.session.dir`，按 `SESSION_TTL_DAYS`）。**`run/users/` 下的用户账号与历史会话绝不自动清理**--曾经存在的 `cleanupExpiredUserSessions` 已移除，用户数据永久保留，只能手动删除。`AUTH_TOKEN_TTL_DAYS` 是登录态的逻辑过期（`verifyToken` 拒绝旧 token），不删除任何文件。

### PNG 导出（`src/services/export.js`）
服务端 SVG->PNG，基于 `@resvg/resvg-wasm`（纯 WASM，无原生依赖--`node_modules` 可在 macOS/Windows/Linux 之间直接拷贝）。WASM 初始化和内嵌的思源黑体（`assets/fonts/SourceHanSansSC-Regular.otf`）是模块级单例 promise（懒加载，失败可重试）。SVG 中所有 `font-family` 声明都被统一归一化为思源黑体，保证中文在各平台一致渲染。这正是 `prompts/system.txt` 禁止节点文本使用 HTML 标签的原因：resvg 不渲染 HTML 标签，导出 PNG 时这些内容会消失。唯一例外是换行统一用 `<br/>`（mermaid 与 resvg 都支持）。前端 Mermaid 以 `securityLevel: 'loose'` 运行以获得渲染灵活性，而提示词把输出约束为纯文本--两者相容，并不矛盾。`/api/export/png` 受 `authUser` 保护，前端 `export.js` 走 `apiFetch`（带 Bearer，401 清登录态弹遮罩）。

### 前端（`public/js/`，无框架）
挂在 `window` 上的模块：`app`（鉴权/历史抽屉/状态栏/配置加载/全站主题切换）、`chat`（对话式 UI 全部逻辑，最大模块）、`mermaidRender`（渲染 + 带行上下文的结构化错误诊断；`silent` 模式供流式节流渲染静默容错，失败保留上次结果不弹错）、`components`（缩放/平移/背景（随全站主题联动，无独立按钮）/预览区全屏/整页全屏/分隔条/快捷键）、`exportModule`（PNG 走服务端接口含 1x/2x/3x 缩放菜单，SVG 走客户端 Blob）。通过 `window.*` 全局变量和 `localStorage` 通信。样式 `public/css/style.css` + `chat.css`（深/浅双主题由 `<html data-theme>` 驱动）。

- **chat 模块**（`chat.js`）：欢迎态示例 chip、自适应高度输入框（Enter 发送 / Shift+Enter 换行）、发送/停止按钮切换、per-round 操作行（查看此图/复制代码/重新生成--重放**本轮**指令而非全局最后一条 user）、思考过程折叠块（终态折叠并标注秒数）、回到底部按钮。
- **流式前端**：`fetch` + `ReadableStream` 手动解析 SSE（需带 Bearer 头，不能用 EventSource），`AbortController` 停止生成，`finish` 包装保证 done/error/abort 终态互斥只跑一次，连接被反代切断等断连场景有兜底 error。`streamGenerate` 的 401 处理**刻意与 `apiFetch` 不同**：不清聊天 DOM（已生成内容已落盘可恢复），仅清登录态弹遮罩。
- **代码编辑**：AI 消息的代码面板是 `<textarea>`，`readOnly` 属性是唯一编辑门（流式上锁、finalize/abort/error 解锁；新一轮生成把所有旧轮重新上锁--diagram.json 是会话级覆盖层，可编辑画布唯一化到最新一轮）。编辑触发 600ms **节流**的 silent 重渲染与 600ms 节流的 `PATCH /api/session/:id/diagram` 落盘（两处同节奏）；PATCH 失败入 `localStorage['pd_pending_saves']`（上限 50）待重发，启动时排空，切换会话/新建/登出/新一轮前 flush。
- **登录遮罩**：未登录时 `login-mask` 覆盖主界面，含登录/注册表单。`apiFetch`（挂在 `window.app`）统一为请求加 `Authorization: Bearer <token>`，401 时清 localStorage 登录态并弹遮罩。token 存 `localStorage['pd_token']`，用户名仅存内存 `state.user`（刷新即丢，需重新登录）。
- **全站主题（深/浅）**：`localStorage['site-theme']`（`'dark'|'light'`，默认 light）是唯一主题状态源，顶栏按钮唯一开关，统一驱动 UI 配色（`<html data-theme>` + CSS 变量覆盖块）、画布背景（`components.setTheme` 的 bg-dark/bg-light）、mermaid 主题（dark/default）、导出底色。运行期读点走 `app.getSiteTheme()`（state 真源，存储写失败如隐私模式时不分裂）；`readSiteTheme()` 只服务引导时读存储。`index.html` head 内联脚本在首帧前写 data-theme 防闪烁，并对旧 `theme` 键（画布背景三态，已随三按钮一起移除）做一次性迁移：`dark -> dark`、其余 -> light（旧键保留不删）。切换主题经 `reinitMermaid` 重渲染当前图，但流式生成中只重设 mermaid 主题不渲染（防旧图顶掉流式半成品）。
- **启动鉴权**：有 token 则 `GET /api/auth/me` 验证，失败显遮罩。
- **左侧可收回历史会话抽屉**（`history-drawer`）：登录后 `GET /api/sessions` 渲染列表（首轮提示词前 30 字摘要，按 updatedAt 分组为今天/昨天/更早）。点击某条会话调 `/api/session/check`，前端 `chat.renderHistory` 用返回的完整 history 重建对话，仅最后一轮可编辑、渲染其图（lastMermaid 取 diagram.json，用户编辑优先）。"新建会话"按钮与 Ctrl+K 开新会话；流式中禁止切换/新建。顶栏"历史会话"按钮 toggle 开关，抽屉内 × 按钮 `closeDrawer` 收起。
- **已移除**：旧的"输入 uuid 恢复主页面"功能（`session-input`/`copySessionId`/`restoreSession`/`SESSION_ID_PATTERN`）已删除，`sessionInput.test.js` 同步删除。

### 日志（`src/utils/logger.js`）
单例 logger 同步写入 `run/processdown.log`，并**仅当 stdout 是 TTY 时**镜像到控制台--避免 `bin/start.sh` 把 stdout 重定向到同一文件时双重写入。API key、Authorization 头在落盘前通过正则脱敏。

## 约定与坑

- **`run/users/` 绝对禁止自动清理。** 用户账号与全部历史会话需永久保留，只能手动删除。`cleanupExpiredSessions` 仅作用于旧全局目录 `run/session/`，不碰 `run/users/`。任何新增的清理逻辑都不得遍历或删除 `run/users/` 下的内容。
- **启用登录后必须 TLS 反代。** 服务纯 HTTP 监听，register/login 请求体含明文密码、响应含 token。公网部署应 `SERVER_HOST=127.0.0.1` + 前置 Nginx/Caddy 终止 TLS（见 `.env.example` 与 README 的 TLS 前置要求）。
- **双层鉴权叠加**：`API_AUTH_KEY`（部署级 X-API-Key）与 Bearer（用户级）正交。`auth.js` 跳过 `/api/auth/*` 以保证设了 `API_AUTH_KEY` 后浏览器登录仍可用；`authUser` 作用于 `PROTECTED_USER_ROUTES`。新增需登录的路由时，同步加入 `PROTECTED_USER_ROUTES`（字面量）或 `PROTECTED_USER_ROUTE_PATTERNS`（形参化路径的正则，`server/index.js`）。
- **所有敏感配置只走环境变量。** `.env` 已被 gitignore；`.env.example` 是模板。`config/config.json`（若存在）只承载非敏感配置（端口/CORS/限流/llm 参数），`apiKey`/`token` 绝不可写入文件配置。
- **新增 Mermaid 图表类型时，需同步三处**：`prompts/system.txt`、`extractor.js` 的 `isMermaidCode` 模式列表、`extractMermaidCode` 中的关键字正则。
- **CORS `Allow-Headers` 含 `Authorization`**（`cors.js`），跨域部署时 Bearer 预检才能通过。同源（默认，前端由本服务 serve）不触发 CORS。
- **路径穿越防御**：username 走 `^[a-zA-Z0-9_-]{3,32}$` 白名单、sessionId 走 UUID 正则（`isValidId`），sessionId 操作始终限定在当前用户的 `sessions/` 目录下，跨用户不可访问他人会话。
- **沿用周围的注释风格**：本代码库偏好解释**为什么**的注释（如 `envInt` 关于 NaN 与 `??` 的说明、`parseBody` 关于 buffer 拼合的理由、`max_tokens` 省略的原因、`login` 守卫位置的理由、`run/users/` 不清理的约束）。编辑时请保留。
- **测试约定**：用 `node:test`，mock req/res 风格（见 `tests/unit/`）。`server/index.js` require 即 boot+listen 无法直接导入，涉及路由保护清单的测试用源码正则提取 + 真实 `authUser`+`createRouter` dispatch 组合（见 `protectedRoutes.edge.test.js`）；前端 DOM 逻辑有 jsdom 冒烟测试（`frontend*.smoke.test.js` 等）。**当前套件是红的**：422 项中 33 项失败，全部来自先于实现落下的测试--`editMessage.route.test.js`（测尚不存在的 `/api/message/edit` 路由）与 `frontendEditor.smoke.test.js`（测尚不存在的 `window.chat._installEditor`）；实现落地前不要为了"变绿"删测试或粉饰数字。另有 `tests/prompt-eval/`（提示词类型识别评估器，48 用例）、`tests/e2e/`、`tests/manual/`（手动冒烟文档）。
- **jsdom 依赖隐患**：`frontendButtons.smoke.test.js`、`frontendEditor.smoke.test.js`、`frontendSiteTheme.smoke.test.js` 三个文件 `require('jsdom')`，但 `package.json` 没有 `devDependencies` 声明、lock 文件也无记录--jsdom 只是碰巧装在本地 `node_modules`，fresh `npm ci` 后这些测试必挂。
