# ProcessDown

AI 驱动的自然语言流程图生成工具，将你的描述转换为 Mermaid 图表。

## 功能特性

### 核心功能
- **自然语言生成**：输入描述，自动生成 Mermaid 代码
- **上下文感知**：支持迭代修改现有流程图
- **实时预览**：Mermaid.js 实时渲染，所见即所得
- **源码编辑**：可直接编辑 Mermaid 代码

### 图表支持
- 流程图 (flowchart)
- 时序图 (sequenceDiagram)
- 状态图 (stateDiagram-v2)
- 类图 (classDiagram)
- ER 图 (erDiagram)
- 甘特图 (gantt)
- 饼图 (pie)
- 需求图 (requirementDiagram)
- Git 图 (gitGraph)
- 用户旅程图 (journey)

### 前端功能
- 缩放控制（放大/缩小/适应窗口/重置）
- 拖拽平移
- 背景切换（深色/白色/透明）
- 导出 PNG（1x/2x/3x/4x）/ SVG
- 复制代码
- 快捷键支持

## 安装

```bash
# 克隆项目
git clone <repository-url>
cd ProcessDown

# 安装依赖（可选，无需npm包）
```

## 配置

### 1. 创建环境变量文件

```bash
cp .env.example .env
```

### 2. 编辑 .env 文件

```bash
# LLM API 配置（必需）
LLM_API_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key-here
LLM_MODEL=gpt-4o

# 服务器配置（可选）
SERVER_PORT=3000

# 安全配置（可选）
ALLOWED_ORIGINS=https://your-domain.com
API_AUTH_KEY=your-api-auth-key
LOG_LEVEL=info
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
./bin/start.sh
```

### 方式三：创建 .env 文件后启动

```bash
./bin/start.sh
```

服务启动后访问 http://localhost:3000

## API 接口

### POST /api/generate

生成流程图

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"prompt": "用户登录流程"}'
```

响应：
```json
{
  "success": true,
  "mermaid": "flowchart TD\n    A[登录页面] --> B{验证}",
  "history": [...]
}
```

### GET /api/config

获取非敏感配置

```bash
curl http://localhost:3000/api/config
```

### GET /api/health

健康检查

```bash
curl http://localhost:3000/api/health
```

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
│   ├── server/index.js       # 服务器入口
│   ├── routes/api.js         # API 路由
│   ├── middleware/          # 中间件
│   │   ├── auth.js          # 认证
│   │   ├── cors.js          # CORS
│   │   ├── rateLimit.js     # 限流
│   │   ├── validator.js     # 验证
│   │   └── errorHandler.js  # 错误处理
│   ├── services/            # 业务逻辑
│   │   ├── llm/            # LLM 调用
│   │   ├── generator.js     # 生成器
│   │   └── extractor.js    # 代码提取
│   ├── config/loader.js     # 配置加载
│   └── utils/logger.js      # 日志
├── public/                   # 前端资源
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js           # 主应用
│       ├── mermaid-render.js # 渲染
│       ├── components.js     # 组件
│       └── export.js         # 导出
├── config/
│   └── config.example.json  # 配置示例
├── prompts/
│   └── system.txt          # AI 提示词
├── bin/
│   └── start.sh             # 启动脚本
├── .env.example             # 环境变量示例
└── package.json
```

## 安全说明

- 所有敏感配置（API Key、baseUrl）必须通过环境变量注入
- 配置文件不包含任何敏感信息
- 支持 API 认证（通过 `X-API-Key` header）
- CORS 白名单配置
- 请求体大小限制（1MB）
- 输入长度限制（5000 字符）

## 技术栈

- **后端**：Node.js 原生 HTTP 服务器
- **前端**：原生 JavaScript
- **图表**：Mermaid.js
- **AI**：OpenAI 兼容 API 格式

## 环境要求

- Node.js >= 14.0.0