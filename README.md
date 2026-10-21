# TravelMap · 独立部署版

把你原来纯静态的「旅行足迹地图」升级成一个**真正可用**的应用：可以**上传照片 / 视频 / 文字笔记**，也能**新增地点**，数据存在你自己的机器上（SQLite），全部打包进一个 Docker 镜像，跑在本地电脑或一台小主机上。

---

## 一、项目技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| **后端运行时** | Node.js 20（Express 4） | 单进程 HTTP 服务，同时托管前端静态文件与 REST API |
| **数据库** | better-sqlite3（SQLite） | 地点 / 行程 / 媒体元数据存 `/data/travelmap.db`，零外部依赖、单文件可备份 |
| **媒体对象存储** | MinIO（S3 兼容） | 照片 / 视频 / 缩略图存对象存储；默认随 compose 起一个内置 `minio` 服务，也可指向自建 MinIO / 阿里云 OSS / 任意 S3 |
| **图片处理** | sharp | 上传图片压成 1600px 原图 + 720px 缩略图（webp） |
| **视频转码** | ffmpeg | iPhone 的 HEVC/H.265 转成 H.264 + 抽首帧海报，保证全平台能播 |
| **上传中间件** | multer | 先落临时目录再转码上传，限制单文件大小 |
| **前端** | 原生 HTML / CSS / ESM（**零构建**） | MapLibre GL JS + OpenFreeMap 矢量瓦片；渲染层（地图 / 海报墙 / 统计）基本沿用原项目，后端只需提供与 `places.json` 同构的数据 |
| **鉴权** | 单密码 + HMAC 会话 cookie | 环境变量 `ADMIN_PASSWORD` 设密码；不设 = 开放访问（仅本地测试用） |
| **部署** | Docker + Docker Compose | 两阶段镜像（构建期编译原生模块，运行期仅留 ffmpeg），`travelmap` + `minio` 两个服务 |

---

## 二、项目结构

```
travelmap/
├── server.js                # Express 入口：静态托管 + REST API + 上传转码 + 首屏配置向导
├── src/
│   ├── db.js                # SQLite 数据层；导出与 places.json 同构的数据；库为空时自动 seed
│   ├── auth.js              # 单密码登录 / 会话校验（HMAC 签名 httpOnly cookie）
│   └── storage.js           # 媒体存储抽象：MinIO（默认）/ 本地目录；可变配置 + 连通性测试
├── web/                     # 前端（原生 HTML/CSS/ESM，零构建，由 Express 直接托管）
│   ├── index.html           # 页面骨架：登录遮罩、首屏配置向导 #tm-setup、记录新足迹弹窗
│   ├── css/                 # app.css（新增 UI/向导样式）+ base/layout/components/modal/poster/tokens
│   └── js/
│       ├── main.js          # 启动编排：初始化鉴权 → 首屏向导 → 渲染主界面
│       ├── api.js           # 后端接口封装（含 getSetup / saveSetup）
│       ├── auth.js          # 登录态管理
│       ├── setup.js         # 首屏配置向导逻辑（拉取预填值、提交保存）
│       ├── upload.js        # 新增地点 + 上传媒体
│       ├── data.js / config.js / ui.js / detail-modal.js
│       └── map.js / poster.js / markers.js / stats.js / legend.js / route.js / geo.js / countries.js / utils.js
├── data/                    # 运行时数据目录（绑定挂载到宿主机，见下文）
│   ├── seed/places.json     # 初始种子（38 个示例地点）；首次启动自动导入
│   ├── travelmap.db*        # 运行时生成的 SQLite 库（gitignore 忽略）
│   └── media/               # 本地目录模式下上传的媒体（gitignore 忽略）
├── Dockerfile               # 两阶段构建：build 装依赖并编译原生模块 → runtime 仅留 ffmpeg；含可选 ARG NODE_BASE
├── docker-compose.yml       # 唯一编排文件：开发 `--build` 本地构建 / 部署 `pull` 拉镜像都用它；
│                            #   travelmap + 内置 minio 两服务，配置全走 .env，数据绑定挂载 ./data、./minio-data
├── docker-compose.tunnel.yml # 可选 overlay：额外起 cloudflared 边车，把 8080 通过 CF 隧道暴露公网
├── publish.sh               # 唯一发布脚本：构建并推送多架构镜像；`--proxy` 切到 Mac/墙内路线（见「五」）
├── docs/
│   └── PUBLISHING.md        # 运维手册：发布镜像的两条路线、验证、清理、报错速查、代理分工
├── preview/                 # 本地验收产物（Playwright 脚本 + 截图），已 gitignore，不参与构建
├── .dockerignore            # 忽略 node_modules / *.db / data/media / minio-data（seed 仍打进镜像）
├── .env.example             # 配置模板：APP_PORT / DH_USER / ADMIN_PASSWORD / MINIO_* / 数据目录
└── .gitignore
```

> ⚠️ `data/` 与 `minio-data/` 是**运行时产生的持久数据**，不会进镜像、也不会进 git（见 `.gitignore`）。部署后它们会出现在项目根目录，直接可见、可备份。

---

## 三、使用方法

### 1. 环境要求

- 安装了 **Docker + Docker Compose**：
  - **这台电脑（macOS）**：装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，启动后再执行下面的命令。
  - **小主机（Linux）**：`curl -fsSL https://get.docker.com | sh` 后 `sudo usermod -aG docker $USER`。
- 首次构建需要联网拉取依赖并编译原生模块（better-sqlite3 / sharp）。**国内网络已预配多镜像兜底**：apt 走 ustc / tuna / 163 / 华为云 / 阿里云 / 腾讯云 的循环（任一通即用，单镜像站偶尔 502 会自动换下一个），npm 走 npmmirror；正常约几分钟。不要在国内网络下把 Dockerfile 里的镜像源改回官方源。

### 2. 本地一键启动（这台电脑）

```bash
# 1) 进入项目目录
cd travelmap

# 2)（可选但推荐）建一份 .env 改密码
cp .env.example .env
#   编辑 .env：把 ADMIN_PASSWORD 改成你的强密码；
#   建议 SESSION_SECRET 填 `openssl rand -hex 32` 的输出（容器重启后已登录会话不失效）

# 3) 构建并启动（首次会编译，稍慢）
docker compose up -d --build

# 4) 看日志确认起好了
docker compose logs -f travelmap
```

浏览器打开 **http://localhost:8080**，用你设的密码登录。首次启动会自动把 38 个示例地点导入数据库，之后以你上传 / 新增的数据为准。

> 想停掉：`docker compose down`（数据在 `./data`、`./minio-data` 里，不会丢）。

> 📦 **关于内置 MinIO 镜像**：MinIO 官方自 2025-10 起停止分发 Docker 镜像（社区版改为仅源码发布），Docker Hub / Quay 上的 `minio/minio` 镜像已全部下线、`docker pull` 报 `not found`。因此 compose 里的 minio 服务已改用 **Chainguard 从官方源码持续重建的免费镜像** `cgr.dev/chainguard/minio:latest`（同一份 MinIO，S3 协议与数据格式完全兼容，默认非 root 运行；现有 `./minio-data` 可直接挂载沿用，无需迁移）。详见 [Chainguard 公告](https://www.chainguard.dev/unchained/secure-and-free-minio-chainguard-containers)。

### 3. 首屏配置向导（首次必看）

第一次进入（或 `setupDone` 标记被清掉时）会弹出**配置向导**，让你选媒体存哪：

- **对象存储 MinIO（默认）**：表单已预填好**内置 MinIO** 的连接信息——地址 `minio`、端口 `9000`、账号 `travelmap`、密码 `changeme-minio-password`、桶 `travelmap`。**直接点「保存并进入」即可。**
  - 也可以在这里改成你自建的 MinIO，或阿里云 OSS / 任意 S3（填对应的 endpoint / accessKey / secretKey / bucket）。
- **本地目录**：填服务器上一个绝对路径（如 `/data/media`），媒体直接写磁盘。

⚠️ **内置 MinIO 是 HTTP**，`minio:9000` 没有 HTTPS。向导里的「启用 HTTPS」**不要勾**——勾了提交会报 `EPROTO wrong version number`（SSL 握手失败）。只有当你指向的 MinIO / OSS 端点本身启用了 HTTPS 才勾。

> 向导只决定「连哪个 MinIO / 用哪个桶 / 还是用本地目录」。MinIO 自己的**磁盘落盘路径**由 `docker-compose.yml` 里 minio 服务的卷决定，不在网页里配。
> 向导提交后写入 `meta` 表，之后改配置可直接在向导里改，或清掉 `setupDone` 标记重新走一遍。

### 4. 数据存在哪（绑定挂载）

默认两个目录都**直接挂到项目根目录**，Finder / 文件管理器里看得见，方便备份：

| 目录 | 内容 | 对应 compose 卷 |
|------|------|----------------|
| `./data` | SQLite 库 `travelmap.db*` + 本地目录模式的媒体 | `${APP_DATA_DIR:-./data}:/data` |
| `./minio-data` | MinIO 对象（含 `.minio.sys` 与 `travelmap` 桶） | `${MINIO_DATA_DIR:-./minio-data}:/data` |

想换成别的路径（比如一块大硬盘）：在 `.env` 里写 `APP_DATA_DIR=/你的/绝对/路径` 或 `MINIO_DATA_DIR=/你的/绝对/路径`，再 `docker compose up -d`。

不想用内置 MinIO：删掉 `docker-compose.yml` 里的 `minio` 服务，并把 `travelmap` 服务的 `MINIO_ENDPOINT` 改成你自己的 MinIO / S3 地址即可（向导里也能改）。

### 5. 日常使用

- **记录新足迹**：点顶部「记录新足迹」→ 填名称 / 类型 / 日期 / 经纬度（可点「在地图上拾取坐标」）→ 选照片 / 视频或写笔记 → 保存。地图与海报墙自动刷新。
- **视频**：iPhone 拍的 HEVC 会在服务端转成 H.264（等几秒到几十秒），转完才出现在墙上。
- **编辑已有数据**：删除 / 修改地点与行程的接口已就绪（`PUT/DELETE /api/places/:id` 等），目前 UI 以新增 / 上传为主，后续可补编辑界面。

### 6. 外部访问（没有公网 IP 时）

- **Tailscale**（推荐，免费私网）：把小主机和你的手机 / 笔记本加入同一个 Tailscale 网络，直接用分配的 `http://<机器名>:8080` 访问，全程加密，无需公网 IP / 域名 / 打洞。
- **Cloudflare Tunnel**（免费公网域名）：`cloudflared tunnel --url http://localhost:8080`，拿到一个 `*.trycloudflare.com` 地址（或绑自己的域名）。

### 7. 备份与迁移

因为是绑定挂载，备份就是拷文件夹：

```bash
# 停服务后整目录复制即可
docker compose down
cp -r ./data            /你的备份/data
cp -r ./minio-data      /你的备份/minio-data
```

- **整体迁移到新机器**：把 `./data` 和 `./minio-data` 一起带走挂上，数据库与媒体互不丢失。
- **重置示例数据**：删掉 `./data/travelmap.db*` 再启动，会从 `data/seed/places.json`（优先）或镜像内置种子重新导入 38 个地点；媒体桶用 `mc rb` / `mc mb` 重建。

### 8. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | 服务监听端口 |
| `DATA_DIR` | `/data` | SQLite 数据库目录（容器内应挂卷） |
| `ADMIN_PASSWORD` | 空 | 空 = 开放访问（任何人可写）；**生产务必设强密码** |
| `SESSION_SECRET` | 随机 | 会话签名密钥；固定它可让容器重启后会话不失效 |
| `MAX_UPLOAD_MB` | `500` | 单文件上传上限（MB） |
| `MINIO_ENDPOINT` | `minio` | MinIO/S3 主机名或 IP（compose 内即内置 minio 服务）；向导可覆盖 |
| `MINIO_PORT` | `9000` | MinIO/S3 端口 |
| `MINIO_USE_SSL` | `false` | 是否用 HTTPS 访问 MinIO（内置 MinIO 为 false） |
| `MINIO_ACCESS_KEY` | `travelmap` | Access Key（对应 MinIO 的 `MINIO_ROOT_USER`） |
| `MINIO_SECRET_KEY` | `changeme-minio-password` | Secret Key（对应 MinIO 的 `MINIO_ROOT_PASSWORD`） |
| `MINIO_BUCKET` | `travelmap` | 桶名（不存在会自动创建） |
| `MINIO_DATA_DIR` | `./minio-data` | MinIO 磁盘落盘目录（宿主机路径，compose 卷用） |
| `APP_DATA_DIR` | `./data` | 应用数据目录（宿主机路径，compose 卷用） |

> 这些变量是**初始默认值**，向导提交后会写进 `meta` 表并在运行时套用；之后以向导里保存的为准。

### 9. 本地开发（不打包直接跑）

```bash
npm install
ADMIN_PASSWORD=dev node server.js   # 访问 http://localhost:8080
```

> ⚠️ 原生模块 better-sqlite3 / sharp 需要本机有编译工具链（macOS 需 Xcode Command Line Tools，Linux 需 build-essential）。本地跑不起来时优先用上面的 Docker 方式。

### 10. 常见问题

- **构建卡在 apt / npm 超时**：Dockerfile 构建期已用多镜像兜底循环（ustc / tuna / 163 / 华为云 / 阿里云 / 腾讯云，任一通即用），npm 走 npmmirror，正常不用改。若仍卡在 apt，多半是容器内的 DNS 解析不到这些镜像站（容器内 DNS 与宿主机不同，单个站可能偶发 502）——可换用你网络下其他可达的 Debian 镜像源，或临时把构建机 DNS 改到公共 DNS 再构建；npm 若慢，把 `registry.npmmirror.com` 换成更快的镜像。海外机器可直接把镜像源改回官方源（删除 Dockerfile 里的兜底循环、npm 改 `registry.npmjs.org`）。
- **向导提交报 `EPROTO wrong version number`**：勾了「启用 HTTPS」但端点其实是 HTTP（内置 MinIO 就是 HTTP）。取消勾选再提交。
- **登录后地图/数据空白**：确认 `ADMIN_PASSWORD` 与登录密码一致；控制台看 `docker compose logs travelmap` 有无 SQLite / MinIO 连接报错。
- **数据丢了？** 检查 `./data/travelmap.db` 是否还在；容器重建不会动绑定挂载的目录。

---

## 四、从 Docker Hub 拉取部署（无需源码 / 换机器）

适用场景：镜像已经构建并推送到 Docker Hub（地址 `docker.io/<DH_USER>/travelmap`），现在要到一台**新机器**（如 x86 小主机）上运行。目标机器**不需要源码**，只要装了 Docker + Compose 即可。

> 本地这台电脑想自己改代码、自己构建，走上面的「二、本地一键启动」即可；本节能让你把做好的镜像一键部署到别的机器。

### 1. 前置

- 目标机器装好 Docker + Docker Compose（同「一、环境要求」）。
- **不需要 `docker login`**（拉的是公开镜像）。

### 2. 步骤

```bash
# 1) 把 docker-compose.yml 和 .env.example 传到目标机器
#    （git clone 后只取这两个文件也行；有源码也完全不影响，反正不会 build）

# 2) 建 .env 并填好关键项
cp .env.example .env
#   编辑 .env：
#     DH_USER=wyc6036                        # 你的 Docker Hub 用户名（决定镜像路径 docker.io/<DH_USER>/travelmap）
#     ADMIN_PASSWORD=<你的强密码>             # 必填
#     SESSION_SECRET=$(openssl rand -hex 32)  # 建议固定，容器重启后已登录会话不失效
#     APP_PORT=8080                          # 想换端口改这里（如 8081）
#     MINIO_DATA_DIR=./minio-data
#     APP_DATA_DIR=./data

# 3) 拉取并启动（注意：部署机不要加 --build）
docker compose pull
docker compose up -d

# 4) 看日志确认起好
docker compose logs -f travelmap
```

> ⚠️ **部署机千万不要用 `--build`**。`docker-compose.yml` 里同时写了 `image:` 和 `build:`（Compose 的「有则用、无则建」标准写法）：`up` 会**先尝试 pull，pull 不到才回退 build**。所以先 `pull` 就一定能拿到镜像、不会触发构建；而部署机上没有 Dockerfile，一旦 pull 失败（断网、标签写错）自动回退 build 就会报 `Dockerfile not found` —— 修好网络后重跑 `docker compose pull` 即可。默认文件名会被自动识别，`-f docker-compose.yml` 可省略不写。

浏览器打开 **http://\<机器IP\>:8080**，用你设的密码登录。镜像已内置 GeoNames 城市库与 38 个种子地点，首启自动导入，数据从 0 开始。

**更新 / 换机**：在新机器上重新执行 `pull && up -d` 即可（镜像已含最新代码）；回滚需保留旧版本标签。

### 3. 架构说明

镜像已发布为**多架构 OCI 索引（linux/amd64 + linux/arm64 合一）**，同一个标签自动匹配机器架构，**ARM 机器不用再改任何配置**：

| 标签 | 内含架构 | 适用机器 |
|------|----------|----------|
| `wyc6036/travelmap:latest` | amd64 + arm64 | x86 小主机 / Mac（Apple Silicon）/ 树莓派等，均可直接 `pull` |
| `wyc6036/travelmap:v3` | amd64 + arm64 | 同上，固定版本号，适合想锁版本的部署 |

> 多架构信息可用 `docker buildx imagetools inspect wyc6036/travelmap:latest` 核对（会列出 `linux/amd64` 与 `linux/arm64` 两条）。
> 回滚或锁版本时，把 `.env` 的 `DH_USER` 保持不动、在 compose 里把 `image: ...:latest` 临时改成 `:v3` 即可。

---

## 五、发布新版镜像（维护者）

把本地改动构建成镜像并推到 Docker Hub，供「四」里的部署机拉取。
**完整运维手册见 [docs/PUBLISHING.md](docs/PUBLISHING.md)**（原理、一次性前置、验证、中间 tag 清理、报错速查表都在那里）。

```bash
docker login                       # 只需一次
./publish.sh wyc6036 v4            # 路线 A：直连，一次出 amd64 + arm64 多架构索引
./publish.sh wyc6036 v4 --proxy    # 路线 B：Mac 挂代理（默认端口 7890，可写 --proxy 7891）
```

- **路线 A（直连 buildx）**：`buildx --push` 一次构建两架构。服务器或能直连 Docker Hub 的机器用它。
- **路线 B（守护进程 + 代理）**：`--proxy` 触发。分架构 `docker build` + `push`，再用 `imagetools create` 合成多架构索引。**Mac 上必须用这条**——`buildx` 的 docker-container builder 拿不到代理，会撞 DNS 投毒报 `i/o timeout`。
- Docker Desktop 代理怎么填、Clash 为什么必须开 Allow LAN、`scutil --proxy` 自检 → [docs/PUBLISHING.md](docs/PUBLISHING.md) 第一、二节
- `TLS connect ... EOF`、`is a manifest list`、`timeout awaiting response headers` 等报错对照表 → 该文档第七节
- 国内 `node:20-slim` 被镜像代理返回错架构时的 `NODE_BASE` 退化做法 → 该文档第七节末

---

## 许可证 / 说明

本项目为个人自托管用途。地图国界与地区标注遵循相关规范，数据展示仅作个人足迹记录之用。
