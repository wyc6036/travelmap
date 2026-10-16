# 项目长期记忆 · travelmap

## 模块边界约束
- **地图模块不要动**：`web/js/map.js`、`markers.js`、`geo.js`、`countries.js`、`legend.js`、`detail-modal.js`、`route.js` 及其相关 CSS（地图卡样式、打点、国家上色、图例、弹窗、路线回放）一律保持原样，前端改造只限首页/小组件层（`ui.js` 内 createUI、首页网格 `layout.css`/`widget.css`、`index.html` 首页区）。
- 首页小组件系统（iOS 风格可编辑磁贴）是 2026-10-14 新增的纯前端改造，不改动 `data.js` 数据结构。尺寸为离散磁贴 1x1/2x1/1x2/2x2/3x2（非无极）。第二阶段 4 个创意组件（pending/lastTrip/roulette/month）仍为 comingSoon 占位；「重置布局」按钮尚未实现。

## 运行/测试环境要点
- 沙箱内 `HTTP_PROXY` 指向 `127.0.0.1:54072`；访问本机端口（如静态服务 8126）要 `--noproxy` 或 Playwright proxy `bypass:'<-loopback>'`，否则得 502。
- 前端是 ESM（`main.js` 用相对路径 `./js/...`），必须经 HTTP 静态服务访问，不能用 `file://`（CORS 会被拦）。
- 无后端时 `loadPlaces` 首载失败会回落内置 FALLBACK 数据，应用仍可 boot；真实部署用 `docker compose up`。
