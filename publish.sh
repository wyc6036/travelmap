#!/usr/bin/env bash
# =========================================================
# publish.sh · 把 TravelMap 镜像构建并推送到 Docker Hub
# 用法:
#   ./publish.sh <你的 Docker Hub 用户名> [版本标签, 默认 v1]
# 例:
#   ./publish.sh myname          # 推 myname/travelmap:v1 和 :latest
#   ./publish.sh myname v2       # 推 myname/travelmap:v2 和 :latest
# 前置: 已执行 `docker login` 登录 Docker Hub
# 说明: 本机必须有源码（server.js / src / web / Dockerfile ...），
#       因为它要从源码 docker compose build 出镜像再推送。
# =========================================================
set -euo pipefail

DH_USER="${1:?缺少参数：请传入你的 Docker Hub 用户名，例如 ./publish.sh myname}"
VERSION="${2:-v1}"
LOCAL_IMAGE="travelmap-travelmap:latest"   # docker compose build 产出的本地镜像名
IMAGE="$DH_USER/travelmap"

echo "==> 1/4 构建镜像（从当前源码）"
docker compose build

echo "==> 2/4 打标签  $IMAGE:$VERSION  /  $IMAGE:latest"
docker tag "$LOCAL_IMAGE" "$IMAGE:$VERSION"
docker tag "$LOCAL_IMAGE" "$IMAGE:latest"

echo "==> 3/4 推送（若提示未登录，请先执行 docker login）"
docker push "$IMAGE:$VERSION"
docker push "$IMAGE:latest"

echo "==> 4/4 完成 ✅"
echo "部署机只需 docker-compose.prod.yml + .env，然后执行："
echo "  docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d"
echo "镜像地址: docker.io/$IMAGE:latest"
