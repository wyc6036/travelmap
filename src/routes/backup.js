/**
 * src/routes/backup.js · 备份导出 / 导入（zip）
 * ---------------------------------------------------------
 * 导出：数据库原始行 + checkpoint 后的自洽 SQLite 单文件 + 媒体文件，archiver 流式打包，不落临时盘。
 *   zip 内结构：
 *     data.json     —— { version, exportedAt, data:{...} } 数据库原始行，程序导入时读这个（唯一的恢复数据源）
 *     travelmap.db  —— 已 checkpoint 的自洽 SQLite 单文件，纯兜底存档，导入时不读
 *     media/<key>   —— 各媒体对象文件（图 / 缩略图 / 视频 / 首帧 / 头像），按 key 扁平存放
 * 导入：上传 zip 备份，先回存媒体文件，再在事务里重建数据库。
 *   导入会覆盖当前全部数据（含媒体），操作前前端已二次确认。受登录保护（write）。
 */
const express = require('express');
const path = require('path');
const archiver = require('archiver');
const { requireAuth } = require('../auth');
const { getExportBundle, applyImportBundle, exportDbSnapshot } = require('../db');
const storage = require('../storage');
const { importUpload, CTYPE } = require('../uploads');

const router = express.Router();
const write = requireAuth;

router.get('/api/export-zip', requireAuth, async (_req, res) => {
  try {
    const bundle = getExportBundle();
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment(`travelmap-backup-${new Date().toISOString().slice(0, 10)}.zip`);
    archive.pipe(res);

    archive.append(JSON.stringify(bundle, null, 2), { name: 'data.json' });

    /* 再塞一份「Bootstrap 快照」：checkpoint 后自洽的 SQLite 单文件。
       纯兜底存档（解压即可用 sqlite3 直接查，或整文件拷回 /data 做冷恢复）。
       ⚠️ 导入走的是上面的 data.json，**不读这个文件** —— 它是给人留的后路，
          不是程序的数据源。放在这里是因为它必须先 checkpoint 才能自洽，
          而这事只能在服务端对着正在运行的连接做。 */
    try {
      archive.append(exportDbSnapshot(), { name: 'travelmap.db' });
    } catch (e) {
      console.warn('[export-zip] db 快照打包失败（不影响导出）：', e.message);
    }

    /* 收集需要打包的媒体 key：媒体 url/thumb + 地点/行程封面 + 头像 */
    const keys = new Set();
    for (const m of bundle.data.media) {
      for (const u of [m.url, m.thumb_url]) {
        const k = u ? String(u).split('/media/')[1] : '';
        if (k) keys.add(k);
      }
    }
    for (const p of bundle.data.places) {
      const k = p.cover_url ? String(p.cover_url).split('/media/')[1] : '';
      if (k) keys.add(k);
    }
    for (const t of bundle.data.trips) {
      const k = t.cover_url ? String(t.cover_url).split('/media/')[1] : '';
      if (k) keys.add(k);
    }
    const prof = bundle.data.userProfile;
    if (prof && prof.avatar) {
      const k = String(prof.avatar).split('/media/')[1];
      if (k) keys.add(k);
    }

    for (const k of keys) {
      const buf = await storage.getObjectBuffer(k);
      if (buf) archive.append(buf, { name: 'media/' + k });
    }
    await archive.finalize();
  } catch (e) {
    console.error('[export-zip] 失败:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message || '导出失败' });
  }
});

router.post('/api/import-zip', write, importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const AdmZip = require('adm-zip');
    let zip;
    try { zip = new AdmZip(req.file.buffer); }
    catch (_) { return res.status(400).json({ error: '不是有效的 zip 文件' }); }

    const entry = zip.getEntry('data.json');
    if (!entry) return res.status(400).json({ error: '压缩包缺少 data.json' });
    let bundle;
    try { bundle = JSON.parse(zip.readAsText(entry)); }
    catch (_) { return res.status(400).json({ error: 'data.json 解析失败' }); }

    /* 先回存媒体文件（扁平 key，拒绝任何含路径的条目防目录穿越） */
    const mediaEntries = zip.getEntries()
      .filter((en) => !en.isDirectory && en.entryName.startsWith('media/'));
    for (const en of mediaEntries) {
      const key = en.entryName.slice('media/'.length);
      if (!key || key.includes('/') || key.includes('\\') || key.includes('..')) continue;
      try {
        await storage.putObject(key, en.getData(), CTYPE[path.extname(key).toLowerCase()] || 'application/octet-stream');
      } catch (err) {
        console.warn('[import-zip] 写入媒体对象失败：', key, err.message);
      }
    }

    const summary = applyImportBundle(bundle);
    res.json({ ok: true, ...summary });
  } catch (e) {
    console.error('[import-zip] 失败:', e);
    res.status(500).json({ error: e.message || '导入失败' });
  }
});

module.exports = router;
