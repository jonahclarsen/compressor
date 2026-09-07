import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
let server, base, dir, image, video, audio;
const ff = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
async function upload(name) {
  const body = new FormData(); body.append('file', new Blob([await readFile(path.join(dir, name))]), name);
  const res = await fetch(`${base}/api/upload`, { method: 'POST', body }); assert.equal(res.status, 200); return res.json();
}
async function post(route, body) {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data)); return data;
}
async function probe(result) {
  const res = await fetch(base + result.url); assert.equal(res.status, 200);
  const buffer = Buffer.from(await res.arrayBuffer()); assert.equal(buffer.length, result.size);
  const output = path.join(dir, result.filename); await writeFile(output, buffer);
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
}
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'compressor-test-'));
  await sharp({ create: { width: 640, height: 480, channels: 4, background: { r: 80, g: 140, b: 190, alpha: .5 } } }).png().toFile(path.join(dir, 'image.png'));
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', path.join(dir, 'video.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', path.join(dir, 'audio.wav')]);
  server = spawn(process.execPath, ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 15000); server.stdout.on('data', data => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } }); server.on('error', reject); });
  image = await upload('image.png'); video = await upload('video.mp4'); audio = await upload('audio.wav');
});
after(async () => { server?.kill('SIGTERM'); if (dir) await rm(dir, { recursive: true, force: true }); });
test('detects media types including PNG input', () => { assert.equal(image.type, 'image'); assert.equal(video.type, 'video'); assert.equal(audio.type, 'audio'); });
for (const [format, codec] of [['jpeg', 'mjpeg'], ['webp', 'webp']]) test(`${format} image preview at selected size`, async () => {
  const settings = { id: image.id, format, quality: 60, resolution: 50, bitrate: 2500 };
  const result = await post('/api/preview', settings), m = await probe(result);
  assert.equal(m.streams[0].codec_name, codec); assert.equal(m.streams[0].width, 320); assert.equal(m.streams[0].height, 240);
  assert.deepEqual(await post('/api/preview', settings), result);
});
for (const [format, codec] of [['vp9', 'vp9'], ['av1', 'av1'], ['avc', 'h264'], ['hevc', 'hevc']]) test(`${format} video preview and full export`, async () => {
  const settings = { id: video.id, format, bitrate: 400, resolution: 50, time: 1 };
  const m = await probe(await post('/api/preview', settings));
  const v = m.streams.find(s => s.codec_type === 'video');
  assert.equal(v.codec_name, codec); assert.equal(v.width, 160); assert.ok(Number(m.format.duration) < 2.2); assert.ok(m.streams.some(s => s.codec_type === 'audio'));
  const { id } = await post('/api/export', settings);
  let state;
  do { await new Promise(r => setTimeout(r, 100)); state = await (await fetch(`${base}/api/jobs/${id}`)).json(); } while (state.status === 'working');
  assert.equal(state.status, 'done', state.error);
  const full = await probe(state.result); assert.ok(Number(full.format.duration) >= 3);
});
for (const format of ['mp3', 'opus']) test(`${format} audio preview and bitrate`, async () => {
  const m = await probe(await post('/api/preview', { id: audio.id, format, bitrate: 256, time: 2 }));
  assert.equal(m.streams[0].codec_name, format); assert.ok(Number(m.format.duration) >= 7.9 && Number(m.format.duration) < 8.2);
  if (format === 'mp3') assert.equal(Number(m.streams[0].bit_rate), 256000);
});
test('rejects PNG output and invalid settings', async () => {
  for (const body of [{ id: image.id, format: 'png' }, { id: video.id, format: 'avc', resolution: -10 }, { id: audio.id, format: 'mp3', bitrate: 512 }]) {
    const res = await fetch(`${base}/api/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(res.status, 400);
  }
});
test('rejects foreign origins', async () => { const res = await fetch(`${base}/api/export`, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(res.status, 403); });

for (const format of ['jpeg', 'webp', 'mp3', 'opus']) test(`${format} full export`, async () => {
  const source = ['jpeg', 'webp'].includes(format) ? image : audio;
  const { id } = await post('/api/export', { id: source.id, format, quality: 75, bitrate: 256 });
  let state;
  do { await new Promise(r => setTimeout(r, 100)); state = await (await fetch(`${base}/api/jobs/${id}`)).json(); } while (state.status === 'working');
  assert.equal(state.status, 'done', state.error);
  const m = await probe(state.result);
  if (source === audio) assert.ok(Number(m.format.duration) >= 10);
  else assert.equal(m.streams[0].width, 640);
});
for (const format of ['av1', 'hevc']) test(`${format} minimum resolution remains encodable`, async () => {
  const m = await probe(await post('/api/preview', { id: video.id, format, bitrate: 200, resolution: 5 }));
  const v = m.streams.find(s => s.codec_type === 'video');
  assert.ok(v.width >= (format === 'av1' ? 64 : 16));
  assert.ok(v.height >= (format === 'av1' ? 64 : 16));
});
for (const type of ['image', 'video', 'audio']) test(`${type} original reference`, async () => {
  const source = { image, video, audio }[type];
  const m = await probe(await post('/api/preview', { id: source.id, format: 'original', seconds: 1 }));
  if (type === 'image') { assert.equal(m.streams[0].codec_name, 'png'); assert.equal(m.streams[0].width, 640); }
  if (type === 'video') { assert.equal(m.streams[0].codec_name, 'vp9'); assert.equal(m.streams[0].width, 320); assert.ok(Number(m.format.duration) < 1.2); }
  if (type === 'audio') assert.equal(m.streams[0].codec_name, 'pcm_f32le');
});
test('preview duration changes encoded length and cache key', async () => {
  const one = await post('/api/preview', { id: video.id, format: 'avc', bitrate: 400, seconds: 1 });
  const three = await post('/api/preview', { id: video.id, format: 'avc', bitrate: 400, seconds: 3 });
  assert.notEqual(one.url, three.url); assert.equal(one.seconds, 1); assert.equal(three.seconds, 3);
  assert.ok(Number((await probe(one)).format.duration) < 1.2);
  assert.ok(Number((await probe(three)).format.duration) >= 3);
  for (const seconds of [0, 21, 'bad']) {
    const res = await fetch(`${base}/api/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: video.id, format: 'avc', seconds }) }); assert.equal(res.status, 400);
  }
});
test('original is preview-only', async () => {
  const res = await fetch(`${base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: image.id, format: 'original' }) }); assert.equal(res.status, 400);
});
test('unsupported codec playback uses a lossless proxy of the encoded result', async () => {
  const result = await post('/api/preview', { id: video.id, format: 'hevc', bitrate: 400, seconds: 1 });
  const proxy = await post('/api/playback', { url: result.url });
  const download = await fetch(base + proxy.url); const buffer = Buffer.from(await download.arrayBuffer());
  const dest = path.join(dir, 'proxy.webm'); await writeFile(dest, buffer);
  const encoded = path.join(dir, 'encoded.mp4'); await writeFile(encoded, Buffer.from(await (await fetch(base + result.url)).arrayBuffer()));
  const raw = filename => execFileSync('ffmpeg', ['-v', 'error', '-i', filename, '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1']);
  assert.deepEqual(raw(dest), raw(encoded));
  assert.deepEqual(await post('/api/playback', { url: result.url }), proxy);
  const invalid = await fetch(`${base}/api/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: '/etc/passwd' }) }); assert.equal(invalid.status, 400);
});
