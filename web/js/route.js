/**
 * route.js · 行程路线动画（跑在详情弹窗上半部的小地图里）
 * -----------------------------------------------------------
 * 用户点开一次行程（如「京都赏樱」）时，在弹窗的地图区域里把这条路线"走一遍"：
 *   · 一条**虚线**从起点出发逐渐延伸到终点（折线的坐标表逐帧变长）；
 *   · 末端跟一枚脚印光标，走到哪、虚线画到哪；
 *   · 覆盖多个地点时按到访时间**分段**走（柏林 → 阿姆斯特丹 → 布拉格），
 *     每走到一站，那一站的序号徽标**才出现并点亮**；
 *     ⚠️ 顺序（2026-10-06 定）：**起点先打点 → 虚线出发 → 到站才点亮该站**，
 *        不是"先把每一站都画上再连线" —— 后者会把起点与终点的先后关系抹平，
 *        看着像"先给目的地打好点，再补一条线"。
 *
 * 这里操作的是**详情弹窗自己那张独立的小地图**（detail-modal.js 建的 #tm-modal-map），
 * 与主地图无关 —— 主地图上不再有回放功能（2026-10-05 需求调整：
 * 「在地图上走一遍」从「足迹」页搬进了媒体弹窗）。
 *
 * 取景带**地理上下文**（2026-10-06，同日收窄）：只装下路线会把地图顶到街道级，
 * 看不出"这两站相对于国家/地区在哪"。调用方可以把**站点所在国家的包围盒**
 * 一起传进来（detail-modal 用 world.json 算），fitBounds 会把它一起装下；
 * 但再给一条保底 —— 最多比"只装路线"的档位低 `MAX_CONTEXT_OUT` 档，
 * 否则大国（俄/美/中）的包围盒会把路线压成一条看不清的短线。
 * ⚠️ 这个上限一度定在 2.2 档，实测发现**矢量瓦片的城市地名要到 zoom ≈5.5 才开始出现**，
 * 2.2 档（京都赏樱 7.14→4.94）画面里只有"日本"两个字 —— 用户以为那是空白地图打点。
 * 收窄到 1.2 档（→5.94）后路线约占画面宽 4 成、沿途城市名齐全，还留着国家轮廓。
 *
 * 站点打点可点（2026-10-06）：点某站 → `onSelect(i)`，宿主用它筛下面的媒体；
 * 点地图空白 → `onSelect(null)` 恢复。选中态由 `highlight()` 落在 DOM 上
 * （`.is-sel` 放大 / `.is-muted` 压灰），并记住 `selIdx`，重挂图层后补得回来。
 *
 * ⚠️ 六条硬约束（都是**静默失败**型，都踩过）：
 *   1. **切底图会清空所有自定义 source/layer**（`map.setStyle()` 不报错，直接清掉）→
 *      必须用 `registerStyleHook` 补回来；又因为补回来的那一刻可能已经走了一半，
 *      所以这里缓存 `lastCoords`，重挂时按它重建（而不是画回起点）。
 *   2. `registerStyleHook` 的**执行顺序 = 图层叠放顺序** → 本模块必须**晚于**
 *      detail-modal 注册国家图层，否则路线被国土色块盖住。所以它是在
 *      `ensureDetailMap()` 之后才构造的。
 *   3. 折线要插在**第一个 symbol 图层之前**，否则会压在底图地名标注上面。
 *   4. MapLibre 把 `transform` 直接写在 Marker 元素本身（定位用）→
 *      缩放只能放内层元素（`.tm-walker__in`），偏移只能走 Marker 的 `offset` 参数 ——
 *      与图钉 (.tm-pin/.tm-pin__inner) 同一个坑。
 *   5. 动画必须等**样式就绪**再开始：`addSource` 需要 style JSON 已解析。
 *      `isStyleLoaded()` 是判据；但离线等极端情况下 `load` 可能永远不来，
 *      所以配一个 2s 兜底，别让"走一遍"变成一张永远不动的空地图。
 *
 * 减弱动效（`prefers-reduced-motion: reduce`）：不逐帧，直接一次画完整条线和全部站点。
 */

import { COLORS } from './config.js';
import { warnOnce } from './utils.js';

const SRC = 'tm-route';
const L_LINE = 'tm-route-line';

/** 相邻两站之间的行走时长（毫秒）。按段不按距离：段与段之间本来就有停顿感，等长更稳。 */
const SEG_MS = 2300;
/** 到站停顿，让"到了"这件事被看见 */
const HOLD_MS = 480;
/** 路线被压灰时的不透明度（与打点 `grayscale(1) + opacity .35` 的"退后程度"对齐） */
const LINE_MUTED_OPACITY = 0.55;

/** 开跑前的让位时间：相机 fitBounds 是瞬间完成的，但地图需要一两帧才画稳 */
const LEAD_MS = 260;
/** 等样式就绪的兜底 */
const READY_TIMEOUT_MS = 2000;
/** style 迟迟不就绪时最多重试几次（每次 2s 兜底 + 一次 load 事件） */
const MAX_ATTEMPTS = 6;
/** 路线取景的最大档位：三个地点挨得再近也不要顶到"街道级" */
const MAX_FIT_ZOOM = 9;
/** 光标淡出动画的时长（css/.tm-walker 的 transition 要与此一致） */
const WALKER_FADE_MS = 450;
/** 取景的下限 = 小地图的 minZoom（js/config.js detailMap.minZoom），再小就进世界档了 */
const MIN_FIT_ZOOM = 3;
/** 为了带上地理上下文，最多比"刚好装下路线"**低**多少档。
 *  ⚠️ 定这条线要考虑**地名出现的档位**：矢量瓦片的城市名 zoom ≈5.5 才出现，
 *  拉得太远（首版 2.2 档）画面里只剩国家名，看起来就是"空白地图上打点"。
 *  1.2 档时路线约占取景宽度 40%，城市名齐全、国家轮廓仍在（实测京都赏樱 7.14 → 5.94）。 */
const MAX_CONTEXT_OUT = 1.2;

export function createRouteAnim(map) {
  let stops = [];              // [{ id, lng, lat, name }]，按到访时间升序
  let stopMarkers = [];
  let walker = null;
  let running = false;         // 动画在推进
  let started = false;         // 图层/标记已经挂上（样式就绪后置位）
  let raf = 0;
  let segIdx = 0;
  let segStart = 0;
  let holdUntil = 0;
  let readyTimer = 0;
  /** 当前折线的坐标。重挂图层时按它恢复，而不是画回起点。 */
  let lastCoords = [];
  /** 已重试次数（见 start 的注释） */
  let attempts = 0;
  /** 站点所在国家/地区的包围盒（调用方传入，取景时一起装下；可为 null） */
  let contextBounds = null;
  /** 当前被点选的站号（null = 没选）。重挂标记后要按它补回选中态。 */
  let selIdx = null;
  /** 已经走到第几站（站号）。marker 重建（切底图）时按它恢复"走到哪了"。 */
  let reachedIdx = 0;
  /** 点站点 / 点地图空白时的回调：onSelect(站号 | null) */
  let onSelect = null;
  /** 光标淡出后延迟移除的定时器（见 dismissWalker） */
  let walkerGoneTimer = 0;

  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const toLngLat = (s) => [s.lng, s.lat];

  /* =========================================================
   * 图层
   * ========================================================= */
  const asFeature = (coords) => ({
    type: 'Feature',
    properties: {},
    /* LineString 至少要两个点。起点阶段两点重合，MapLibre 画出来是空的，
       但不会报错，也就不用为此写特例。 */
    geometry: {
      type: 'LineString',
      coordinates: coords.length >= 2 ? coords : [coords[0] || [0, 0], coords[0] || [0, 0]],
    },
  });

  /** 折线要插在第一个 symbol 图层之前，否则会盖住底图的地名 */
  function firstSymbolLayerId() {
    const layers = map.getStyle()?.layers || [];
    return layers.find((l) => l.type === 'symbol')?.id;
  }

  function addLayers() {
    if (map.getSource(SRC)) return;                    // 幂等：style hook 可能被多次调用
    map.addSource(SRC, { type: 'geojson', data: asFeature(lastCoords) });

    const before = firstSymbolLayerId();
    map.addLayer({
      id: L_LINE,
      type: 'line',
      source: SRC,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        /* ⚠️ 建线时就要按当前选中态给色：切底图 / 重播会走 style hook 重建图层，
           重建后如果不补这一下，压灰的路线会瞬间变回橙色。 */
        'line-color': selIdx !== null ? COLORS.routeMuted : COLORS.route,
        'line-opacity': selIdx !== null ? LINE_MUTED_OPACITY : 1,
        /* 2026-10-06：去掉白色底衬（用户反馈"白色背景太丑"）。白衬原本是给细线
           "托底"用的，但它同时也把虚线衬成了一串糖果点；现在的观感是线直接
           画在地面上，宽度相应加粗半档补回存在感。 */
        'line-width': 3.5,
        /* 虚线。⚠️ "逐渐延伸"**不是**靠动画 dasharray 做到的，
           而是靠坐标表逐帧变长：虚线图案沿折线从头算起，
           所以线变长时已画好的短划原地不动、新的短划在末端不断冒出来 —— 正是要的观感。 */
        'line-dasharray': [0.5, 1.1],
      },
    }, before);
  }

  function removeLayers() {
    if (map.getLayer(L_LINE)) map.removeLayer(L_LINE);
    if (map.getSource(SRC)) map.removeSource(SRC);
  }

  /** 写坐标：既落到地图上，也留在 lastCoords 里备 style hook 重挂用 */
  function paint(coords) {
    lastCoords = coords;
    const src = map.getSource(SRC);
    if (src) src.setData(asFeature(coords));
  }

  /* =========================================================
   * 标记（站点序号 + 脚印光标）
   * ========================================================= */
  function addStopMarkers() {
    stops.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'tm-stop';
      el.innerHTML = `<span class="tm-stop__in">${i + 1}</span>`;
      el.title = s.name;
      /* 站点可点（筛媒体）。⚠️ 必须 stopPropagation：MapLibre 的 click 监听挂在
         地图容器上，marker 元素是它的子节点，不拦住的话"点站点"会同时触发
         "点地图空白"→ 选中立刻被自己清掉。 */
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect?.(i);
      });
      stopMarkers.push(
        new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(toLngLat(s)).addTo(map),
      );
    });
    if (reachedIdx <= 0) {
      /* 起点也要"被看见地出现"：先全部藏一帧，再点亮第 0 站 ——
         transition 会走出一次淡入，看起来就是"先给起点打上点"。
         （直接 setStopState(0) 的话起点是凭空在那的，没有"打上"这个动作。） */
      setStopState(-1);
      requestAnimationFrame(() => setStopState(0));
    } else {
      setStopState(reachedIdx);      // 重挂（切底图/重播）：按当前进度恢复
    }
    highlight(selIdx);          // 重挂（切底图/重播）后把选中态补回来
  }

  /** reached = 已经走到的站号；cur 默认就是它（`-1` 表示没有"当前站"，收尾时用）
   *  ⚠️ 未走到的站会拿到 `.is-pending`：**先不出现**（2026-10-06）。
   *     旧版把每一站的打点都先画上、再连线，起点与终点的先后关系被抹平了；
   *     现在的顺序是"起点先打点 → 虚线出发 → 走到哪一站，那一站的打点才出现"。
   *     reachedIdx 要记下来：切底图会重建 marker，重建时得按进度恢复，
   *     否则已经走过的站会"倒退"回没出现的样子（与画好的折线对不上）。 */
  function setStopState(reached, cur = reached) {
    reachedIdx = reached;
    stopMarkers.forEach((mk, i) => {
      const el = mk.getElement();
      el.classList.toggle('is-done', i <= reached);
      el.classList.toggle('is-cur', i === cur);
      el.classList.toggle('is-pending', i > reached);
    });
  }

  /** 折线的压灰态：点选某站后，整条路线跟着未被选中的打点一起退到背景里 */
  function paintLineState() {
    if (!map.getLayer(L_LINE)) return;
    const muted = selIdx !== null;
    map.setPaintProperty(L_LINE, 'line-color', muted ? COLORS.routeMuted : COLORS.route);
    map.setPaintProperty(L_LINE, 'line-opacity', muted ? LINE_MUTED_OPACITY : 1);
  }

  /** 点选态：被点的站放大、其余压灰；传 null 全部恢复。记住 selIdx 供重挂后补回。
   *  ⚠️ 路线折线也要跟着压灰（2026-10-06）：只让打点变灰的话，橙色的虚线仍然
   *     抢视线，看不出"现在只看这一站"。 */
  function highlight(idx) {
    selIdx = (Number.isInteger(idx) && idx >= 0 && idx < stopMarkers.length) ? idx : null;
    stopMarkers.forEach((mk, i) => {
      const el = mk.getElement();
      el.classList.toggle('is-sel', selIdx !== null && i === selIdx);
      el.classList.toggle('is-muted', selIdx !== null && i !== selIdx);
    });
    paintLineState();
  }

  function ensureWalker(pos) {
    clearTimeout(walkerGoneTimer);            // 上一轮的"移除"定时器作废
    if (walker) { walker.setLngLat(pos); walker.getElement().classList.remove('is-gone'); return; }
    const el = document.createElement('div');
    el.className = 'tm-walker';
    // 缩放写在**内层**：外层 transform 归 MapLibre 管（见文件头第 4 条）
    el.innerHTML = '<span class="tm-walker__in">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-foot"/></svg></span>';
    walker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(pos).addTo(map);
  }

  /** 收尾后光标就没用了，还压在终点站徽标上（挡住点击）→ 淡出后**从 DOM 里移走**。
   *  ⚠️ 不能只加个淡出类就完事：过渡只是视觉，元素仍压在终点徽标上
   *     （光标 z-index 8 > 打点 7），终点站会点不到。所以淡出后要真的 remove。
   *  ⚠️ 定时器要在 ensureWalker / stop 里清掉，否则下一次播放会被旧定时器拆掉新光标。 */
  function dismissWalker() {
    if (!walker) return;
    walker.getElement().classList.add('is-gone');
    clearTimeout(walkerGoneTimer);
    walkerGoneTimer = setTimeout(() => {
      if (walker?.getElement().classList.contains('is-gone')) {
        try { walker.remove(); } catch (_) { /* 忽略 */ }
        walker = null;
      }
    }, WALKER_FADE_MS);
  }

  function removeMarkers() {
    stopMarkers.forEach((m) => { try { m.remove(); } catch (_) { /* 忽略 */ } });
    stopMarkers = [];
    if (walker) { try { walker.remove(); } catch (_) { /* 忽略 */ } walker = null; }
  }

  /* =========================================================
   * 取景
   * ========================================================= */
  /** 内边距按容器实际尺寸给：站号徽标半径 10、脚印光标 ~16，上下要留够，否则末端被裁 */
  function fitPadding() {
    const el = map.getContainer();
    const w = el.clientWidth || 320;
    const h = el.clientHeight || 200;
    const side = Math.min(48, Math.max(24, w * 0.08));
    return {
      top: Math.min(46, Math.max(28, h * 0.2)),
      bottom: Math.min(52, Math.max(30, h * 0.24)),
      left: side,
      right: side,
    };
  }

  /** 只装下路线的包围盒 */
  function routeBounds() {
    const b = new maplibregl.LngLatBounds();
    stops.forEach((s) => b.extend(toLngLat(s)));
    return b;
  }

  function fitStops() {
    if (stops.length < 2) return;
    const routeB = routeBounds();
    const pad = fitPadding();

    /* ⚠️ 全程用 cameraForBounds（**只算不动**），最后一次性 jumpTo：
       先 fitBounds 再 easeTo 会闪两下，而且第一下会把相机搬到错误的地方。
       另外 cameraForBounds 的签名里**没有 maxZoom**，上限要自己夹。 */
    const cam = map.cameraForBounds(routeB, { padding: pad });
    const zRoute = Math.min(MAX_FIT_ZOOM, cam?.zoom ?? 0);
    let zoom = zRoute;
    let center = cam.center;

    /* 地理上下文：把站点所在国家的包围盒也量进来，让人看得出"这两站在日本的位置"。
       国家包围盒一定 ⊇ 路线包围盒，所以档位只会更低。 */
    if (contextBounds) {
      const c = map.cameraForBounds(contextBounds, { padding: pad });
      if (c && Number.isFinite(c.zoom)) zoom = Math.min(zoom, c.zoom);
    }

    /* 两条保底：
       ① 别跌进世界档（小地图 minZoom = 3）；
       ② 最多比"刚好装下路线"低 MAX_CONTEXT_OUT 档 —— 大国的包围盒会把
          两个挨得近的站压成一个点，而且拉太远城市地名根本不出现。 */
    const floor = Math.max(MIN_FIT_ZOOM, zRoute - MAX_CONTEXT_OUT);
    zoom = Math.max(zoom, floor);

    /* 中心**永远取路线中心**，不取国家包围盒中心：
       后者（如日本含冲绳/北海道）会把路线挤到画面边缘甚至外面去。 */
    map.jumpTo({ center, zoom });
  }

  /* =========================================================
   * 逐帧推进
   * ========================================================= */
  const lerpStop = (a, b, t) => [a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t];

  /** 第 seg 段的进度 t ∈ [0,1] 时，整条折线应该长什么样 */
  function coordsAt(seg, t) {
    const out = stops.slice(0, seg + 1).map(toLngLat);
    out.push(lerpStop(stops[seg], stops[seg + 1], t));
    return out;
  }

  function tick(now) {
    if (!running) return;
    if (now < holdUntil) { raf = requestAnimationFrame(tick); return; }

    // 两头都要夹：segStart 可能在未来（LEAD_MS 让位期），不夹会把 t 算成负数
    const t = Math.max(0, Math.min(1, (now - segStart) / SEG_MS));
    paint(coordsAt(segIdx, t));
    ensureWalker(lerpStop(stops[segIdx], stops[segIdx + 1], t));

    if (t >= 1) {
      setStopState(segIdx + 1);
      segIdx += 1;
      if (segIdx >= stops.length - 1) { finish(); return; }
      holdUntil = now + HOLD_MS;
      segStart = now + HOLD_MS;
    }
    raf = requestAnimationFrame(tick);
  }

  /** 收尾：补上最后一段的整数点位（tick 里最后画的是 t≈1 的插值点，取整更干净） */
  function finish() {
    running = false;
    cancelAnimationFrame(raf); raf = 0;
    if (!started) return;
    paint(stops.map(toLngLat));
    setStopState(stops.length - 1, -1);       // 全部点亮，但没有"当前站"了
    dismissWalker();                          // 光标任务完成，淡出（别压在终点徽标上挡点击）
  }

  /* =========================================================
   * 对外
   * ========================================================= */
  /**
   * 再等一轮"样式就绪"。
   *
   * ⚠️ 存在的理由（这是修掉的一个**静默失败**）：`addSource` / `addLayer` 在样式
   *    没解析完时会**抛异常**（`Style is not done loading.`）。原先 start() 是先把
   *    `started` 置位、再去干这些活 —— 一抛，`started` 已经是 true，`play()` 里的
   *    `if (started) return` 就把后续所有调用挡在门外：弹窗里**永远**不会出现路线，
   *    控制台只留一句与路线毫无关联的报错。现在改成"干完活才置位 + 失败重试"。
   */
  function rearm() {
    attempts += 1;
    if (attempts > MAX_ATTEMPTS) {
      warnOnce('route-style', '小地图样式长时间未就绪，这次的"走一遍"动画跳过绘制。');
      running = false;
      return;
    }
    map.once('load', start);
    readyTimer = setTimeout(start, READY_TIMEOUT_MS);
  }

  const start = () => {
    if (started || !running) return;
    clearTimeout(readyTimer);
    try {
      addLayers();
      addStopMarkers();
      ensureWalker(toLngLat(stops[0]));
    } catch (err) {
      // 半途抛出的要连已经建好的部分一起收掉，否则下一轮重试会叠出重复的站点徽标
      removeMarkers();
      removeLayers();
      rearm();
      return;
    }
    attempts = 0;
    started = true;
    if (reduced()) { finish(); return; }
    segStart = performance.now() + LEAD_MS;
    holdUntil = 0;
    raf = requestAnimationFrame(tick);
  };

  /**
   * 播一条路线。
   * @param {object[]} places 行程里的地点（内部自己按 dateTs 升序，调用方不用先排）
   * @param {{contextBounds?: maplibregl.LngLatBounds}} [opts]
   *        contextBounds：站点所在国家/地区的包围盒，取景时一起装下（地理上下文）
   * @returns {boolean} 是否真的播起来了（少于 2 个地点返回 false，调用方自行退化）
   */
  function play(places, opts = {}) {
    stop();
    stops = (places || [])
      .filter((p) => p && Number.isFinite(p.lng) && Number.isFinite(p.lat))
      .slice()
      .sort((a, b) => (a.dateTs || 0) - (b.dateTs || 0))
      .map((p) => ({ id: p.id, lng: p.lng, lat: p.lat, name: p.name }));
    if (stops.length < 2) return false;

    contextBounds = opts.contextBounds || null;
    selIdx = null;                              // 新路线没有"上一次的选中"
    reachedIdx = 0;                             // 从头开始：先只打起点
    running = true;
    segIdx = 0;
    attempts = 0;
    lastCoords = [toLngLat(stops[0]), toLngLat(stops[0])];
    fitStops();

    /* 样式已就绪就直接开跑，否则挂上 load 监听 + 兜底定时器（见 rearm） */
    if (map.isStyleLoaded()) start();
    else rearm();
    return true;
  }

  /** 停并**彻底清干净**（关弹窗 / 换成地点详情时调） */
  function stop() {
    running = false;
    started = false;
    attempts = 0;
    clearTimeout(readyTimer);
    clearTimeout(walkerGoneTimer);
    cancelAnimationFrame(raf); raf = 0;
    removeMarkers();
    removeLayers();
    stops = [];
    lastCoords = [];
    segIdx = 0;
    holdUntil = 0;
    selIdx = null;
    reachedIdx = 0;
    contextBounds = null;
  }

  /* 切底图后把折线补回来。⚠️ 注册顺序 = 图层叠放顺序，本模块必须在
     detail-modal 的国家图层之后注册，否则路线会被国土色块盖住。 */
  map.registerStyleHook(() => { if (started) addLayers(); });

  /* 点地图空白 = 取消选中。⚠️ 站点 marker 的 click 里已经 stopPropagation，
     所以这里只收得到"真的点在地图上"的点击。 */
  map.on('click', () => { if (started) onSelect?.(null); });

  return {
    play,
    stop,
    isActive: () => started,
    /** 宿主注册"点站点 / 点空白"回调：onSelect(站号 | null) */
    onStopSelect(fn) { onSelect = typeof fn === 'function' ? fn : null; },
    /** 点选态：站号放大、其余压灰；null 恢复。重挂标记后按它补回。 */
    highlight,
    /** 点了站点之后立即把剩余的段画完（不必等动画走完才能筛选） */
    settle() { if (running) finish(); },
    /** 调试与验收用：当前这条路线按顺序的站点名 */
    getStops: () => stops.map((s) => s.name),
    /** 站点 id（与 places 的 id 一致）。宿主用 onSelect 的站号查这里。 */
    getStopIds: () => stops.map((s) => s.id),
    /**
     * 调试与验收用：这条折线此刻画到哪儿了。
     * ⚠️ 验收脚本**不要**去读 `map.getSource('tm-route')._data` —— MapLibre 的打包产物
     *    把类内部字段名混淆了（`_data` 取到 undefined，`serialize().data` 同样为空），
     *    看着像"折线没画"，其实是读错了地方。这里给出的是确定的公共出口。
     * @returns {{points:number, head:number[]|null, seg:number, running:boolean}}
     */
    progress: () => ({
      points: lastCoords.length,
      head: lastCoords.length ? [...lastCoords[lastCoords.length - 1]] : null,
      seg: segIdx,
      running,
    }),
  };
}
