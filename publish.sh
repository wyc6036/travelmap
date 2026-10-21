#!/usr/bin/env bash
# =========================================================
# publish.sh · 构建并推送多架构镜像到 Docker Hub（amd64 + arm64）
# ---------------------------------------------------------
# 一个脚本两条路线，默认直连，加 --proxy 走守护进程（Mac / 墙内用）。
#
# 用法：
#   ./publish.sh <DockerHub用户名> [版本标签=v1] [选项]
#
#   选项：
#     --proxy [端口]   走「守护进程 + 代理」路线（默认端口 7890 / 环境变量 PROXY_PORT）
#                      分架构 build → push → imagetools 合成多架构索引
#     --port <端口>    只改代理端口
#     -h, --help       显示帮助
#
# 例：
#   ./publish.sh wyc6036                # 路线 A：直连，推 :v1 与 :latest
#   ./publish.sh wyc6036 v4             # 路线 A：推 :v4 与 :latest
#   ./publish.sh wyc6036 v4 --proxy     # 路线 B：Mac 挂代理（7890）
#   ./publish.sh wyc6036 v4 --proxy 7891
#
# 前置：
#   docker login（两条路线都需要）
#   路线 B 另需：Docker Desktop 代理填 http://127.0.0.1:<端口>
#                + 代理客户端开 Allow LAN、切全局模式
#
# 两条路线的原理、为什么 Mac 上 buildx 会失败、完整报错速查表：
#   见 docs/PUBLISHING.md
# =========================================================
set -euo pipefail

usage() {
  # 打印脚本头部注释块（shebang 之后连续的 # 行）
  awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 && !/^#/ {exit}' "$0"
}

DH_USER=""
VERSION=""
METHOD="buildx"
PROXY_PORT="${PROXY_PORT:-7890}"

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage; exit 0 ;;
    --proxy)
      METHOD="daemon"; shift
      if [[ "${1:-}" =~ ^[0-9]+$ ]]; then PROXY_PORT="$1"; shift; fi
      continue ;;
    --proxy=*)
      METHOD="daemon"; PROXY_PORT="${1#*=}"; shift; continue ;;
    --port)
      [ $# -ge 2 ] || { echo "FATAL: --port 缺少端口号" >&2; exit 1; }
      PROXY_PORT="$2"; shift 2; continue ;;
    --*)
      echo "FATAL: 未知参数 $1" >&2; echo; usage; exit 1 ;;
    *)
      if   [ -z "$DH_USER" ]; then DH_USER="$1"
      elif [ -z "$VERSION" ]; then VERSION="$1"
      else echo "FATAL: 多余参数 $1" >&2; exit 1
      fi
      shift ;;
  esac
done

[ -n "$DH_USER" ] || { echo "FATAL: 缺少 Docker Hub 用户名，例：./publish.sh wyc6036 v4" >&2; echo; usage; exit 1; }
VERSION="${VERSION:-v1}"
IMAGE="$DH_USER/travelmap"
PROXY="http://127.0.0.1:${PROXY_PORT}"

[ -f Dockerfile ] || { echo "FATAL: 当前目录没有 Dockerfile，请在项目根目录执行" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "FATAL: Docker 守护进程不可用（Docker Desktop 起了吗？）" >&2; exit 1; }

echo "镜像: docker.io/$IMAGE"
echo "版本: ${VERSION}（同时更新 :latest）"
echo "路线: $([ "$METHOD" = daemon ] && echo "B 守护进程 + 代理 $PROXY" || echo "A 直连 buildx")"
echo ""

if [ "$METHOD" = "buildx" ]; then
  # ── 路线 A：一次构建两架构并推送 manifest list ──────────────
  echo "==> 1/2 多架构构建并推送 (linux/amd64 + linux/arm64)"
  docker buildx build --platform linux/amd64,linux/arm64 \
    -t "$IMAGE:$VERSION" \
    -t "$IMAGE:latest" \
    --push . || {
      echo "" >&2
      echo "构建/推送失败。" >&2
      echo "· 若是 i/o timeout、IP 为 31.13.x / 199.59.x / 202.160.x：DNS 被污染，改走代理路线：" >&2
      echo "    ./publish.sh $DH_USER $VERSION --proxy" >&2
      echo "· 详见 docs/PUBLISHING.md 第七节报错速查" >&2
      exit 1
    }
  echo ""
  echo "==> 2/2 完成 ✅"
else
  # ── 路线 B：守护进程构建/推送 + CLI 合成索引 ────────────────
  # CLI 侧命令（imagetools / login / manifest）不吃守护进程代理，必须靠 shell 环境变量
  export HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" NO_PROXY="localhost,127.0.0.1"

  push_with_retry() {
    local ref="$1"
    for i in 1 2 3 4 5; do
      if docker push "$ref"; then return 0; fi
      echo "  !! 推送 $ref 第 $i 次失败（多为代理抖动，push 会续传），3s 后重试..."
      sleep 3
    done
    echo "FATAL: $ref 推送 5 次仍失败" >&2; return 1
  }

  echo "==> 1/6 切到 default builder（走守护进程，避开 docker-container builder 的代理注入问题）"
  docker buildx use default

  echo "==> 2/6 构建 linux/amd64"
  docker build --platform linux/amd64 -t "$IMAGE:$VERSION-amd64" .

  echo "==> 3/6 构建 linux/arm64"
  docker build --platform linux/arm64 -t "$IMAGE:$VERSION-arm64" .

  echo "==> 4/6 推送 amd64 / arm64（守护进程经代理，失败自动续传重试）"
  push_with_retry "$IMAGE:$VERSION-amd64"
  push_with_retry "$IMAGE:$VERSION-arm64"

  echo "==> 5/6 合成并推送多架构索引（imagetools，勿用 docker manifest create）"
  docker buildx imagetools create -t "$IMAGE:$VERSION" "$IMAGE:$VERSION-amd64" "$IMAGE:$VERSION-arm64"
  docker buildx imagetools create -t "$IMAGE:latest"  "$IMAGE:$VERSION-amd64" "$IMAGE:$VERSION-arm64"

  echo "==> 6/6 验证多架构索引"
  docker buildx imagetools inspect "$IMAGE:$VERSION"

  echo ""
  echo "==> 完成 ✅"
  echo "中间 tag「$VERSION-amd64 / $VERSION-arm64」可在 hub.docker.com 的 Tags 页删除，不影响上面的多架构 tag。"
fi

echo ""
echo "部署机（x86 / ARM 通用）只需 docker-compose.yml + .env，然后："
echo "  docker compose pull && docker compose up -d    # 注意不要加 --build"
