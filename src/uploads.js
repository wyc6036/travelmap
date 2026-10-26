/**
 * src/uploads.js · multer 上传实例 + 媒体对象 Content-Type 表
 * ---------------------------------------------------------
 * upload       —— 媒体/头像上传：磁盘暂存到 TMP_DIR，文件名用生成的媒体 id
 *                 （generatedId 挂在 file 对象上，路由里直接取）
 * importUpload —— 备份导入：zip 压缩包走内存（不必落临时盘），上限 2GB（个人级数据足够）
 * CTYPE        —— /media/<key> 与 import-zip 回存对象时的 Content-Type 推断表
 */
const multer = require('multer');
const path = require('path');
const { uid } = require('./db');
const { TMP_DIR } = require('./storage');

const CTYPE = {
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.svg': 'image/svg+xml',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => {
      const id = uid('m');
      file.generatedId = id;
      const ext = path.extname(file.originalname || '') || '';
      cb(null, id + '_orig' + ext);
    },
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024 },
});

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

module.exports = { upload, importUpload, CTYPE };
