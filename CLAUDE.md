# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

无构建步骤、无 linter、无测试框架。要求 Node.js >= 18；唯一运行时依赖是 `@resvg/resvg-wasm`。

```bash
# 启动（需要 LLM_API_BASE_URL、LLM_API_KEY、LLM_MODEL 环境变量，或 .env 文件）
node src/server/index.js          # 前台运行
./bin/start.sh start              # 后台运行：start | stop | restart | status

# 测试（手动脚本 - 将 PNG 渲染到 /tmp 供肉眼检查，无断言）
node tests/export.test.js
```

配置通过 `src/config/loader.js` 里手写的解析器从 `.env` 加载（不依赖 dotenv）。将 `.env.example` 复制为 `.env`。`bin/start.sh` 只向子进程导出部分变量，但 `loader.js` 会自行重新读取 `.env`，因此**文件本身才是配置真源**，优先级高于脚本的 export 列表。

## 架构

### 请求管道（`src/server/index.js`）
单个 `http.createServer` 跑一条手写的中间件链：`cors -> rateLimit -> auth -> validator -> parseBody -> route`。每个中间件都以空操作 `next` 调用，链路在每一步之后通过 `if (res.headersSent) return` 短路（能成立是因为所有中间件拒绝时都同步调用 `res.end()`）。静态文件绕过 auth/validator（`/api/` 之外的任何路径）；`/api/health` 也绕过 auth。`parseBody` 先把 chunk 累积进 `Buffer` 再解码 UTF-8——这是刻意为之，为了正确拼合跨 chunk 边界被切断的多字节中文字符——并按实际字节数强制 1MB 上限（validator 只检查 `Content-Length` 头，所以两层校验缺一不可）。

### Mermaid 生成管道（`src/services/`）
`GeneratorService` 编排：`LLMService.chat`（OpenAI 兼容的 `/chat/completions`）-> `extractMermaidCode` -> `autoFixMermaidCode` -> `validateMermaidCode`。`src/services/extractor.js` 里的修复链是核心特性：剥离 `<think>` 推理标签、移除 emoji、把中文全角标点转成 ASCII、Tab 展开为 4 空格、并把错误包含 `else` 的 `opt` 块改写成 `alt`（通过基于栈的嵌套跟踪器匹配）。`LLMService` 用原生 `https`/`http`，按协议自动选择；`max_tokens` 在非正时（`-1` = 无限制）从 payload 中省略，这样开启 `<think>` 深度思考的慢模型不会在输出图表前就把 token 配额耗尽。

### PNG 导出（`src/services/export.js`）
服务端 SVG->PNG，基于 `@resvg/resvg-wasm`（纯 WASM，无原生依赖——`node_modules` 可在 macOS/Windows/Linux 之间直接拷贝）。WASM 初始化和内嵌的思源黑体（`assets/fonts/SourceHanSansSC-Regular.otf`）是模块级单例 promise（懒加载，失败可重试）。SVG 中所有 `font-family` 声明都被统一归一化为思源黑体，保证中文在各平台一致渲染。这正是 `prompts/system.txt` 禁止节点文本使用 HTML 标签的原因：resvg 不渲染 HTML 标签，导出 PNG 时这些内容会消失。前端 Mermaid 以 `securityLevel: 'loose'` 运行以获得渲染灵活性，而提示词把输出约束为纯文本——两者相容，并不矛盾。

### 前端（`public/js/`，无框架）
四个挂在 `window` 上的模块：`app`（输入/API/状态）、`mermaidRender`（渲染 + 带行上下文的结构化错误诊断）、`components`（缩放/平移/背景/全屏/分隔条/快捷键）、`exportModule`（PNG 走服务端接口，SVG 走客户端 Blob）。它们通过 `window.*` 全局变量和 `localStorage`（`theme`）通信。代码编辑器在 600ms 防抖后自动重渲染图表。

### 日志（`src/utils/logger.js`）
单例 logger 同步写入 `run/processdown.log`，并**仅当 stdout 是 TTY 时**镜像到控制台——避免 `bin/start.sh` 把 stdout 重定向到同一文件时双重写入。API key 和 Authorization 头在落盘前通过正则脱敏。

## 约定与坑

- **所有敏感配置只走环境变量。** `.env` 已被 gitignore；`.env.example` 是模板。
- 新增 Mermaid 图表类型时，需同步三处：`prompts/system.txt`、`isMermaidCode` 模式列表、`extractMermaidCode` 中的关键字正则。
- 沿用周围的注释风格：本代码库偏好解释**为什么**的注释（如 `envInt` 关于 NaN 与 `??` 的说明、`parseBody` 关于 buffer 拼接的理由、`max_tokens` 省略的原因）。编辑时请保留。

## 已知问题（待修复）

按严重性排列，源自首次逐行分析。修复时优先处理“严重”级。

### 严重

- **会话串扰 + 内存泄漏**（`src/routes/api.js`）：会话历史以 `req.socket.remoteAddress` 为 key 存在内存 `Map` 中，无清理机制。反向代理后所有客户端坍缩为同一个 IP、共享同一份历史，互相污染；`Map` 只增不减，长期运行内存泄漏。应改用前端传入的 sessionId 或 cookie，并加 TTL 清理。
- **`/api/regenerate` 死端点**：后端实现了完整路由（`src/routes/api.js`），但前端三个 JS 文件均未调用。要么接上前端，要么删除后端。
- **`history` 全链路死逻辑**：后端存历史、返回历史，前端存 `state.history`，但**从不用于 LLM 上下文，也不展示**。整条链路是无效代码。要么真正把 history 喂给 LLM 实现多轮，要么砍掉。

### 中等

- **`bin/start.sh` 的 export 列表不完整**（`bin/start.sh:161`）：只导出部分变量，漏了 `LLM_MAX_TOKENS / LLM_TIMEOUT / SERVER_HOST / REQUEST_TIMEOUT / HEALTH_CHECK_LLM / NODE_ENV`。所幸 `loader.js` 的 `loadEnvFile` 兜底读取 `.env`，否则这些配置在脚本启动时失效。属“能跑但脆弱”。
- **限流 IP 获取不处理 `X-Forwarded-For`**（`src/middleware/rateLimit.js:28`）：`req.ip` 在原生 http 上恒为 undefined，总走 `req.connection.remoteAddress`；反代后所有限流打到同一 IP，限流形同虚设。与上述会话串扰同源。
- **日志记录用户 prompt 原文**（`src/services/generator.js:69`）：`logger.info('...prompt:', prompt.substring(0,100))` 把用户输入落盘到 `run/processdown.log`，`maskSensitive` 不处理普通文本，可能泄露业务敏感信息。

### 轻微

- `auth.js` / `validator.js` / `errorHandler.js` 中的 `res.status().json()` 兼容分支是死代码（项目无 Express，原生 http 上 `res.status` 恒为 undefined）。
- `tests/export.test.js` 是人工验证脚本（写 `/tmp` 看图），无断言、无测试框架，`package.json` 无 test 脚本。
- `validateMermaidCode` 的括号计数会把节点文本里的括号误判为不平衡，仅产生 warning 不阻断，可接受。
- 提交信息全是“优化”，无法追溯变更内容。
