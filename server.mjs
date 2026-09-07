import { createServer } from 'node:http';
import { listenOnSavedPort } from './port.mjs';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'compressor-'));
const files = new Map(), jobs = new Map(), cache = new Map(), children = new Set();
const app = express();
app.use((req, res, next) => {
  const host = req.headers.host?.split(':')[0];
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return res.sendStatus(403);
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.sendStatus(403);
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use('/media', express.static(root, { dotfiles: 'deny', index: false }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));
const upload = multer({ dest: root, limits: { fileSize: 20 * 1024 ** 3, files: 1 } });
function run(command, args, signal, onProgress) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(p);
    let out = '', err = '';
    const abort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    p.stdout.on('data', data => { out = (out + data).slice(-2_000_000); onProgress?.(String(data)); });
    p.stderr.on('data', data => { err = (err + data).slice(-4000); });
    p.on('error', reject);
    p.on('close', code => {
      children.delete(p); signal?.removeEventListener('abort', abort);
      code === 0 ? resolve(out) : reject(new Error(signal?.aborted ? 'Cancelled' : err || `${command} failed`));
    });
  });
}
const ff = (args, signal, progress) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-nostdin', '-threads', '2', '-filter_threads', '1', ...args], signal, progress);
const input = f => ['-protocol_whitelist', 'file,pipe', '-i', f.path];
let active = 0;
const queue = [];
async function limited(fn, signal) {
  if (active >= 2) await new Promise(resolve => queue.push(resolve));
  active++;
  try { if (signal?.aborted) throw new Error('Cancelled'); return await fn(); }
  finally { active--; queue.shift()?.(); }
}
app.post('/api/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new Error('Choose a file');
    const f = { id: randomUUID(), path: req.file.path, name: req.file.originalname, size: req.file.size };
    try {
      const m = await sharp(f.path).metadata();
      f.type = 'image'; f.width = m.autoOrient?.width || m.width; f.height = m.autoOrient?.height || m.height;
    } catch {
      const m = JSON.parse(await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', f.path]));
      const v = m.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
      const a = m.streams.find(s => s.codec_type === 'audio');
      if (!v && !a) throw new Error('Unsupported media');
      f.duration = Number(m.format.duration || v?.duration || a?.duration) || 0;
      f.type = v ? (/(image2|_pipe)/.test(m.format.format_name) ? 'image' : 'video') : 'audio';
      f.width = v?.width; f.height = v?.height;
      if (Math.abs(Number(v?.side_data_list?.find(s => s.rotation)?.rotation || 0)) % 180 === 90) [f.width, f.height] = [f.height, f.width];
      if (f.type === 'image') {
        const decoded = path.join(root, `${f.id}-decoded.png`);
        await ff([...input(f), '-frames:v', '1', decoded]);
        f.path = decoded;
      }
    }
    files.set(f.id, f);
    const { path: hidden, ...info } = f;
    res.json(info);
  } catch (e) { if (req.file) await rm(req.file.path, { force: true }); next(e); }
});
function settings(f, body, preview = false) {
  const formats = { image: ['jpeg', 'webp'], video: ['vp9', 'av1', 'hevc', 'avc'], audio: ['mp3', 'opus'] };
  if (!(preview && body.format === 'original') && !formats[f.type].includes(body.format)) throw new Error('Invalid format');
  const bounded = (v, lo, hi, fallback) => { const n = Number(v ?? fallback); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error('Invalid settings'); return n; };
  const s = { format: body.format, quality: Math.round(bounded(body.quality, 1, 100, 80)), resolution: bounded(body.resolution, 5, 100, 100), bitrate: bounded(f.type === 'image' ? 256 : body.bitrate, f.type === 'video' ? 50 : 8, f.type === 'video' ? 100000 : 512, 256), seconds: bounded(body.seconds, 1, 20, f.type === 'audio' ? 8 : 3), time: bounded(body.time, 0, Math.max(0, f.duration || 0), 0) };
  if (s.format === 'mp3' && ![32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320].includes(s.bitrate)) throw new Error('Invalid MP3 bitrate');
  return s;
}
async function convert(f, s, preview, signal, progress) {
  const original = s.format === 'original';
  const mp4 = ['hevc', 'avc'].includes(s.format);
  const ext = original ? ({ image: 'png', video: 'webm', audio: 'wav' }[f.type]) : f.type === 'video' ? (mp4 ? 'mp4' : 'webm') : s.format === 'jpeg' ? 'jpg' : s.format;
  const key = createHash('sha256').update(JSON.stringify([f.id, s, preview])).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const name = `${randomUUID()}.${ext}`, dest = path.join(root, name);
  await limited(async () => {
    if (f.type === 'image') {
      let pipeline = sharp(f.path).rotate().resize({ width: original ? f.width : Math.max(1, Math.round(f.width * s.resolution / 100)), withoutEnlargement: true });
      if (original) pipeline = pipeline.png();
      if (s.format === 'jpeg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: s.quality, mozjpeg: true });
      if (s.format === 'webp') pipeline = pipeline.webp({ quality: s.quality, effort: 3 });
      await pipeline.toFile(dest);
    } else {
      const args = [...(preview ? ['-ss', String(Math.min(s.time, Math.max(0, f.duration - 0.1)))] : []), ...input(f)];
      if (preview) args.push('-t', String(s.seconds));
      if (original) {
        if (f.type === 'video') args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libvpx-vp9', '-lossless', '1', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-threads', '2', '-c:a', 'libopus', '-b:a', '256k', '-ac', '2');
        else args.push('-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2');
      } else if (f.type === 'video') {
        const minimum = s.format === 'av1' ? 64 : s.format === 'hevc' ? 16 : 2;
        const w = Math.max(Math.ceil(Math.max(minimum, minimum * f.width / f.height) / 2) * 2, Math.floor(f.width * s.resolution / 200) * 2);
        const codec = { vp9: 'libvpx-vp9', av1: 'libsvtav1', hevc: 'libx265', avc: 'libx264' }[s.format];
        args.push('-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=${w}:-2`, '-pix_fmt', 'yuv420p', '-c:v', codec, '-b:v', `${s.bitrate}k`, '-threads', '2');
        if (s.format === 'vp9') args.push('-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1');
        else if (s.format === 'av1') args.push('-preset', '4', '-svtav1-params', 'lp=2');
        else args.push('-preset', 'veryfast');
        if (s.format === 'hevc') args.push('-tag:v', 'hvc1', '-x265-params', 'pools=2:frame-threads=2:log-level=error');
        if (mp4) args.push('-movflags', '+faststart');
        args.push('-c:a', mp4 ? 'aac' : 'libopus', '-b:a', '128k', '-ac', '2');
      } else args.push('-map', '0:a:0', '-vn', '-c:a', s.format === 'mp3' ? 'libmp3lame' : 'libopus', '-b:a', `${s.bitrate}k`, '-ar', '48000', '-ac', '2');
      args.push('-progress', 'pipe:1', dest);
      await ff(args, signal, chunk => { const matches = [...chunk.matchAll(/out_time_us=(\d+)/g)]; if (matches.length && f.duration) progress?.(Math.min(99, Number(matches.at(-1)[1]) / (f.duration * 10000))); });
    }
  }, signal).catch(async e => { await rm(dest, { force: true }); throw e; });
  let poster;
  if (preview && f.type === 'video') {
    const posterName = `${randomUUID()}.png`;
    await limited(() => ff(['-i', dest, '-frames:v', '1', path.join(root, posterName)], signal), signal);
    poster = `/media/${posterName}`;
  }
  const result = { url: `/media/${name}`, poster, size: (await stat(dest)).size, seconds: Math.min(s.seconds, Math.max(0, (f.duration || 0) - s.time)), filename: `${path.parse(f.name).name}-${s.format}-${f.type === 'image' ? s.quality : s.bitrate}.${ext}` };
  cache.set(key, result); return result;
}
app.post('/api/preview', async (req, res, next) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const f = files.get(req.body.id); if (!f) throw new Error('File not found');
    res.json(await convert(f, settings(f, req.body, true), true, controller.signal));
  } catch (e) { if (!controller.signal.aborted) next(e); }
});
const playbackCache = new Map();
app.post('/api/playback', async (req, res, next) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const source = [...cache.values()].find(result => result.url === req.body.url && result.poster);
    if (!source) throw new Error('Preview not found');
    if (playbackCache.has(source.url)) return res.json(playbackCache.get(source.url));
    const name = `${randomUUID()}.webm`, dest = path.join(root, name);
    try {
      await limited(() => ff(['-i', path.join(root, path.basename(source.url)), '-map', '0:v:0', '-an', '-c:v', 'libvpx-vp9', '-lossless', '1', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-threads', '2', dest], controller.signal), controller.signal);
    } catch (e) { await rm(dest, { force: true }); throw e; }
    const result = { url: `/media/${name}` }; playbackCache.set(source.url, result); res.json(result);
  } catch (e) { if (!controller.signal.aborted) next(e); }
});
app.post('/api/export', (req, res, next) => {
  try {
    const f = files.get(req.body.id); if (!f) throw new Error('File not found');
    const s = settings(f, req.body), id = randomUUID(), controller = new AbortController();
    const job = { id, progress: 0, status: 'working', controller }; jobs.set(id, job);
    convert(f, s, false, controller.signal, p => { job.progress = p; }).then(result => Object.assign(job, { status: 'done', progress: 100, result })).catch(e => Object.assign(job, { status: 'error', error: controller.signal.aborted ? 'Cancelled' : e.message }));
    res.json({ id });
  } catch (e) { next(e); }
});
app.get('/api/jobs/:id', (req, res) => { const j = jobs.get(req.params.id); if (!j) return res.sendStatus(404); const { controller, ...info } = j; res.json(info); });
app.delete('/api/jobs/:id', (req, res) => { jobs.get(req.params.id)?.controller.abort(); res.sendStatus(204); });
app.use((error, req, res, next) => { console.error(error.message); res.status(400).json({ error: error.message.slice(-600) }); });
await run('ffmpeg', ['-version']);
await run('ffprobe', ['-version']);
const portFile = process.env.COMPRESSOR_PORT_FILE || fileURLToPath(new URL('.compressor-port', import.meta.url));
try {
  const port = await listenOnSavedPort(createServer(app), portFile);
  console.log(`Compressor: http://127.0.0.1:${port}`);
} catch (error) {
  console.error(error.message);
  await rm(root, { recursive: true, force: true });
  process.exit(1);
}
async function cleanup() { for (const child of children) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); process.exit(); }
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
