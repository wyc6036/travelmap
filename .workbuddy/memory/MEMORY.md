# 项目长期记忆 · travelmap

## 模块边界约束
- **地图模块不要动（含 bug 修复逃逸条款）**：`web/js/map.js`、`markers.js`、`geo.js`、`countries.js`、`legend.js`、`detail-modal.js`、`route.js` 及其相关 CSS（地图卡样式、打点、国家上色、图例、弹窗、路线回放）一律保持原样，前端改造只限首页/小组件层（`ui.js` 内 createUI、首页网格 `layout.css`/`widget.css`、`index.html` 首页区）。
  - **唯一例外**：用户明确发现某 bug 需要改地图模块时才可碰（用户 2026-10-16 重申）。
  - **功能级例外（2026-10-17）**：用户明确要求给「地点详情弹窗」新增全屏左右分栏视图，授权改动 `detail-modal.js` / `modal.css` / `index.html` 弹窗区。实现为**纯增量**：常规布局与 MapLibre 实例不动，仅新增右上角 `.modal__fs`（`#tm-modal-fs`）按钮 + `.modal--fullscreen` 类；切换时把 `#tm-modal-mapwrap` 与 `.modal__head` 临时移入新建的 `.modal__left`，退出/关闭时还原 DOM。已用 Playwright 验证（桌面分栏 ~738/702、窄屏 ≤820px 自动上下堆叠、切回常规 panelWidth=880 复原、无 pageerror）。
  - **历史一次性例外**：同日的「改进1（底图 style 失败 → toast + 指数退避自动重试 + 手动刷新按钮）」经用户授权临时改了 `map.js`（及轻微 `index.html`/`components.css`），已实施并验证通过，现已固化。
  - **改进2（换天地图/高德/腾讯合规源）用户已明确不做**（个人自用 + 偶尔白屏可接受 + 改进1 已兜底；且涉及厂商 key 注册，用户不愿引入）。
- 首页小组件系统（iOS 风格可编辑磁贴）是 2026-10-14 新增的纯前端改造，不改动 `data.js` 数据结构。尺寸为离散磁贴 1x1/2x1/1x2/2x2/3x2（非无极）。第二阶段 4 个创意组件（pending/lastTrip/roulette/month）仍为 comingSoon 占位；「重置布局」按钮尚未实现。

## 运行/测试环境要点
- 沙箱内 `HTTP_PROXY` 指向 `127.0.0.1:54072`；访问本机端口（如静态服务 8126）要 `--noproxy` 或 Playwright proxy `bypass:'<-loopback>'`，否则得 502。
- 前端是 ESM（`main.js` 用相对路径 `./js/...`），必须经 HTTP 静态服务访问，不能用 `file://`（CORS 会被拦）。
- 无后端时 `loadPlaces` 首载失败会回落内置 FALLBACK 数据，应用仍可 boot；真实部署用 `docker compose up`。
- 本地起后端测试：`PORT=8126 node server.js`（MinIO `ENOTFOUND` 会重试约 15 次后回落本地磁盘，最终监听成功、auth=off）。本地端口用 Playwright **直连**即可（Playwright 不走系统代理）；用 curl 需 `--noproxy '*'`。测试库 `data/travelmap.db` 已 seed，5 个地点有媒体（黄龙 74 / 九寨沟 46 / 天津 14 / 成都 10 / 杭州 6），主图图钉 `title` 形如 `名称 · 国家`（前缀匹配用 `[title^="名称"]`）。
