/**
 * legend.js · 图例（按 types 分类筛选图钉显隐）
 * -----------------------------------------------------------
 * 结构演进：
 *   - 原先是地图右下角一个独立玻璃胶囊，两行：① 类型圆点（可点，筛选显隐）
 *     ② 国家「已访问 / 未访问」配色说明。
 *   - 现按用户要求**并入「足迹概览」卡片内部**，且**删掉「已访问 / 未访问」那一行**，
 *     只保留三个类型、横向排列、整体比原来小一档（样式见 css/components.css .legend）。
 *     国家配色的说明没有丢，仍在「设置」页的调色板一节里。
 *   - 2026-09-28：**再删掉「全部显示」那一行**（用户：只有三个选项，手动点回去就行）。
 *     于是图例恒定只有一行、高度不再随筛选状态变化。
 *
 * 「点击按类型筛选显隐」是规格书明确要求保留的交互（Ref_Globe 遗产），
 * 所以这里仍然渲染成 <button>，只是视觉上收敛成一个小的内嵌标记行。
 *
 * 类型标记**就是地图上那枚图钉**（几何、viewBox、孔洞都取自 js/markers.js 的 pinSvg），
 * 不是另画的圆点 —— 图例和地图必须是同一个字形，否则"看图例去地图上找"就对不上。
 * 注意图例不在 .tm-pin 内部，继承不到 --pin-body，所以走 pinSvg 的 fill 参数直接写色。
 */

import { escapeHtml } from './utils.js';
import { pinSvg } from './markers.js';

/**
 * @param {HTMLElement} root 容器（#tm-legend）
 * @param {object} options
 * @param {(hiddenTypes:Set<string>)=>void} options.onChange 筛选变化回调
 */
export function createLegend(root, { onChange } = {}) {
  const hiddenTypes = new Set();
  let types = {};

  function notify() {
    if (typeof onChange === 'function') onChange(new Set(hiddenTypes));
  }

  function render() {
    root.innerHTML = '';

    /* 类型行：三个图例横向排列，顺序跟随 places.json 的 types 定义顺序。
       2026-09-28 按用户要求**删掉了「全部显示」那一行** —— 类型只有三个，
       再点一次被筛掉的项即可恢复，不需要额外的复位按钮，
       也就少了一行"平时不出现、筛选一开就多一行"的抖动。 */
    const row = document.createElement('div');
    row.className = 'legend__row';

    Object.keys(types).forEach((type) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'legend__item';
      item.dataset.type = type;
      if (hiddenTypes.has(type)) item.classList.add('is-off');
      item.setAttribute('aria-pressed', String(!hiddenTypes.has(type)));
      item.title = `点击筛选「${type}」`;
      /* 色值来自数据（places.json 的 types），照旧过一层 escapeHtml 再进属性 */
      item.innerHTML = `<span class="legend__pin">${pinSvg({ fill: escapeHtml(types[type]) })}</span>`
        + `<span>${escapeHtml(type)}</span>`;
      item.addEventListener('click', () => {
        if (hiddenTypes.has(type)) hiddenTypes.delete(type);
        else hiddenTypes.add(type);
        /* 整体重渲染：状态只有 is-off / aria-pressed 两处，重渲染最省心，
           将来加元素也不会漏同步。 */
        render();
        notify();
      });
      row.append(item);
    });
    root.append(row);
  }

  return {
    /** @param {object} typeColors { 类型: 颜色 } */
    setTypes(typeColors) {
      types = { ...typeColors };
      // 类型被删除时同步清掉筛选状态，避免"幽灵筛选"
      for (const t of [...hiddenTypes]) if (!(t in types)) hiddenTypes.delete(t);
      render();
    },
    getHiddenTypes: () => new Set(hiddenTypes),
    /* 清空筛选。2026-09-28 起**没有 UI 入口**了（「全部显示」按钮已按用户要求删除），
       保留它是给上层留的程序化复位口子，页面上目前无人调用。 */
    reset() { hiddenTypes.clear(); render(); },
  };
}
