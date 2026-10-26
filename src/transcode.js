/**
 * src/transcode.js · 视频转码
 * ---------------------------------------------------------
 * ffmpeg 在临时目录产出 mp4（H.264 全平台能播）+ 首帧 jpg，再上传到媒体后端，
 * 然后回填数据库；无论成功失败都清理临时文件。返回 Promise。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { markMediaReady, markMediaError, setMediaMeta } = require('./db');
const { saveObject, TMP_DIR } = require('./storage');
const { extractVideoMeta } = require('./exif');

async function transcodeVideo(input, mediaId) {
  const mp4 = path.join(TMP_DIR, mediaId + '.mp4');
  const poster = path.join(TMP_DIR, mediaId + '.jpg');
  const args = [
    '-y', '-i', input,
    '-vf', 'scale=\'min(1280,iw)\':-2', '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', mp4,
    '-ss', '00:00:01', '-vframes', '1', '-q:v', '3', poster,
  ];
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', async (code) => {
      /* 先抽元数据（原文件还在），再删原文件，避免 ffprobe 读不到 */
      let vmeta = null;
      try { vmeta = await extractVideoMeta(input); } catch (_) {}
      try { fs.unlinkSync(input); } catch (_) {}
      if (code === 0) {
        try {
          await saveObject(mediaId + '.mp4', mp4, 'video/mp4');
          await saveObject(mediaId + '.jpg', poster, 'image/jpeg');
          markMediaReady(mediaId, '/media/' + mediaId + '.mp4', '/media/' + mediaId + '.jpg');
          if (vmeta) setMediaMeta(mediaId, vmeta);   // 拍摄时间 / 位置等回填
        } catch (e) {
          console.error('[storage] 视频上传后端失败：', e.message);
          markMediaError(mediaId);
        } finally {
          try { fs.unlinkSync(mp4); } catch (_) {}
          try { fs.unlinkSync(poster); } catch (_) {}
        }
      } else {
        console.error('[ffmpeg] 转码失败:', stderr.slice(0, 300));
        markMediaError(mediaId);
      }
      resolve();
    });
  });
}

module.exports = { transcodeVideo };
