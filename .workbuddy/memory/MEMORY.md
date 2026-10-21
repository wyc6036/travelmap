# 项目长期记忆 · travelmap

## 模块边界（最高优先级，勿触碰）
- **地图模块禁改**：`web/js/{map,markers,geo,countries,legend,detail-modal,route}.js` 及其相关 CSS（地图卡/打点/国家上色/图例/弹窗/路线回放）一律保持原样；前端改造只限首页/小组件层（`ui.js` createUI、`layout.css`/`widget.css`、`index.html` 首页区）。
- 例外：①用户明确指出 bug 才可改地图模块；②2026-10-17 授权给「地点详情弹窗」加全屏左右分栏（纯增量，已固化）；③「底图失败 toast+退避重试」经授权改过 map.js，已固化；④换天地图/高德/腾讯合规源——用户明确不做。

## 愿望清单（2026-10-17~18 重设计 + 后端持久化）
- **服务端权威**：SQLite `wish_annotations`(place_id PK,wish,priority,note,target,added_at) + `wish_places`(id PK,name,country,lng,lat,priority,note,target,added_at)，见 `src/db.js`、`web/js/api.js`（GET/PUT/POST/DELETE `/api/wishes...`）。localStorage 仅离线镜像：`travelmap.wish.v1`（按 place.id）、`travelmap.wish.places.v1`（用户自建地点 `isWishNew:true`）。`web/js/wishstore.js` 是唯一数据源，`ui.js`/`upload.js` 共用；写操作乐观本机 + fire-and-forget 上云，`initWishes()` 幂等（服务端空且本机有数据→一次性迁移）。
- 入口只从愿望清单「＋ 添加心愿」面板进；`upload.js` 已删「目的地」选项（`isWished` 派生保留向后兼容）。
- 坑：①`renderWishlistView()` 必须始终渲染 `.wl` 外壳+工具栏+添加面板，零心愿不能提前 return；②`saveWishPlace` 无坐标必须存 NULL（存 0 会漂到几内亚湾被误判有坐标）；检测 `!Number.isFinite(lng/lat)`；③国家/城市补全下拉挂 `input.parentElement`，label+input 须各包 `.wl-add__row`；坐标优先级 `wishCityGeo > wishCountryGeo`；④`countries.js`（地图）与 `country-centroids.js`（心愿补全）有意并行，不合并；⑤已取消分流：`isWishNew`→`deleteWishPlace`，真实足迹→`setAnn({wish:undefined})`；⑥愿望地图 lng/lat 等距投影自绘 + `assets/world-silhouette.svg` 底图，不新建 MapLibre 实例。

## 首页小组件（iOS 磁贴）
- 尺寸离散 1x1/2x1/1x2/2x2/3x2；已实现 recent/wishlist/collections/poster + 编辑态（拖拽/尺寸/替换/移除/重置布局，`travelmap.layout.v1`）；二阶段 4 组件（pending/lastTrip/roulette/month）仍 comingSoon 占位。

## 运行 / 测试环境
- 沙箱 `HTTP_PROXY=127.0.0.1:54072`；访问本机端口要 `--noproxy` 或 Playwright `bypass:'<-loopback>'`（curl 用 `--noproxy '*'`）。前端 ESM 必须经 HTTP 访问，不能 `file://`。
- 后端测试：`PORT=8126 node server.js`（不带 `MINIO_*` → 自动本地磁盘模式，秒起；**不要改 DB 的 storageConfig**）。Playwright 走 managed node：`/Users/wyc/.workbuddy/binaries/node/workspace`（chromium-1244 已装，`NODE_PATH` 指向该 node_modules）。
- Playwright 写操作会污染 dev DB，跑完清 `wish_annotations`/`wish_places`；`.wl-card [data-act="edit"]` 会命中第一张卡，须按 `data-id`/心愿名精确定位。
- 后台进程用 `run_in_background`，不要 `&`。`preview/` 截图与 `data/*.db-wal/.db-shm` 属产物，应 gitignore。

## Docker / 部署
- MinIO 镜像已换 `cgr.dev/chainguard/minio:latest`（官方 2025-10 起停发 Docker 镜像，勿改回 `minio/minio`）；app 侧 S3 协议/桶/端口全兼容。
- **推 Docker Hub 的最终成功方案（2026-10-21 跑通）**：Mac 挂代理 `http://127.0.0.1:7890`（**必须 http://，填 https:// 会对代理本身 TLS 握手 → EOF**）+ Clash 开 **Allow LAN** + 全局模式。**`docker buildx --push` 推不了**（其 `--driver-opt env.HTTP_PROXY` 对 docker-container builder 的 buildkitd 拉基础镜像不生效，buildkitd 仍直连投毒 IP → i/o timeout）。**改用守护进程**：`docker buildx use default` → `docker build --platform linux/amd64 -t <img>:<tag>-amd64 .` 与 `--platform linux/arm64 ...-arm64 .` 各建一次 → 各自 `docker push`（守护进程代理能成；偶发 commit 超时重试续传）→ **合成多架构必须用 `docker buildx imagetools create -t <img>:<tag> <img>:<tag>-amd64 <img>:<tag>-arm64`（别用老的 `docker manifest create`，会报 `<tag>-amd64 is a manifest list` 拒绝）**。已成功产出 `wyc6036/travelmap:v3` 与 `:latest` 的 amd64+arm64 OCI index（附带的 unknown/unknown attestation 条目正常）。⚠️ 代理分工：`docker push/pull` 走**守护进程**代理（Docker Desktop 设置）；`docker buildx imagetools`/`docker manifest`/`docker login` 是 **CLI 直连 registry**、不吃守护进程代理，需 shell `export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890` 才通。已封装为脚本 **`publish-mac.sh`**（`./publish-mac.sh <user> <tag> [代理端口=7890]`，与服务器用的 `publish.sh` 并存；内含 export 代理、`buildx use default`、分架构 build+push 重试、`imagetools create` 合成 v3+latest）。

## 可删死代码（2026-10-18 静态审查，0 引用）
- 应用层：`auth.js:isAuthEnabled`、`wishstore.js:onWishChange`、`utils.js:lerp`/`formatDateCn`、`data.js:isValidMediaType`。地图模块内的（`countries.js:visitedColorMap` 等）边界内暂勿动。
