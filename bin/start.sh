#!/bin/bash
# ProcessDown 启动脚本
# 支持后台运行，提供 start / stop / restart / status 命令

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_DIR="$PROJECT_DIR/run"
mkdir -p "$RUN_DIR"
PID_FILE="$RUN_DIR/processdown.pid"
LOG_FILE="$RUN_DIR/processdown.log"

cd "$PROJECT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
    echo "用法: $0 {start|stop|restart|status}"
    echo ""
    echo "  start    后台启动服务"
    echo "  stop     停止服务"
    echo "  restart  重启服务"
    echo "  status   查看服务状态"
    exit 1
}

load_env() {
    if [ -f .env ]; then
        set -a
        source .env
        set +a
    fi
}

backup_run() {
    local has_files=false

    if [ -f "$PID_FILE" ]; then
        has_files=true
    fi
    if [ -f "$LOG_FILE" ]; then
        has_files=true
    fi

    if [ "$has_files" = false ]; then
        return 0
    fi

    local backup_dir="$RUN_DIR/$(date '+%Y%m%d%H%M%S')"
    mkdir -p "$backup_dir"

    if [ -f "$PID_FILE" ]; then
        cp -f "$PID_FILE" "$backup_dir/"
        rm -f "$PID_FILE"
    fi

    if [ -f "$LOG_FILE" ]; then
        cp -f "$LOG_FILE" "$backup_dir/"
        rm -f "$LOG_FILE"
    fi

    echo -e "${YELLOW}已备份旧运行文件到: $backup_dir${NC}"
}

validate_config() {
    # 检查 Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}错误: Node.js 未安装${NC}"
        exit 1
    fi

    # 检查 .env 文件
    if [ -f .env ]; then
        echo -e "${YELLOW}Loading .env file...${NC}"
        load_env
    else
        echo -e "${YELLOW}.env file not found, using environment variables${NC}"
    fi

    # 验证必需的环境变量
    local REQUIRED_VARS=("LLM_API_BASE_URL" "LLM_API_KEY" "LLM_MODEL")
    local MISSING_VARS=""

    for var in "${REQUIRED_VARS[@]}"; do
        if [ -z "${!var}" ]; then
            MISSING_VARS="$MISSING_VARS  - $var\n"
        fi
    done

    if [ -n "$MISSING_VARS" ]; then
        echo -e "${RED}错误: 以下必需的环境变量未设置:${NC}"
        echo -e "$MISSING_VARS"
        echo "请创建 .env 文件或导出这些环境变量"
        exit 1
    fi

    # 验证 URL 格式
    if [[ ! "$LLM_API_BASE_URL" =~ ^https?:// ]]; then
        echo -e "${RED}错误: LLM_API_BASE_URL 必须以 http:// 或 https:// 开头${NC}"
        exit 1
    fi
}

check_port() {
    local port="${SERVER_PORT:-3000}"
    if lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null; then
        echo -e "${RED}错误: 端口 $port 已被占用${NC}"
        lsof -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2
        return 1
    fi
}

is_running() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        # PID 文件存在但进程已死，清理残留
        rm -f "$PID_FILE"
    fi
    return 1
}

do_start() {
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}   ProcessDown - AI 流程图生成器${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    validate_config

    echo -e "${GREEN}✅ 配置验证通过${NC}"
    echo ""

    local port="${SERVER_PORT:-3000}"
    echo "配置信息:"
    echo "  - 服务器端口: $port"
    echo "  - LLM 模型: $LLM_MODEL"
    echo "  - API 地址: ${LLM_API_BASE_URL%%/v1*}***"
    echo "  - 认证: ${API_AUTH_KEY:+启用} ${API_AUTH_KEY:-未启用}"
    echo "  - 日志级别: ${LOG_LEVEL:-info}"
    echo ""

    if is_running; then
        echo -e "${YELLOW}服务已在运行中 (PID: $(cat "$PID_FILE"))${NC}"
        return 0
    fi

    backup_run

    check_port || return 1

    echo -e "${GREEN}启动服务中...${NC}"

    # 导出环境变量供子进程继承
    export LLM_API_BASE_URL LLM_API_KEY LLM_MODEL SERVER_PORT API_AUTH_KEY LOG_LEVEL ALLOWED_ORIGINS

    # 后台启动，输出重定向到日志文件
    nohup node src/server/index.js >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    # 等待并验证启动是否成功
    local retries=10
    while [ $retries -gt 0 ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo -e "${RED}错误: 服务启动失败，请检查日志:${NC}"
            echo "  $LOG_FILE"
            rm -f "$PID_FILE"
            exit 1
        fi

        if curl -s "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
            echo -e "${GREEN}✅ 服务已启动 (PID: $pid)${NC}"
            echo "   访问地址: http://localhost:$port"
            echo "   日志文件: $LOG_FILE"
            echo ""
            echo "   停止服务: $0 stop"
            echo "   查看状态: $0 status"
            echo "   实时日志: tail -f $LOG_FILE"
            return 0
        fi

        retries=$((retries - 1))
        sleep 0.5
    done

    echo -e "${YELLOW}服务进程已启动 (PID: $pid)，但健康检查未通过${NC}"
    echo "  请检查日志: $LOG_FILE"
}

kill_by_port() {
    local port="${SERVER_PORT:-3000}"
    lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null
}

stop_process() {
    local pid="$1"
    echo -e "${YELLOW}正在停止服务 (PID: $pid)...${NC}"
    kill "$pid" 2>/dev/null

    local retries=20
    while [ $retries -gt 0 ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo -e "${GREEN}✅ 服务已停止${NC}"
            return 0
        fi
        retries=$((retries - 1))
        sleep 0.5
    done

    echo -e "${YELLOW}超时，强制终止...${NC}"
    kill -9 "$pid" 2>/dev/null
    echo -e "${GREEN}✅ 服务已强制停止${NC}"
}

do_stop() {
    # 优先通过 PID 文件停止
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            stop_process "$pid"
            rm -f "$PID_FILE"
            return 0
        fi
        rm -f "$PID_FILE"
    fi

    # 无 PID 文件时，通过端口查找进程
    local port="${SERVER_PORT:-3000}"
    local pids
    pids=$(kill_by_port)

    if [ -z "$pids" ]; then
        echo -e "${YELLOW}服务未运行${NC}"
        return 0
    fi

    echo -e "${YELLOW}未找到 PID 文件，通过端口 $port 查找进程${NC}"
    for pid in $pids; do
        stop_process "$pid"
    done
}

do_restart() {
    echo -e "${YELLOW}重启服务...${NC}"
    do_stop
    sleep 1
    do_start
}

do_status() {
    if is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        local port="${SERVER_PORT:-3000}"
        echo -e "${GREEN}● 服务运行中${NC}"
        echo "  PID:   $pid"
        echo "  端口:  $port"
        echo "  日志:  $LOG_FILE"

        # 健康检查
        local health
        health=$(curl -s "http://127.0.0.1:$port/api/health" 2>/dev/null)
        if [ -n "$health" ]; then
            echo "  状态:  正常"
        else
            echo -e "  状态:  ${YELLOW}健康检查未响应${NC}"
        fi

        # 进程信息
        echo ""
        echo "  进程信息:"
        ps -p "$pid" -o pid,ppid,%cpu,%mem,etime,command 2>/dev/null | tail -n +2 | sed 's/^/    /'
    else
        echo -e "${RED}● 服务未运行${NC}"
        return 1
    fi
}

# 主入口
case "${1:-}" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_restart ;;
    status)  do_status ;;
    *)       usage ;;
esac
