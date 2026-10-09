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
├── Dockerfile               # 两阶段构建：build 装依赖并编译原生模块 → runtime 仅留 ffmpeg
├── docker-compose.yml       # travelmap + 内置 minio 两服务；数据绑定挂载 ./data、./minio-data
├── .dockerignore            # 忽略 node_modules / *.db / data/media（seed 仍打进镜像）
├── .env.example             # 可配置 MINIO_DATA_DIR / APP_DATA_DIR 等
└── .gitignore
```

> ⚠️ `data/` 与 `minio-data/` 是**运行时产生的持久数据**，不会进镜像、也不会进 git（见 `.gitignore`）。部署后它们会出现在项目根目录，直接可见、可备份。

---

## 三、使用方法

### 1. 环境要求

- 安装了 **Docker + Docker Compose**：
  - **这台电脑（macOS）**：装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，启动后再执行下面的命令。
  - **小主机（Linux）**：`curl -fsSL https://get.docker.com | sh` 后 `sudo usermod -aG docker $USER`。
- 首次构建需要联网拉取依赖并编译原生模块（better-sqlite3 / sharp）。**国内网络已预配阿里云 apt / npm 镜像**，正常约几分钟；不要在国内网络下把 Dockerfile 里的镜像源改回官方源。

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

- **构建卡在 apt / npm 超时**：国内网络已改阿里云镜像；若在海外机器，把 Dockerfile 里的 `mirrors.aliyun.com` 与 `registry.npmmirror.com` 改回官方源即可。
- **向导提交报 `EPROTO wrong version number`**：勾了「启用 HTTPS」但端点其实是 HTTP（内置 MinIO 就是 HTTP）。取消勾选再提交。
- **登录后地图/数据空白**：确认 `ADMIN_PASSWORD` 与登录密码一致；控制台看 `docker compose logs travelmap` 有无 SQLite / MinIO 连接报错。
- **数据丢了？** 检查 `./data/travelmap.db` 是否还在；容器重建不会动绑定挂载的目录。

---

## 许可证 / 说明

本项目为个人自托管用途。地图国界与地区标注遵循相关规范，数据展示仅作个人足迹记录之用。
