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

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "This step needs root permission. Run as root or install sudo."
    exit 1
  fi
}

pm_install() {
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y "$@"
  else
    echo "No supported package manager found. Please install: $*"
    exit 1
  fi
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return
  fi
  log "Installing git"
  pm_install git
}

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    return
  fi
  log "Installing curl"
  pm_install curl
}

install_docker_with_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y docker.io
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y docker || run_as_root dnf install -y moby-engine
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y docker || run_as_root yum install -y docker-ce docker-ce-cli containerd.io
  else
    return 1
  fi
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker"
    if ! install_docker_with_packages; then
      ensure_curl
      curl -fsSL https://get.docker.com | run_as_root sh
    fi
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_as_root systemctl enable --now docker >/dev/null 2>&1 || run_as_root systemctl start docker >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    run_as_root service docker start >/dev/null 2>&1 || true
  fi

  if docker info >/dev/null 2>&1; then
    USE_SUDO_DOCKER=0
  elif run_as_root docker info >/dev/null 2>&1; then
    USE_SUDO_DOCKER=1
  else
    echo "Docker is installed but not running, or Docker permission is not ready."
    echo "Try: sudo systemctl start docker"
    exit 1
  fi
}

docker_cmd() {
  if [ "${USE_SUDO_DOCKER:-0}" = "1" ]; then
    run_as_root docker "$@"
  else
    docker "$@"
  fi
}

ensure_git
ensure_docker

if [ -d "$APP_DIR/.git" ]; then
  log "Updating project: $APP_DIR"
  cd "$APP_DIR"
  git fetch origin "$BRANCH"
  git checkout -B "$BRANCH" "origin/$BRANCH"
elif [ -e "$APP_DIR" ] && [ "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then
  echo "Directory exists and is not empty: $APP_DIR"
  echo "Use another path, for example: APP_DIR=/opt/jusha-dashboard bash deploy.sh"
  exit 1
else
  log "Cloning project to: $APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

if [ ! -f "$ENV_FILE" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example "$ENV_FILE"
    log "Created $ENV_FILE from .env.example. Edit SENDKEY if ServerChan push is needed."
  else
    touch "$ENV_FILE"
    log "Created empty $ENV_FILE."
  fi
fi

log "Building Docker image: $IMAGE_NAME"
docker_cmd build -t "$IMAGE_NAME" .

log "Removing old container: $CONTAINER_NAME"
docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

log "Starting container on port ${HOST_PORT}:${CONTAINER_PORT}"
docker_cmd run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  --env-file "$ENV_FILE" \
  -v "${DATA_VOLUME}:/app/data" \
  "$IMAGE_NAME"

if command -v curl >/dev/null 2>&1; then
  log "Checking service"
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${HOST_PORT}/api/state" >/dev/null 2>&1; then
      log "Deploy finished: http://127.0.0.1:${HOST_PORT}"
      docker_cmd ps --filter "name=${CONTAINER_NAME}"
      exit 0
    fi
    sleep 1
  done

  echo "Container started, but service check timed out. Recent logs:"
  docker_cmd logs --tail 80 "$CONTAINER_NAME"
  exit 1
fi

log "Deploy finished: http://127.0.0.1:${HOST_PORT}"
docker_cmd ps --filter "name=${CONTAINER_NAME}"
