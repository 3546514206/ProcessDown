# ProcessDown

AI 驱动的自然语言流程图生成工具，将你的描述转换为 Mermaid 图表。

## 功能特性

### 核心功能
- **自然语言生成**：输入描述，自动生成 Mermaid 代码
- **上下文感知**：支持迭代修改现有流程图
- **实时预览**：Mermaid.js 实时渲染，所见即所得
- **源码编辑**：可直接编辑 Mermaid 代码

### 图表支持
- 流程图 (flowchart / graph)
- 时序图 (sequenceDiagram)
- 状态图 (stateDiagram-v2)
- 泳道图 (swimlane-beta)
- 类图 (classDiagram)
- ER 图 (erDiagram)
- C4 软件架构 (C4Context / C4Container / C4Component / C4Dynamic / C4Deployment)
- 需求图 (requirementDiagram)
- 甘特图 (gantt)
- 时间线 (timeline)
- 看板 (kanban)
- 用户旅程图 (journey)
- 饼图 (pie)
- 桑基图 (sankey)
- XY 图表 (xychart)
- 四象限图 (quadrantChart)
- 雷达图 (radar-beta)
- 树状图 (treemap-beta)
- 架构图 (architecture-beta)
- Block 布局图 (block)
- 数据包图 (packet)
- 维恩图 (venn-beta)
- 鱼骨图 (ishikawa-beta)
- Wardley 地图 (wardley-beta)
- Cynefin 决策框架 (cynefin-beta)
- 思维导图 (mindmap)
- 树视图 (treeView-beta)
- 事件建模 (eventmodeling)
- Git 图 (gitGraph)

> 关键字与 `prompts/system.txt` 对齐；zenuml 不在 vendored bundle，不支持。

### 前端功能
- 用户注册 / 登录 / 登出（Bearer token 登录态）
- 左侧历史会话抽屉（点击恢复上一张图）
- 缩放控制（放大/缩小/适应窗口/重置，上限 2000%）
- 拖拽平移
- 背景切换（深色/白色/透明）
- 导出 PNG（1x/2x/3x，服务端渲染）/ SVG（客户端导出）
- 复制代码
- 预览区全屏 / 整页全屏
- 快捷键支持

## 安装

```bash
# 克隆项目
git clone <repository-url>
cd ProcessDown

# 安装依赖（PNG 导出需要 @resvg/resvg-wasm，纯 WASM 无原生依赖）
npm install
```

## 配置

### 1. 创建环境变量文件

```bash
cp .env.example .env
```

### 2. 编辑 .env 文件

完整配置项见 `.env.example`，以下是关键变量：

```bash
# LLM API 配置（必需）
LLM_API_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key-here
LLM_MODEL=gpt-4o
# 慢模型 / 开启 <think> 深度思考时建议 LLM_MAX_TOKENS=-1（不限制）、LLM_TIMEOUT=300
LLM_MAX_TOKENS=-1
LLM_TIMEOUT=300

# 服务器配置（可选）
SERVER_PORT=3000
SERVER_HOST=0.0.0.0   # 公网部署建议 127.0.0.1 + TLS 反代

# 安全配置（可选）
ALLOWED_ORIGINS=https://your-domain.com
API_AUTH_KEY=          # 部署级 X-API-Key（见下方"API 接口"鉴权说明）
LOG_LEVEL=info
NODE_ENV=production

# 会话 / 登录态（可选）
SESSION_MAX_HISTORY=20
AUTH_TOKEN_TTL_DAYS=7  # 0 或负数表示永不过期
```

## 启动

### 方式一：直接启动

```bash
export LLM_API_BASE_URL=https://api.openai.com/v1
export LLM_API_KEY=your-api-key
export LLM_MODEL=gpt-4o
node src/server/index.js
```

### 方式二：使用启动脚本

```bash
chmod +x bin/start.sh
./bin/start.sh start    # start | stop | restart | status
```

> `start.sh` 在 start / restart 时会先 `git pull` 同步远程代码（无 .git 目录时跳过），随后台启动并做健康检查。

### 方式三：创建 .env 文件后启动

```bash
./bin/start.sh
```

服务启动后访问 http://localhost:3000

## API 接口

### 鉴权

- **部署级（可选）**：设置 `API_AUTH_KEY` 后，除 `/api/health` 与 `/api/auth/*` 外的所有 `/api/` 路由需带 `X-API-Key` 头。注意：浏览器前端只送 Bearer 不送 `X-API-Key`，故启用 `API_AUTH_KEY` 后前端画图/导出不可用，该层主要面向 API 客户端。
- **用户级（必需）**：`/api/generate`、`/api/regenerate`、`/api/export/png`、`/api/session`、`/api/session/check`、`/api/sessions`、`/api/auth/me`、`/api/auth/logout` 需带 `Authorization: Bearer <token>`（登录获得）。`/api/auth/register`、`/api/auth/login`、`/api/health`、`/api/config` 无需登录。

### POST /api/auth/register · /api/auth/login

注册（直接签发 token，省去再登录）/ 登录（轮换 token，旧 token 立即失效）。

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "secret123"}'
# -> {"success":true,"token":"alice.<hex>","username":"alice"}
```

### POST /api/generate

生成或迭代修改流程图（多轮上下文从 sessionId 对应历史读取）。

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer alice.<token>" \
  -d '{"prompt": "用户登录流程", "sessionId": "<uuid>"}'
```

### POST /api/regenerate

基于现有 Mermaid 代码按指令重绘（不写会话历史）。

### POST /api/session · /api/session/check · GET /api/sessions

- `POST /api/session`：创建新会话，返回 sessionId。
- `POST /api/session/check`：探测会话是否存在并返回上一张图（只读）。
- `GET /api/sessions`：列出当前用户所有历史会话（按更新时间倒序）。

### POST /api/export/png

服务端 SVG -> PNG（思源黑体，1x/2x/3x，深色/白色/透明背景）。

### GET /api/auth/me · /api/auth/logout

token 探活 / 登出（清空 token，幂等）。

### GET /api/config · /api/health

非敏感配置 / 健康检查（`HEALTH_CHECK_LLM=true` 时附加 LLM TCP 连通性探活）。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Enter` | 生成流程图 |
| `Ctrl++` | 放大 |
| `Ctrl+-` | 缩小 |
| `Ctrl+0` | 重置缩放 |
| `F11` | 全屏/退出全屏 |
| `Esc` | 退出全屏 |

## 目录结构

```
ProcessDown/
├── src/
│   ├── server/index.js        # 服务器入口 + 中间件链
│   ├── routes/api.js          # API 路由
│   ├── middleware/            # 中间件
│   │   ├── auth.js            # 部署级 X-API-Key 鉴权（可选）
│   │   ├── authUser.js        # 用户级 Bearer 鉴权
│   │   ├── cors.js            # CORS
│   │   ├── rateLimit.js       # 限流
│   │   ├── validator.js       # 请求校验
│   │   └── errorHandler.js    # 错误处理
│   ├── services/              # 业务逻辑
│   │   ├── llm/index.js       # LLM 调用（OpenAI 兼容）
│   │   ├── generator.js       # 生成编排
│   │   ├── extractor.js       # Mermaid 提取 + 自动修复链
│   │   ├── sessionStore.js    # 会话历史持久化
│   │   ├── userStore.js       # 用户注册/登录/token
│   │   └── export.js          # SVG -> PNG（resvg-wasm）
│   ├── config/loader.js       # 配置加载
│   └── utils/logger.js        # 日志（脱敏）
├── public/                    # 前端资源（无框架）
│   ├── index.html
│   ├── css/style.css
│   ├── vendor/mermaid.min.js  # vendored mermaid 11.16.1
│   └── js/
│       ├── app.js             # 主应用 + 登录态 + 历史抽屉
│       ├── mermaid-render.js  # 渲染 + 错误诊断
│       ├── components.js      # 缩放/平移/背景/全屏/分隔条
│       └── export.js          # PNG/SVG 导出
├── prompts/system.txt         # 系统提示词（图表关键字 + 禁止写法）
├── assets/fonts/              # 思源黑体（PNG 导出用）
├── config/config.example.json # 非敏感配置示例
├── bin/start.sh               # 启动脚本（start|stop|restart|status）
├── .env.example               # 环境变量示例
└── package.json
```

## 安全说明

- 所有敏感配置（API Key、token）只走环境变量，`.env` 已 gitignore；`config/config.json` 仅承载非敏感配置
- 双层鉴权（详见 API 接口节）：部署级 `X-API-Key`（可选）+ 用户级 Bearer token（必需，画图/导出/会话均需登录）
- 用户登录：密码用 scrypt + 16 字节随机 salt 派生 64 字节 hash，绝不落盘明文；登录/注册错误统一返回 `invalid_credentials`，不区分用户是否存在，防用户名枚举；登录即轮换 token，旧 token 立即失效
- 路径穿越防御：username 走 `^[a-zA-Z0-9_-]{3,32}$` 白名单，sessionId 走 UUID 正则，会话操作始终限定在当前用户目录下
- CORS 白名单（跨域部署需显式配 `ALLOWED_ORIGINS`，CORS 已放行 `Authorization` 头以支持 Bearer 预检）
- 请求体大小限制 1MB（Content-Length 头 + parseBody 实际字节数双层校验）；prompt 不再单独设上限
- `run/users/` 下的用户账号与历史会话永不自动清理，只能手动删除

### ⚠️ TLS 前置要求

启用用户登录后，**必须经 TLS 反代（HTTPS）访问**，否则登录密码与 token 会以明文在网络上传输，可被中间人截获。公网部署建议：

1. 将 `SERVER_HOST` 绑定为 `127.0.0.1`（仅本机可访问）。
2. 前置 Nginx / Caddy 等终止 TLS，再反代到本服务端口。
3. 通过 `ALLOWED_ORIGINS` 限定跨域来源。

跨域部署时，CORS 已放行 `Authorization` 头以支持 Bearer 预检；同源部署无感。

## 技术栈

- **后端**：Node.js 原生 HTTP 服务器
- **前端**：原生 JavaScript
- **图表**：Mermaid.js
- **AI**：OpenAI 兼容 API 格式

## 跨平台部署说明

PNG 导出使用 [@resvg/resvg-wasm](https://github.com/yisibl/resvg-js)，纯 WASM 实现，**无原生依赖**，macOS / Windows / Linux 之间可直接拷贝 `node_modules`，无需在目标平台重新安装。

字体采用内嵌的思源黑体（Source Han Sans SC），确保中文在所有平台一致渲染，不依赖系统字体。

## 环境要求

- Node.js >= 18.0.0
- 无需任何原生编译工具链