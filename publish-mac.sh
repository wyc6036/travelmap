#!/usr/bin/env bash
# =========================================================
# publish-mac.sh · Mac + 代理环境下推 Docker Hub 多架构镜像
# ---------------------------------------------------------
# 为什么需要它（而不是直接用 publish.sh 的 buildx --push）：
#   在 Mac + 代理环境下，`docker buildx build --push` 会失败——
#   docker-container builder 的 buildkitd 拿不到代理
#   （--driver-opt env.HTTP_PROXY 对它的镜像拉取不生效），
#   buildkitd 解析 auth.docker.io 时拿到投毒 IP → i/o timeout。
#   本脚本绕开 buildkit，走「守护进程」：
#     docker build（守护进程经代理拉基础镜像）
#     → docker push（守护进程经代理推送）
#     → docker buildx imagetools create（CLI 走 shell 代理，合成多架构）
#
# 用法:
#   ./publish-mac.sh <DockerHub用户名> [版本标签, 默认 v1] [代理端口, 默认 7890]
# 例:
#   ./publish-mac.sh wyc6036 v3
#
# 前置条件（一次性配置）:
#   1) Docker Desktop → Settings → Resources → Proxies
#        HTTP/HTTPS Proxy 都填 http://127.0.0.1:<代理端口>（必须 http://，别填 https://）
#   2) 代理客户端（Clash/Surge 等）开启 "Allow LAN / 允许局域网"，并切到全局模式
#   3) 已 docker login 登录 Docker Hub
#   4) 若 `docker build` 拉基础镜像仍超时，可在命令前加 DOCKER_BUILDKIT=0 强制走旧版守护进程构建
# =========================================================
set -euo pipefail

DH_USER="${1:?缺少参数：Docker Hub 用户名，如 ./publish-mac.sh wyc6036 v3}"
VERSION="${2:-v1}"
PROXY_PORT="${3:-7890}"
IMAGE="$DH_USER/travelmap"
PROXY="http://127.0.0.1:${PROXY_PORT}"

# CLI 侧命令（imagetools / login / manifest）不吃守护进程代理，必须靠 shell 环境变量
export HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" NO_PROXY="localhost,127.0.0.1"

push_with_retry() {
  local ref="$1"
  for i in 1 2 3 4 5; do
    if docker push "$ref"; then return 0; fi
    echo "  !! 推送 $ref 第 $i 次失败（多为代理抖动，push 会续传），3s 后重试..."
    sleep 3
  done
  echo "FATAL: $ref 推送 5 次仍失败"; return 1
}

echo "==> 1/6 切到 default builder（走守护进程，避开 docker-container builder 的代理注入问题）"
docker buildx use default

echo "==> 2/6 构建 linux/amd64"
docker build --platform linux/amd64 -t "$IMAGE:$VERSION-amd64" .

echo "==> 3/6 构建 linux/arm64"
docker build --platform linux/arm64 -t "$IMAGE:$VERSION-arm64" .

echo "==> 4/6 推送 amd64 / arm64（守护进程经代理推送，失败自动续传重试）"
push_with_retry "$IMAGE:$VERSION-amd64"
push_with_retry "$IMAGE:$VERSION-arm64"

echo "==> 5/6 合成并推送多架构 manifest（imagetools，勿用 docker manifest create）"
docker buildx imagetools create -t "$IMAGE:$VERSION" "$IMAGE:$VERSION-amd64" "$IMAGE:$VERSION-arm64"
docker buildx imagetools create -t "$IMAGE:latest" "$IMAGE:$VERSION-amd64" "$IMAGE:$VERSION-arm64"

echo "==> 6/6 验证多架构索引"
docker buildx imagetools inspect "$IMAGE:$VERSION"

echo ""
echo "完成 ✅  docker.io/$IMAGE:$VERSION 与 :latest（amd64 + arm64）"
echo "中间 tag「$VERSION-amd64 / $VERSION-arm64」可在 hub.docker.com 网页的 Tags 页删除，不影响上面的多架构 tag。"
