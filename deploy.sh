#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/MengxingFusheng/Jusha-Dashboard.git}"
BRANCH="${BRANCH:-master}"
APP_DIR="${APP_DIR:-$HOME/Jusha-Dashboard}"
CONTAINER_NAME="${CONTAINER_NAME:-jusha-dashboard}"
IMAGE_NAME="${IMAGE_NAME:-jusha-dashboard:latest}"
HOST_PORT="${HOST_PORT:-3000}"
CONTAINER_PORT="${CONTAINER_PORT:-3000}"
DATA_VOLUME="${DATA_VOLUME:-jusha-dashboard-data}"
ENV_FILE="${ENV_FILE:-.env}"

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令: $1，请先安装后再运行。"
    exit 1
  fi
}

need_cmd git
need_cmd docker

if ! docker info >/dev/null 2>&1; then
  echo "Docker 未运行或当前用户没有 Docker 权限。"
  echo "可以先执行: sudo systemctl start docker"
  echo "如果是权限问题: sudo usermod -aG docker \$USER，然后重新登录。"
  exit 1
fi

if [ -d "$APP_DIR/.git" ]; then
  log "更新项目: $APP_DIR"
  cd "$APP_DIR"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
elif [ -e "$APP_DIR" ] && [ "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then
  echo "目录已存在且不是空目录: $APP_DIR"
  echo "请删除该目录，或用 APP_DIR=/其它路径 bash deploy.sh 指定新目录。"
  exit 1
else
  log "克隆项目到: $APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

if [ ! -f "$ENV_FILE" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example "$ENV_FILE"
    log "已创建 $ENV_FILE，如需 Server酱推送，请修改其中的 SENDKEY 配置后重新运行本脚本。"
  else
    touch "$ENV_FILE"
    log "未找到 .env.example，已创建空的 $ENV_FILE。"
  fi
fi

log "构建 Docker 镜像: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" .

log "停止并删除旧容器: $CONTAINER_NAME"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

log "启动容器并映射端口: ${HOST_PORT}:${CONTAINER_PORT}"
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  --env-file "$ENV_FILE" \
  -v "${DATA_VOLUME}:/app/data" \
  "$IMAGE_NAME"

if command -v curl >/dev/null 2>&1; then
  log "检查服务是否可访问"
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${HOST_PORT}/api/state" >/dev/null 2>&1; then
      log "部署完成: http://127.0.0.1:${HOST_PORT}"
      docker ps --filter "name=${CONTAINER_NAME}"
      exit 0
    fi
    sleep 1
  done

  echo "容器已启动，但服务检查超时。最近日志如下："
  docker logs --tail 80 "$CONTAINER_NAME"
  exit 1
fi

log "部署完成: http://127.0.0.1:${HOST_PORT}"
docker ps --filter "name=${CONTAINER_NAME}"
