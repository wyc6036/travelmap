/**
 * markers.js · 图钉渲染
 * -----------------------------------------------------------
 * 相对 Ref_Globe 的改动：
 *   ✔ 视觉：呼吸圆点 .pg-dot → UI_Ref.jpeg 的图钉（自定义 Marker DOM，内联 SVG 水滴）
 *   ✔ updateVisibility：删除"背面遮挡"（dot < 0 隐藏）——平面地图没有背面；
 *     仅保留按 hiddenTypes 图例筛选显隐的部分。
 *   ✘ 删除自动旋转相关代码（平面下无意义）
 * 其余（Marker 创建、命中盒、hover Popup、click flyTo）逻辑与 Ref_Globe 保持一致。
 */

import { escapeHtml, formatDateDot, mixHex } from './utils.js';

/**
 * 图钉几何 —— 对 UI_Ref.jpeg 中 7 个图钉逐像素反解得到，非目测：
 *   实测外框 14×20 · 头部正圆 r=7 圆心 (7,7) · 尖端 (7,20) 与圆相切 · 孔洞 r=2.9（= 头径 41%）
 * 轮廓用"尖端向圆作切线"的解析解而非贝塞尔目测：
 *   d = 20 - 7 = 13，切线长 L = √(13² - 7²) = 10.954
 *   切点偏移 = r·L/d = 5.899，切点 y = cy + r²/d = 10.769
 * 逐行轮廓与效果图实测的平均误差 0.33px，已收敛到亚像素级。
 *
 * 渲染时再乘 PIN_DISPLAY：几何仍按实测的 14×20 定义（viewBox 不变，SVG 等比缩放），
 * 只是把落地的 CSS 盒子整体缩掉 —— 当前系数 0.63，落地 8.82×12.6。
 * ⚠️ 这段注释里**不要写死尺寸**，改 PIN_DISPLAY 时很容易忘了同步（已经栽过一次）。
 *
 * 注意：MapLibre 会把 transform 直接写在这个元素上（translate(-50%,-100%) 定位），
 * 所以尺寸/缩放/悬停位移都交给内层 .tm-pin__inner，不要写在外层 .tm-pin 上，否则会被覆盖。
 */

/** 相对效果图实测尺寸的渲染缩放（用户要求：先缩小 30%，再缩小 10% → 0.7 × 0.9） */
const PIN_DISPLAY = 0.63;

const PIN_REF = { w: 14, h: 20 };   // 效果图实测外框

export const PIN = {
  /** 落地 CSS 尺寸（= 实测 14×20 × PIN_DISPLAY），同时也是 Popup 偏移的依据 */
  w: +(PIN_REF.w * PIN_DISPLAY).toFixed(2),   // 8.82
  h: +(PIN_REF.h * PIN_DISPLAY).toFixed(2),   // 12.6
  /** 几何定义仍按实测值，viewBox 不跟着缩，SVG 等比缩放即可 */
  viewBox: '0 0 14 20',
  path: 'M7 20 L12.899 10.769 A7 7 0 1 0 1.101 10.769 Z',
  hole: { cx: 7, cy: 7, r: 2.9 },
};

/**
 * 图钉主体兜底色 —— 只在取不到类型色时使用。
 *
 * ⚠️ 配色演进史（别照着旧文档改回去）：
 *   初版按 UI_Ref.jpeg 实测，7 个钉子主体完全同色（中位 #304A6A），于是主体统一藏青、
 *   类型色只作 hover 光晕；后来用户要求「根据 旅行/居住/目的地 的图例更新图钉的颜色」，
 *   改为**主体色 = 类型色**，光晕同色。现在类型差异直接体现在钉子本体上。
 *   几何（外框 / 圆弧 / 孔洞）仍然固定不变，不随类型变。
 */
export const PIN_BODY = '#304A6A';

/** 主体色相对类型色的提亮比例（hover 用）；小地图图钉复用同一比例 */
export const PIN_LIFT = 0.18;

/**
 * 图钉的 SVG 片段 —— 地图 Marker、详情弹窗小地图、图例**三处共用同一份几何与路径**。
 *
 * 为什么要抽成一个函数：路径 / viewBox / 孔洞半径原本在 markers.js 和 detail-modal.js
 * 各写了一份，现在图例也要用第三份。三份各写一遍必然出现"改一处漏两处"，
 * 而且漏掉的那处**不会报错**，只会画成另一个形状（钉子的圆弧 sweep 方向就栽过）。
 *
 * @param {object} [options]
 * @param {string} [options.bodyClass] 主体交由 CSS 类着色（地图 / 小地图：色值走 --pin-body 变量）
 * @param {string} [options.fill]      主体直接写填充色（图例：它不在 .tm-pin 内，没有变量可继承）
 * @param {string} [options.holeClass] 孔洞交给 CSS 类着色；不给则直接写白色
 *
 * ⚠️ 返回值故意**排成单行、不带缩进**：多行版本里那些换行和空格会变成文本节点，
 * 图例按钮的 textContent 于是变成 "\n  \n  \n居住" —— 不影响渲染，但会污染
 * 可访问名称和测试断言里的取值。不要为了 devtools 里好读而把它改成多行。
 */
export function pinSvg({ bodyClass = '', fill = PIN_BODY, holeClass = '' } = {}) {
  const body = bodyClass ? `class="${bodyClass}"` : `fill="${fill}"`;
  const hole = holeClass ? `class="${holeClass}"` : 'fill="#FFFFFF"';
  return `<svg viewBox="${PIN.viewBox}" aria-hidden="true">`
    + `<path ${body} d="${PIN.path}"/>`
    + `<circle ${hole} cx="${PIN.hole.cx}" cy="${PIN.hole.cy}" r="${PIN.hole.r}"/>`
    + '</svg>';
}

/**
 * 生成图钉 DOM。
 * @param {string} color 类型色（数据驱动），决定主体色 + hover 提亮色 + 落点光晕
 * @param {string} [title]
 */
function createPinElement(color, title) {
  const body = color || PIN_BODY;
  const pin = document.createElement('div');
  pin.className = 'tm-pin';
  /* 三个变量一起写在钉子上（而不是地图容器上），因为每个钉子的类型色不同。
     提亮色由类型色派生，CSS 侧只认变量名，不写死任何颜色。 */
  pin.style.setProperty('--pin-body', body);
  pin.style.setProperty('--pin-body-lift', mixHex(body, '#FFFFFF', PIN_LIFT));
  pin.style.setProperty('--pin-accent', body);
  if (title) pin.title = title;
  pin.innerHTML = `
    <div class="tm-pin__inner">
      ${pinSvg({ bodyClass: 'tm-pin__body', holeClass: 'tm-pin__hole' })}
      <span class="tm-pin__halo"></span>
    </div>`;
  return pin;
}

/**
 * 创建图钉图层。
 * @param {object} map MapLibre 实例
 * @param {object} options
 * @param {(place:object)=>string} options.colorOf 取色函数
 * @param {(place:object, el:HTMLElement)=>void} options.onSelect 点击回调
 */
export function createMarkerLayer(map, { colorOf, onSelect }) {
  /** @type {Array<{place:object, el:HTMLElement, marker:object, popup:object}>} */
  let entries = [];
  const hiddenTypes = new Set();
  let activeId = null;

  function clear() {
    entries.forEach((e) => {
      try { e.popup.remove(); } catch (_) { /* 忽略 */ }
      try { e.marker.remove(); } catch (_) { /* 忽略 */ }
    });
    entries = [];
    activeId = null;
  }

  /**
   * 显隐：平面地图没有"背面"，因此只依据图例筛选 + 外部条件（搜索/视图过滤）。
   * @param {(place:object)=>boolean} [extra] 额外的可见性判定
   */
  function updateVisibility(extra) {
    for (const e of entries) {
      const hiddenByLegend = hiddenTypes.has(e.place.type);
      const hiddenByExtra = typeof extra === 'function' ? !extra(e.place) : false;
      const visible = !hiddenByLegend && !hiddenByExtra;
      e.el.style.display = visible ? 'block' : 'none';
      if (!visible) e.popup.remove();
    }
  }

  function render(places, extra) {
    clear();

    for (const place of places) {
      const color = colorOf(place);
      const el = createPinElement(color, `${place.name}${place.countryZh ? ` · ${place.countryZh}` : ''}`);
      const popup = new maplibregl.Popup({
        offset: PIN.h + 1, closeButton: false, closeOnClick: false, maxWidth: '260px',
      });

      const dateLine = place.date
        ? `<span class="tm-tip__date">${escapeHtml(formatDateDot(place.date))}</span>` : '';
      const countryLine = place.countryZh ? `<i>${escapeHtml(place.countryZh)}</i>` : '';
      popup.setHTML(
        `<div class="tm-tip"><b>${escapeHtml(place.name)}</b>`
        + `<i>${escapeHtml(place.type)}</i>${countryLine}${dateLine}</div>`,
      );

      el.addEventListener('mouseenter', () => {
        if (el.style.display === 'none') return;
        popup.setLngLat([place.lng, place.lat]).addTo(map);
      });
      el.addEventListener('mouseleave', () => popup.remove());
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        popup.remove();
        setActive(place.id);
        if (typeof onSelect === 'function') onSelect(place, el);
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([place.lng, place.lat])
        .addTo(map);

      entries.push({ place, el, marker, popup });
    }

    updateVisibility(extra);
  }

  function setActive(placeId) {
    activeId = placeId;
    for (const e of entries) e.el.classList.toggle('is-active', e.place.id === placeId);
  }

  function setHiddenTypes(set) {
    hiddenTypes.clear();
    for (const t of set) hiddenTypes.add(t);
  }

  return {
    render,
    clear,
    updateVisibility,
    setActive,
    setHiddenTypes,
    getActiveId: () => activeId,
  };
}
