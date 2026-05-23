#!/bin/bash
# ProcessDown 启动脚本
# 验证环境变量后启动服务

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}   ProcessDown - AI 流程图生成器${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# 检查 .env 文件
if [ -f .env ]; then
    echo -e "${YELLOW}Loading .env file...${NC}"
    set -a
    source .env
    set +a
else
    echo -e "${YELLOW}.env file not found, using environment variables${NC}"
fi

# 验证必需的环境变量
REQUIRED_VARS=("LLM_API_BASE_URL" "LLM_API_KEY" "LLM_MODEL")
MISSING_VARS=""

for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        MISSING_VARS="$MISSING_VARS  - $var\n"
    fi
done

if [ -n "$MISSING_VARS" ]; then
    echo -e "${RED}错误: 以下必需的环境变量未设置:${NC}"
    echo -e "$MISSING_VARS"
    echo ""
    echo "请创建 .env 文件或导出这些环境变量"
    echo ""
    echo "示例 .env 文件内容:"
    echo "LLM_API_BASE_URL=https://api.openai.com/v1"
    echo "LLM_API_KEY=your-api-key"
    echo "LLM_MODEL=gpt-4o"
    exit 1
fi

# 验证 URL 格式
if [[ ! "$LLM_API_BASE_URL" =~ ^https?:// ]]; then
    echo -e "${RED}错误: LLM_API_BASE_URL 必须以 http:// 或 https:// 开头${NC}"
    exit 1
fi

echo -e "${GREEN}✅ 配置验证通过${NC}"
echo ""

# 显示配置信息（隐藏敏感数据）
echo "配置信息:"
echo "  - 服务器端口: ${SERVER_PORT:-3000}"
echo "  - LLM 模型: $LLM_MODEL"
echo "  - API 地址: ${LLM_API_BASE_URL%%/v1*}***"
echo "  - 认证: ${API_AUTH_KEY:+启用} ${API_AUTH_KEY:-未启用}"
echo "  - 日志级别: ${LOG_LEVEL:-info}"
echo ""

# 启动服务
echo -e "${GREEN}启动服务中...${NC}"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}错误: Node.js 未安装${NC}"
    exit 1
fi

NODE_VERSION=$(node --version)
echo "Node.js 版本: $NODE_VERSION"

# 启动应用
node src/server/index.js