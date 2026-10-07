/* =========================================================
 * poster.js · 地图页「旅途海报」
 * ---------------------------------------------------------
 * 多张同时陈列、尺寸不等、各自随机翻牌替换；视频不播放，只取首帧当封面。
 * 格子比例与尺寸见 css/poster.css（改比例去那里，别在这儿写死）。
 *
 * 三个容易改坏的点：
 *  1) 翻牌用**双面卡累加 rotateY(±180°)**：把新内容写进当前看不见的那一面再转 180°。
 *     不要用"转到 90° 换内容再转回来"——换内容的瞬间卡片正好侧对镜头，
 *     <video> 会在那一刻重新解码并闪一下，图片慢一点的话也会露出底色。
 *  2) 每块**各自** setTimeout（2.2~3.8s 随机），不是共用一个 interval。
 *     共用一个定时器会六块一起翻，变成"整齐的轮播"，不是随机。
 *  3) 视频优先用 poster 封面图；没有 poster 才上 <video>（preload=metadata +
 *     currentTime 轻推一下逼出首帧），**不 autoplay、不 loop**。
 * ========================================================= */

/** 十块，顺序对应 css/poster.css 的 .pw--a ~ .pw--j */
const BLOCKS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
/* 翻牌间隔：5~8 秒。
   首版按用户最初说的"两三秒"做成 2.2~3.8s，实际看着太赶（刚看清一张就换走了），
   用户第二次反馈"刷新的间隔太短了" → 拉长到 5~8s，并且每块各掷一次随机值。 */
const GAP_MIN = 5000;      // 每块最短间隔（ms）
const GAP_RAND = 3000;     // 再叠加 0~3000ms 随机，错开彼此
const SHUFFLE_STAGGER = 90; // 「换一批」时逐块错开（ms）

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root    挂载点（#tm-poster-wall）
 * @param {(place:object)=>void} [opts.onOpen] 点击某块 → 打开该地点
 */
export function createPoster({ root, onOpen }) {
  let pool = [];
  let blocks = [];
  let paused = false;

  /* ---------- 一面卡的内容 ---------- */
  function paintFace(face, item) {
    face.innerHTML = '';

    let media;
    if (item.kind === 'video' && !item.poster) {
      media = document.createElement('video');
      media.className = 'pw__media';
      media.src = item.src;
      media.muted = true;
      media.playsInline = true;
      media.preload = 'metadata';
      media.addEventListener('loadedmetadata', () => {
        // 只取首帧：不 play()，靠 seek 让浏览器画出第一帧
        try { media.currentTime = 0.01; } catch (e) { /* 某些源不允许 seek，忽略 */ }
        media.classList.add('ok');
      }, { once: true });
    } else {
      media = document.createElement('img');
      media.className = 'pw__media';
      media.src = item.kind === 'video' ? item.poster : item.src;   // 有封面就用封面
      media.alt = item.title || '';
      if (media.complete && media.naturalWidth) media.classList.add('ok');
      else media.addEventListener('load', () => media.classList.add('ok'), { once: true });
    }
    face.append(media);

    face.insertAdjacentHTML('beforeend',
      '<div class="pw__scrim"></div>'
      + (item.kind === 'video' ? '<div class="pw__play"></div>' : '')
      + `<div class="pw__meta"><b>${escapeText(item.title)}</b>`
      + (item.sub ? `<span>${escapeText(item.sub)}</span>` : '')
      + '</div>');
  }

  function escapeText(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }

  /* ---------- 预载 ----------
     翻牌前必须把下一张拉到位：图片/视频每张都是独立请求，慢网下 1~2 秒才到，
     不预载的话翻过去会是一块"底色 + 地名"的空卡（实测出现过）。
     计划下一步时（schedule/shuffle）就开拉，等定时器到点时多半已在缓存里。 */
  function preload(item) {
    if (!item || (item.kind === 'video' && !item.poster)) return Promise.resolve(true);
    if (item._p) return item._p;
    item._p = new Promise((res) => {
      const im = new Image();
      im.onload = () => res(true);
      im.onerror = () => res(false);
      im.src = item.kind === 'video' ? item.poster : item.src;
    });
    return item._p;
  }

  /** 最多等 2.5s：图片一直不来也照翻（淡入会在它到位时补上，总比卡住不动强） */
  const preloadSoft = (item) => Promise.race([preload(item), new Promise((r) => setTimeout(() => r(false), 2500))]);

  function pickNext(rec) {
    let next = rec.cur;
    for (let guard = 0; guard < 12 && next === rec.cur; guard += 1) {
      next = pool[Math.floor(Math.random() * pool.length)];
    }
    return next;
  }

  /** 提前选好下一张并开始拉图（此刻还不动画面） */
  function plan(rec) {
    rec.next = pickNext(rec);
    preload(rec.next);
  }

  /* ---------- 翻牌 ---------- */
  function flip(rec, immediate = false) {
    if (pool.length < 2) return;
    const next = rec.next || pickNext(rec);
    rec.next = null;
    preloadSoft(next).then(() => {
      if (!pool.includes(next)) return;      // 等图期间池子被整体换过（数据同步），放弃这次
      // 当前朝前的是 faces[(rot/180) % 2]，新内容写进另一面
      const hidden = rec.faces[((rec.rot / 180) % 2 === 0) ? 1 : 0];
      paintFace(hidden, next);

      if (immediate) rec.inner.style.transition = 'none';
      rec.rot += 180;
      rec.inner.style.transform = `rotateY(${rec.rot}deg)`;
      if (immediate) {
        void rec.inner.offsetWidth;        // 强制 reflow，让"无过渡"先生效
        rec.inner.style.transition = '';
      }
      rec.cur = next;
    });
  }

  function schedule(rec) {
    clearTimeout(rec.timer);
    plan(rec);                             // 一 scheduling 就开始拉下一张
    rec.timer = setTimeout(() => {
      if (!paused && !document.hidden) flip(rec);
      schedule(rec);                     // 每次重新掷间隔 → 天然错开
    }, GAP_MIN + Math.random() * GAP_RAND);
  }

  function stop() {
    blocks.forEach((b) => clearTimeout(b.timer));
  }

  /* ---------- 高度上限 ----------
     墙跟着卡片吃满高度是有代价的：左列越高，墙越"瘦高"，4 行格子会把 4:3 的照片裁成竖条
     （实测 1220px 时 1×1 格子到 0.54:1，照片只剩 ~40%，正是用户反馈过的"图片没完整显示"）。
     所以按当前宽度反推高度上限，保证 宽/高 ≥ 0.95；多出来的高度在卡内上下留白。
     纯 CSS 做不到（无法在 max-height 里引用自身宽度），只能用 ResizeObserver 写回。 */
  const ASPECT_MIN = 0.95;
  function clampHeight() {
    const w = root.clientWidth;
    if (!w) return;
    root.style.maxHeight = `${Math.round(w / ASPECT_MIN)}px`;
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => clampHeight()) : null;

  /* ---------- 骨架 ---------- */
  function build() {
    root.classList.remove('posterwall--empty');
    root.innerHTML = '';
    blocks = BLOCKS.map((k) => {
      const el = document.createElement('div');
      el.className = `pw pw--${k}`;
      const inner = document.createElement('div');
      inner.className = 'pw__in';
      const f1 = document.createElement('div');
      f1.className = 'pw__face';
      const f2 = document.createElement('div');
      f2.className = 'pw__face';
      inner.append(f1, f2);
      el.append(inner);
      root.append(el);
      return { el, inner, faces: [f1, f2], rot: 0, cur: null, timer: 0 };
    });
    clampHeight();
    ro?.observe(root);
  }

  function showEmpty() {
    stop();
    blocks = [];
    root.classList.add('posterwall--empty');
    root.innerHTML = '<p>还没有照片或视频</p>';
  }

  if (typeof onOpen === 'function') {
    root.addEventListener('click', (e) => {
      const el = e.target.closest('.pw');
      if (!el) return;
      const rec = blocks.find((b) => b.el === el);
      if (rec?.cur?.place) onOpen(rec.cur.place);
    });
  }
  root.addEventListener('mouseenter', () => { paused = true; });
  root.addEventListener('mouseleave', () => { paused = false; });
  document.addEventListener('visibilitychange', () => {
    // 页面不可见时不翻（省电，也避免回前台看到一堆块同时转）
    if (document.hidden) stop();
    else blocks.forEach((b) => schedule(b));
  });

  return {
    /**
     * 更新素材池。只在**第一次**灌满五块并起定时器；
     * 之后的刷新（10 秒一轮的数据同步）只换池子不动当前画面，否则正在看的图会被莫名换掉。
     */
    setMedia(items) {
      const next = (items || []).filter(Boolean);
      if (!next.length) { pool = []; showEmpty(); return; }
      const first = !blocks.length;
      pool = next;
      if (first) {
        build();
        blocks.forEach((rec) => { plan(rec); flip(rec, true); });
        if (!reduceMotion()) blocks.forEach((rec) => schedule(rec));
      }
    },
    /** 「换一批」：五块错开依次翻（先 plan 预载，翻的时候图已在手上） */
    shuffle() {
      stop();
      blocks.forEach((rec, i) => { plan(rec); setTimeout(() => flip(rec), i * SHUFFLE_STAGGER); });
      if (!reduceMotion()) blocks.forEach((rec) => schedule(rec));
    },
    destroy() { stop(); ro?.disconnect(); root.innerHTML = ''; root.style.maxHeight = ''; blocks = []; pool = []; },
  };
}
