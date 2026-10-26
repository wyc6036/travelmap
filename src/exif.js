/**
 * src/exif.js · 媒体元数据提取（拍摄时间 / 设备 / 位置 等，供查看页信息栏展示）
 * ---------------------------------------------------------
 * 图片：sharp 读出原始 EXIF buffer → exif-reader 解析成结构化字段。
 * 视频：ffprobe 读 format.tags（creation_time / location / Make / Model）。
 * 全部包在 try 里、失败返回 null —— 元数据是"锦上添花"，绝不让它拖垮上传。
 */
const { spawn } = require('child_process');
const exifReader = require('exif-reader');

/** 把 EXIF 的 "2023:05:01 14:30:00" 规整成 ISO "2023-05-01T14:30:00" */
function parseExifDateTime(s) {
  if (!s) return '';
  // exif-reader 把日期标签解析成 Date 对象，也可能直接给字符串
  const str = (s instanceof Date)
    ? s.toISOString()
    : (typeof s === 'string' ? s : '');
  if (!str) return '';
  // ISO 格式（exif-reader 多给这种）：2026-10-03T15:28:37.000Z / 2026-10-03T15:28:37Z
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  // EXIF 原始格式：2026:10:03 15:28:37
  m = str.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  return str;
}

/** EXIF GPS 可能是十进制数字，也可能是 [度,分,秒] 的数组（exif-reader 不一定会转成十进制）。
 *  每段还可能再包一层数组；按 N/S/E/W 参考方向决定是否取负。 */
function gpsToDecimal(coord, ref) {
  if (coord == null) return null;
  let dec;
  if (typeof coord === 'number') dec = coord;
  else if (Array.isArray(coord)) {
    const pick = (v) => (Array.isArray(v) ? v[0] : v);
    const d = Number(pick(coord[0]));
    const m = Number(pick(coord[1]));
    const s = Number(pick(coord[2]));
    if (![d, m, s].every(Number.isFinite)) return null;
    dec = d + m / 60 + s / 3600;
  } else {
    dec = Number(coord);
  }
  if (!Number.isFinite(dec)) return null;
  if (typeof ref === 'string' && /[SW]/i.test(ref)) dec = -dec;
  return dec;
}

/** EXIF 里部分字段可能是数组（如 ISO=[80,80]），统一取首值转数字 */
function numOr0(v) {
  if (v == null) return 0;
  if (Array.isArray(v)) v = v[0];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从 sharp 读出的原始 EXIF buffer 解析出展示所需的元数据。
 * 注意：exif-reader 多数情况下把 GPS 给成 [度,分,秒] 数组（而非十进制），由 gpsToDecimal 换算。
 * @returns {object|null} { taken_at, camera_make, camera_model, lens, gps_lat, gps_lng, focal_length, f_number, iso }
 */
function extractImageMeta(exifBuf) {
  if (!exifBuf) return null;
  let data;
  try { data = exifReader(exifBuf); } catch (_) { return null; }
  const img = data.image || {};
  const ex = data.exif || {};
  const gps = data.gps || {};
  const out = {
    camera_make: String(img.Make || '').trim(),
    camera_model: String(img.Model || '').trim(),
    lens: String(ex.LensModel || ex.Lens || '').trim(),
    focal_length: Math.round(numOr0(ex.FocalLength) * 10) / 10,   // 1 位小数：EXIF 常带 5.960000038146973 这类浮点噪音
    f_number: Math.round(numOr0(ex.FNumber) * 100) / 100,
    iso: Math.round(numOr0(ex.ISO)),
  };
  if (ex.DateTimeOriginal) out.taken_at = parseExifDateTime(ex.DateTimeOriginal);
  const lat = gpsToDecimal(gps.GPSLatitude, gps.GPSLatitudeRef);
  const lng = gpsToDecimal(gps.GPSLongitude, gps.GPSLongitudeRef);
  if (lat != null && lng != null) {
    out.gps_lat = +lat.toFixed(6);
    out.gps_lng = +lng.toFixed(6);
  }
  // 全空则不返回，省得写一堆空字段
  const has = out.taken_at || out.camera_make || out.camera_model || out.lens
    || out.gps_lat || out.gps_lng || out.focal_length || out.f_number || out.iso;
  return has ? out : null;
}

/**
 * 视频元数据：ffprobe 取 format.tags。
 *   creation_time → 拍摄时间（ISO，去掉末尾 Z 由前端自由格式化）
 *   location      → QuickTime 格式 "+35.0116+135.7681/"，解析出经纬度
 *   Make / Model  → 部分设备会写
 * @returns {object|null}
 */
function extractVideoMeta(inputPath) {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath]);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        const j = JSON.parse(out || '{}');
        const tags = (j && j.format && j.format.tags) || {};
        const meta = {
          camera_make: '', camera_model: '', lens: '',
          focal_length: 0, f_number: 0, iso: 0, gps_lat: 0, gps_lng: 0,
        };
        if (tags.creation_time) meta.taken_at = String(tags.creation_time).replace(/Z$/, '');
        if (tags.location) {
          const m = String(tags.location).match(/([+-]?\d+(?:\.\d+)?)[ ,]?([+-]?\d+(?:\.\d+)?)/);
          if (m) { meta.gps_lat = parseFloat(m[1]); meta.gps_lng = parseFloat(m[2]); }
        }
        if (tags.Make) meta.camera_make = String(tags.Make).trim();
        if (tags.Model) meta.camera_model = String(tags.Model).trim();
        const has = meta.taken_at || meta.camera_make || meta.camera_model
          || meta.gps_lat || meta.gps_lng;
        resolve(has ? meta : null);
      } catch (_) { resolve(null); }
    });
  });
}

module.exports = { extractImageMeta, extractVideoMeta };
