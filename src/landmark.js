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

module.exports = { fetchLandmarkImage };
