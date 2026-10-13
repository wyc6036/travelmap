#!/usr/bin/env bash
# =========================================================
# publish.sh · 构建并推送多架构镜像到 Docker Hub (amd64 + arm64)
# 用法:
#   ./publish.sh <Docker Hub 用户名> [版本标签, 默认 v1]
# 例:
#   ./publish.sh wyc6036          # 推 wyc6036/travelmap:v1 和 :latest（含 amd64+arm64）
#   ./publish.sh wyc6036 v2       # 推 wyc6036/travelmap:v2 和 :latest
# 前置:
#   1) docker login
#   2) 多架构构建一般 Docker Desktop 已内置（QEMU 模拟就绪，builder 支持 amd64/arm64），
#      通常无需额外操作。若 buildx 报错说找不到 amd64 平台，再一次性启用：
#      docker buildx create --use
#      docker run --privileged --rm tonistiigi/binfmt --install all
# 说明: 用 docker buildx 一次打出 amd64 + arm64 两个架构并推送 manifest list，
#       这样无论是 ARM（Mac/树莓派）还是 x86 机器都能直接拉到对应架构的镜像，
#       不会出现 "manifest unknown / 404" 的架构不匹配问题。
# 国内 Docker Hub 污染时（registry-1.docker.io 返回 Bad Gateway，拼 manifest list 失败），
# 可退化为「分两次单架构构建 + 推送」，见 README「五、3」与 Dockerfile 的 ARG NODE_BASE。
# Dockerfile 已支持 ARG NODE_BASE（默认 node:20-slim），国内可传本地真实架构 node 镜像避免错架构 base。
# =========================================================
set -euo pipefail

DH_USER="${1:?缺少参数：请传入你的 Docker Hub 用户名，例如 ./publish.sh wyc6036}"
VERSION="${2:-v1}"
IMAGE="$DH_USER/travelmap"

echo "==> 1/2 多架构构建并推送 (linux/amd64 + linux/arm64)"
docker buildx build --platform linux/amd64,linux/arm64 \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  --push .

echo "==> 2/2 完成 ✅"
echo "镜像地址: docker.io/$IMAGE:latest  (含 amd64 + arm64)"
echo "部署机（无论 x86 还是 ARM）只需 docker-compose.prod.yml + .env，然后执行："
echo "  docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d"
