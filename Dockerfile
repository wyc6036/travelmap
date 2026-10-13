# =========================================================
# TravelMap 独立部署镜像
# 单进程：Express + SQLite(better-sqlite3) + 上传(sharp + ffmpeg)
# 所有持久数据落在挂载卷 /data（travelmap.db + media/）
# =========================================================

# ---------- 构建阶段：装依赖（含原生模块编译） ----------
# NODE_BASE 默认可不传；在国内 Docker Hub 污染时，可传本地已拉好的真实架构镜像，
# 例如 --build-arg NODE_BASE=node-arm64-real（arm64）或 node-amd64-real（amd64），
# 让 buildx 不联网解析 node:20-slim。
ARG NODE_BASE=node:20-slim
FROM ${NODE_BASE} AS build
WORKDIR /app

# 国内构建提速：bridge 网络下 deb.debian.org 可能不通，apt 改走多个国内镜像兜底
# （容器内 DNS 与宿主机不同，单个镜像站可能 502，故用「短超时 + 多镜像兜底」循环）
RUN set -ux; \
    echo 'Acquire::Retries "1";' > /etc/apt/apt.conf.d/99-fastfail; \
    echo 'Acquire::Connect::Timeout "8";' >> /etc/apt/apt.conf.d/99-fastfail; \
    echo 'Acquire::Timeout "120";' >> /etc/apt/apt.conf.d/99-fastfail; \
    rm -f /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; \
    OK=0; \
    for M in \
      "http://mirrors.ustc.edu.cn/debian" \
      "http://mirrors.tuna.tsinghua.edu.cn/debian" \
      "http://mirrors.163.com/debian" \
      "http://mirrors.huaweicloud.com/debian" \
      "http://mirrors.aliyun.com/debian" \
      "http://mirrors.cloud.tencent.com/debian" ; do \
      echo "deb $M bookworm main" > /etc/apt/sources.list.d/zz-mirror.list; \
      if apt-get update >/dev/null 2>&1 && apt-get install -y --no-install-recommends build-essential python3; then \
        echo ">> build deps installed via $M"; OK=1; break; \
      fi; \
      echo "!! $M 连不上或装包失败，换下一个"; \
    done; \
    rm -f /etc/apt/sources.list.d/zz-mirror.list; \
    rm -rf /var/lib/apt/lists/*; \
    if [ "$OK" != "1" ]; then echo ">> FATAL: 所有镜像都未能安装 build deps"; exit 1; fi

# 国内构建提速：npm 指向 npmmirror（仅构建期；如需换回官方源可删掉这一行）
RUN npm config set registry https://registry.npmmirror.com/

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ---------- 运行阶段 ----------
FROM ${NODE_BASE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

# 运行期只需 ffmpeg（视频转 H.264 + 抽首帧）。
# 各镜像站可达性因网络而异：用「短超时 + 多镜像兜底」循环（含 ustc / tuna / 163 / 华为云 / 阿里云 / 腾讯云），
# 第一个能装上 ffmpeg 的就用它（HTTP 80，免证书依赖）。
RUN set -ux; \
    echo 'Acquire::Retries "1";' > /etc/apt/apt.conf.d/99-fastfail; \
    echo 'Acquire::Connect::Timeout "8";' >> /etc/apt/apt.conf.d/99-fastfail; \
    echo 'Acquire::Timeout "120";' >> /etc/apt/apt.conf.d/99-fastfail; \
    rm -f /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; \
    OK=0; \
    for M in \
      "http://mirrors.ustc.edu.cn/debian" \
      "http://mirrors.tuna.tsinghua.edu.cn/debian" \
      "http://mirrors.163.com/debian" \
      "http://mirrors.huaweicloud.com/debian" \
      "http://mirrors.aliyun.com/debian" \
      "http://mirrors.cloud.tencent.com/debian" ; do \
      echo "deb $M bookworm main" > /etc/apt/sources.list.d/zz-mirror.list; \
      if apt-get update >/dev/null 2>&1 && apt-get install -y --no-install-recommends ffmpeg; then \
        echo ">> ffmpeg installed via $M"; OK=1; break; \
      fi; \
      echo "!! $M 连不上或装包失败，换下一个"; \
    done; \
    rm -f /etc/apt/sources.list.d/zz-mirror.list; \
    rm -rf /var/lib/apt/lists/*; \
    if [ "$OK" != "1" ]; then echo ">> FATAL: 所有镜像都未能安装 ffmpeg"; exit 1; fi

COPY --from=build /app/node_modules ./node_modules
COPY server.js package.json ./
COPY src ./src
COPY web ./web
# 把现有 38 个地点作为初始种子打进镜像（首次启动自动导入，详见 db.js maybeSeed）
COPY data/seed ./seed
# 离线逆地理编码城市库（GeoNames cities15000，约 3.4 万城市，城市级粒度）。
# 首次启动由 db.js.ensureGeocitiesLoaded() 导入 SQLite geocities 表（幂等、仅一次）。
COPY geonames_cities15000.txt ./geonames/cities15000.txt

# 持久数据卷：数据库 + 上传的媒体
VOLUME ["/data"]
EXPOSE 8080

# 未设 ADMIN_PASSWORD 时对所有人开放（含写入）；生产务必通过环境变量设置强密码
CMD ["node", "server.js"]
