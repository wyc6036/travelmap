# =========================================================
# TravelMap 独立部署镜像
# 单进程：Express + SQLite(better-sqlite3) + 上传(sharp + ffmpeg)
# 所有持久数据落在挂载卷 /data（travelmap.db + media/）
# =========================================================

# ---------- 构建阶段：装依赖（含原生模块编译） ----------
FROM node:20-slim AS build
WORKDIR /app

# 国内构建提速：bridge 网络下 deb.debian.org 不通，apt 改走 aliyun 镜像
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/*.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true

# better-sqlite3 需要 gcc/make/python3 编译；sharp 0.33 自带 libvips 预编译，无需系统库
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# 国内构建提速：npm 指向 npmmirror（仅构建期；如需换回官方源可删掉这一行）
RUN npm config set registry https://registry.npmmirror.com/

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ---------- 运行阶段 ----------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

# 运行期只需 ffmpeg（视频转 H.264 + 抽首帧）；同样走 aliyun 镜像
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/*.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY server.js package.json ./
COPY src ./src
COPY web ./web
# 把现有 38 个地点作为初始种子打进镜像（首次启动自动导入，详见 db.js maybeSeed）
COPY data/seed ./seed

# 持久数据卷：数据库 + 上传的媒体
VOLUME ["/data"]
EXPOSE 8080

# 未设 ADMIN_PASSWORD 时对所有人开放（含写入）；生产务必通过环境变量设置强密码
CMD ["node", "server.js"]
