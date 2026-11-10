/**
 * src/landmark.js · 联网拉取地标占位图（新增地点时作封面）
 * ---------------------------------------------------------
 * 用维基百科 / 维基共享资源的公开 API（无需 key）：
 *   1. 中文维基 pageimages（取词条首图缩略图，通常是该地标志性地标）
 *   2. 英文维基 pageimages（中文没命中时兜底）
 *   3. 维基共享资源 Commons 按 "<地名> landmark" 搜索，取第一张图
 * 全程带 4s 超时与异常兜底；拿不到就返回 null（封面留空，前端回退默认占位图）。
 * 返回的是远程图片 URL（不下载到本地），前端 <img> 直接展示即可。
 */

async function fetchLandmarkImage(name) {
  if (!name || typeof name !== 'string' || !name.trim()) return null;
  const q = name.trim();

  const wikiThumb = async (lang) => {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json`
      + `&prop=pageimages&piprop=thumbnail&pithumbsize=800&redirects=1&titles=${encodeURIComponent(q)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'TravelMap/1.0 (travelmap)' } });
      if (!r.ok) return null;
      const j = await r.json();
      const pages = (j && j.query && j.query.pages) || {};
      for (const k of Object.keys(pages)) {
        const thumb = pages[k] && pages[k].thumbnail && pages[k].thumbnail.source;
        if (thumb) return thumb;
      }
      return null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const commonsThumb = async () => {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json`
      + `&generator=search&gsrsearch=${encodeURIComponent(q + ' landmark')}`
      + `&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url&iiurlwidth=800&redirects=1`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'TravelMap/1.0 (travelmap)' } });
      if (!r.ok) return null;
      const j = await r.json();
      const pages = (j && j.query && j.query.pages) || {};
      for (const k of Object.keys(pages)) {
        const ii = pages[k] && pages[k].imageinfo && pages[k].imageinfo[0];
        if (ii && ii.thumburl) return ii.thumburl;
      }
      return null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return (await wikiThumb('zh')) || (await wikiThumb('en')) || (await commonsThumb());
}

/**
 * 启动时补齐「有名字、没媒体、没封面」的地点（后台跑，失败静默）。
 *
 * 为什么需要：2026-10-29 之前的 upsert 会把缺失的 cover 当成空串整行覆盖，
 * 于是「编辑一次地点」就会把建点时联网抓的地标封面抹掉，而前端只会退化成
 * 类型色占位块 —— 数据其实已经丢了，靠前端怎么修都补不回来。
 * 库层已改成「缺省即保留」，存量被抹掉的行则由这里在下次启动时自动抓回来；
 * 用户自己传过照片的地点（media 非空）不碰，封面照旧由媒体兜底。
 *
 * 惰性 require('./db')：db.js 加载期会建表/迁移，且 landmark 被 routes 引用，
 * 顶层互相 require 会形成加载环。
 */
async function backfillPlaceCovers() {
  let db;
  try { db = require('./db'); } catch (_) { return; }
  if (typeof db.placesMissingCover !== 'function') return;
  let rows = [];
  try { rows = db.placesMissingCover(); } catch (_) { return; }
  if (!rows.length) return;
  let fixed = 0;
  for (const r of rows) {
    const url = await fetchLandmarkImage(r.name);
    if (url) { db.setPlaceCoverUrl(r.id, url); fixed += 1; }
  }
  if (fixed) console.log(`[cover] 已为 ${fixed} 个无封面地点补齐地标图（共检查 ${rows.length} 个）`);
}

module.exports = { fetchLandmarkImage, backfillPlaceCovers };
