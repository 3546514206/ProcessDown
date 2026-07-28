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

### 会话（`src/services/sessionStore.js`）
历史按会话落盘到 `run/session/<uuid>/history.json`（`[{role, content, ts}]`）。前端首次生成前懒调用 `POST /api/session` 拿 uuid，只存内存——浏览器刷新即丢，下次重新申请。`generate` 把最近 N 条 history 拼在 messages 前部实现多轮（当前指令永远在最后；不与 currentMermaid 去重，因为用户可能手改了编辑器代码）。服务启动时清理 `history.json` mtime 超过 `SESSION_TTL_DAYS`（默认 7 天）的会话文件夹；注意必须 stat 文件而非文件夹——写文件不刷新文件夹自身的 mtime。sessionId 用通用 uuid 形正则校验（只放行 hex+连字符），天然免疫路径穿越。

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
