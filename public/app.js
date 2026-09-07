const $ = s => document.querySelector(s);
const cards = [];
const previewCache = new Map(), pendingPreviews = new Map();
let copiedSettings;
let locks = { bitrate: false, resolution: false };
let file, uploadVersion = 0, revision = 0, timer, controller;
let playing = false, running = false, loading = false, scrubbing = false, segmentStart = 0, offset = 0, audible;
const bytes = n => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
const clock = n => `${Math.floor(n / 60)}:${(n % 60).toFixed(1).padStart(4, '0')}`;
const options = entries => entries.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
const duration = () => Number($('#duration').value);
const clipLength = () => Math.min(duration(), Math.max(.05, (file?.duration || 0) - segmentStart));
const players = () => cards.map(c => c.media).filter(m => m?.play && m.readyState >= 1);
const stateKey = 'compressor.state.v1';
let sourceKey, restoring = false, restoredScroll;
// The workspace is rebuilt asynchronously, so native history restoration runs too early.
history.scrollRestoration = 'manual';
function storageWarning(message) { $('#error').textContent = message; }
function sourceStore(mode, value) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('compressor', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('source');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('source', mode);
      const store = transaction.objectStore('source');
      const operation = mode === 'readonly' ? store.get('current') : store.put(value, 'current');
      transaction.oncomplete = () => { db.close(); resolve(operation.result); };
      transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
}
function saveState() {
  if (!file || !sourceKey || restoring) return;
  try {
    localStorage.setItem(stateKey, JSON.stringify({
      version: 1, sourceKey, cards: cards.map(c => ({ original: c.original, settings: c.settings })),
      copiedSettings, locks, duration: duration(), segmentStart, offset, playing,
      audible: cards.indexOf(audible), scroll: restoredScroll || { x: scrollX, y: scrollY, cards: $('#cards').scrollLeft },
    }));
  } catch { storageWarning('Browser storage is unavailable or full. Changes cannot be saved.'); }
}
async function restoreState() {
  const version = uploadVersion;
  try {
    const saved = JSON.parse(localStorage.getItem(stateKey) || 'null');
    if (!saved) return;
    if (saved.version !== 1 || !Array.isArray(saved.cards) || !saved.cards.length ||
        !saved.cards[0].original || saved.cards.some(c => !c.settings) ||
        ![saved.duration, saved.segmentStart, saved.offset].every(Number.isFinite)) {
      throw new Error('Invalid saved state');
    }
    const stored = await sourceStore('readonly');
    if (version !== uploadVersion) return;
    if (!stored?.source || stored.key !== saved.sourceKey) throw new Error('Saved source unavailable');
    await loadFile(stored.source, saved);
  } catch {
    if (version === uploadVersion) storageWarning('Could not restore the saved session. Open the source file to start again.');
  }
}
// Save discrete edits immediately, and checkpoint the moving playhead without writing every frame.
for (const event of ['input', 'change', 'click']) document.addEventListener(event, () => queueMicrotask(saveState));
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveState(); });
window.addEventListener('scroll', saveState, { passive: true });
$('#cards').addEventListener('scroll', saveState, { passive: true });
setInterval(() => { if (running) saveState(); }, 500);
async function api(url, body, signal, method = 'POST') {
  const res = await fetch(url, { method, signal, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Request failed'); }
  return res.status === 204 ? null : res.json();
}
$('#drop').onclick = () => $('#file').click();
$('#file').onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) document.body.classList.remove('dragging'); });
window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
async function loadFile(source, saved = null) {
  const version = ++uploadVersion;
  $('#error').textContent = ''; $('#drop > span:nth-child(2)').textContent = 'Opening…';
  try {
    const body = new FormData(); body.append('file', source);
    const res = await fetch('/api/upload', { method: 'POST', body });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Could not open file');
    if (version !== uploadVersion) return;
    restoring = true;
    const key = saved?.sourceKey || crypto.randomUUID();
    if (!saved) {
      try { await sourceStore('readwrite', { key, source }); }
      catch { storageWarning('Could not save the source file. This session may not reopen automatically.'); }
      if (version !== uploadVersion) return;
    }
    sourceKey = key; restoredScroll = saved?.scroll;
    controller?.abort(); clearTimeout(timer); revision++; pausePlayers();
    for (const c of [...cards]) removeCard(c, false);
    copiedSettings = null; previewCache.clear(); pendingPreviews.clear();
    locks = { bitrate: saved?.locks?.bitrate === true, resolution: saved?.locks?.resolution === true };
    file = data; playing = false; offset = 0; segmentStart = 0; audible = null;
    $('#empty').hidden = true; $('#workspace').hidden = false;
    $('#file-name').textContent = file.name;
    $('#file-meta').textContent = [bytes(file.size), file.width ? `${file.width} × ${file.height}` : '', file.duration ? clock(file.duration) : ''].filter(Boolean).join('  ·  ');
    for (const id of ['#time-wrap', '#play', '#duration-wrap']) $(id).hidden = file.type === 'image';
    $('#time').max = Math.max(0, (file.duration || 0) - .05); $('#time').value = 0;
    $('#duration').value = file.type === 'audio' ? 8 : 3; $('#duration-label').textContent = `${duration()} s`;
    if (saved) {
      copiedSettings = saved.copiedSettings || null;
      $('#duration').value = Math.max(1, Math.min(20, saved.duration));
      $('#duration-label').textContent = `${duration()} s`;
      segmentStart = Math.max(0, Math.min(Number($('#time').max), saved.segmentStart));
      offset = Math.max(0, Math.min(clipLength(), saved.offset));
      saved.cards.forEach(c => addCard(c.settings, c.original));
      audible = cards[saved.audible] || cards[0];
      playing = file.type !== 'image' && saved.playing === true;
    } else {
      addCard({}, true);
      if (file.type === 'audio') addCard({ bitrate: 256 });
      else [0, 1, 2].forEach(i => addCard({ quality: [45, 75, 92][i], bitrate: [800, 2500, 6000][i] }));
    }
    updateAudio(); updateTransport();
    if (restoredScroll) {
      window.scrollTo({ left: restoredScroll.x || 0, top: restoredScroll.y || 0, behavior: 'instant' });
      $('#cards').scrollLeft = restoredScroll.cards || 0;
      restoredScroll = null;
    }
    restoring = false; schedule(0);
  } catch (e) { if (version === uploadVersion) $('#error').textContent = e.message; }
  finally { if (version === uploadVersion) { restoring = false; $('#drop > span:nth-child(2)').textContent = 'Drop a file'; } }
}
function lockControl(key, label, slider) {
  return `<div class="control"><div class="control-line"><span>${label}</span><span class="control-value"><output class="${key}-output"></output><button type="button" class="setting-lock secondary" data-lock="${key}" aria-label="Lock ${label.toLowerCase()} across previews" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path class="lock-shackle"/></svg></button></span></div>${slider}</div>`;
}
function syncSettings(c) {
  for (const key of ['bitrate', 'resolution']) {
    if (!locks[key]) continue;
    if (key === 'bitrate' && c.type === 'audio') c.settings.bitrate = rates(c).reduce((a, b) => Math.abs(b - c.settings.bitrate) < Math.abs(a - c.settings.bitrate) ? b : a);
    cards.filter(card => !card.original).forEach(card => { card.settings[key] = c.settings[key]; });
  }
  cards.filter(card => !card.original).forEach(card => {
    card.element.querySelectorAll('[data-key]').forEach(input => {
      input.value = input.dataset.key === 'bitrate' ? bitratePosition(card) : card.settings[input.dataset.key];
    });
    updateLabels(card);
    card.element.querySelectorAll('[data-lock]').forEach(button => {
      const key = button.dataset.lock, locked = locks[key];
      button.setAttribute('aria-pressed', String(locked));
      button.title = `${locked ? 'Unlock' : 'Lock'} ${key} across previews${locked ? '' : ' at this value'}`;
      button.querySelector('.lock-shackle').setAttribute('d', locked ? 'M8 10V7a4 4 0 0 1 8 0v3' : 'M8 10V7a4 4 0 0 1 8 0');
    });
  });
}
function addCard(overrides = {}, original = false) {
  const type = file.type;
  const c = { file, type, original, settings: { format: original ? 'original' : type === 'image' ? 'webp' : type === 'video' ? 'vp9' : 'mp3', quality: 75, resolution: 100, bitrate: type === 'audio' ? 256 : 2500, ...overrides }, element: document.createElement('article') };
  c.element.className = `card${original ? ' original' : ''}`;
  const formats = type === 'image' ? [['webp', 'WebP'], ['jpeg', 'JPEG']] : type === 'video' ? [['vp9', 'VP9 · WebM'], ['av1', 'AV1 · WebM'], ['hevc', 'HEVC · MP4'], ['avc', 'AVC · MP4']] : [['mp3', 'MP3'], ['opus', 'Opus']];
  c.element.innerHTML = `<div class="card-header"><strong>${original ? 'Original' : '<span class="number"></span>Preview'}</strong>${original ? '' : '<button class="remove" aria-label="Remove comparison">×</button>'}</div><div class="preview"><span class="status">Preparing…</span></div><div class="detail"><canvas></canvas><span>${type === 'audio' ? 'Waveform' : '1×'}</span></div>${original ? '' : `<div class="controls"><label class="control"><span class="control-line">Format</span><select data-key="format" aria-label="Format">${options(formats)}</select></label>${type === 'image' ? '<label class="control"><span class="control-line">Quality <output class="quality-output"></output></span><input type="range" data-key="quality" min="1" max="100" aria-label="Quality"></label>' : lockControl('bitrate', 'Bitrate', '<input data-key="bitrate" type="range" min="0" max="1000" step="1" aria-label="Bitrate">')}${type !== 'audio' ? lockControl('resolution', 'Resolution', '<input type="range" data-key="resolution" min="5" max="100" step="1" aria-label="Resolution">') : ''}</div>`}<p class="card-error" role="alert"></p><div class="card-bottom"><span class="size">—</span>${type === 'audio' ? '<button class="listen secondary">Listen</button>' : ''}${original ? '' : '<div class="card-actions"><button class="copy-settings secondary" aria-label="Copy settings" title="Copy settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg></button><button class="paste-settings secondary" aria-label="Paste settings" title="Copy settings from a preview first" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M9 5H5v16h14V5h-4"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M8 12h8M8 16h8"/></svg></button><button class="cancel" hidden>Cancel</button><button class="export">Export ↗</button></div>'}</div>`;
  c.find = s => c.element.querySelector(s);
  if (type !== 'audio') c.find('.preview').style.aspectRatio = `${file.width} / ${file.height}`;
  if (!original) {
    c.element.querySelectorAll('[data-lock]').forEach(button => {
      button.onclick = () => { locks[button.dataset.lock] = !locks[button.dataset.lock]; syncSettings(c); schedule(0); };
    });
    c.find('.remove').onclick = () => removeCard(c);
    c.find('.paste-settings').disabled = !copiedSettings;
    if (copiedSettings) c.find('.paste-settings').title = 'Paste settings';
    c.find('.copy-settings').onclick = () => {
      copiedSettings = { ...c.settings };
      cards.filter(card => !card.original).forEach(card => {
        card.find('.paste-settings').disabled = false;
        card.find('.paste-settings').title = 'Paste settings';
        card.find('.copy-settings').title = card === c ? 'Settings copied' : 'Copy settings';
      });
    };
    c.find('.paste-settings').onclick = () => {
      if (!copiedSettings) return;
      c.settings = { ...copiedSettings };
      c.element.querySelectorAll('[data-key]').forEach(input => {
        input.value = input.dataset.key === 'bitrate' ? bitratePosition(c) : c.settings[input.dataset.key];
      });
      syncSettings(c); schedule(0);
    };
    c.find('.export').onclick = () => exportCard(c);
    c.find('.cancel').onclick = () => { if (c.job) api(`/api/jobs/${c.job}`, null, null, 'DELETE').catch(e => { c.find('.card-error').textContent = e.message; }); };
    c.element.querySelectorAll('[data-key]').forEach(input => {
      input.value = input.dataset.key === 'bitrate' ? bitratePosition(c) : c.settings[input.dataset.key];
      input.addEventListener('input', () => {
        const key = input.dataset.key;
        c.settings[key] = key === 'format' ? input.value : key === 'bitrate' ? bitrateValue(c, Number(input.value)) : Number(input.value);
        if (key === 'format' && type === 'audio') { c.settings.bitrate = rates(c).reduce((a, b) => Math.abs(b - c.settings.bitrate) < Math.abs(a - c.settings.bitrate) ? b : a); c.find('[data-key="bitrate"]').value = bitratePosition(c); }
        syncSettings(c); schedule();
      });
    });
  }
  if (type === 'audio') c.find('.listen').onclick = () => { audible = c; updateAudio(); if (!playing) { playing = true; startTogether(); } };
  cards.push(c); $('#cards').insertBefore(c.element, $('#add')); renumber(); updateLabels(c);
  if (original) audible = c;
  else syncSettings(cards.find(card => !card.original));
}
const rates = c => locks.bitrate ? [32, 48, 64, 96, 128, 160, 192, 256, 320] : c.settings.format === 'mp3' ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [16, 24, 32, 48, 64, 96, 128, 160, 192, 256, 320, 384, 512];
function bitratePosition(c) { return c.type === 'audio' ? rates(c).indexOf(c.settings.bitrate) / (rates(c).length - 1) * 1000 : Math.log(c.settings.bitrate / 100) / Math.log(1000) * 1000; }
function bitrateValue(c, position) { return c.type === 'audio' ? rates(c)[Math.round(position / 1000 * (rates(c).length - 1))] : Math.max(100, Math.round(100 * 1000 ** (position / 1000) / 100) * 100); }
function updateLabels(c) {
  if (c.original) return;
  if (c.type === 'image') c.find('.quality-output').textContent = c.settings.quality;
  else { c.find('.bitrate-output').textContent = `${c.settings.bitrate.toLocaleString()} kbps`; c.find('[data-key="bitrate"]').setAttribute('aria-valuetext', `${c.settings.bitrate} kbps`); }
  if (c.type !== 'audio') {
    const unit = c.type === 'video' ? 2 : 1;
    const minimum = c.settings.format === 'av1' ? 64 : c.settings.format === 'hevc' ? 16 : unit;
    const w = c.type === 'image' ? Math.max(1, Math.round(c.file.width * c.settings.resolution / 100)) : Math.max(Math.ceil(Math.max(minimum, minimum * c.file.width / c.file.height) / unit) * unit, Math.floor(c.file.width * c.settings.resolution / 100 / unit) * unit);
    const h = Math.max(unit, Math.round(c.file.height * w / c.file.width / unit) * unit);
    c.find('.resolution-output').textContent = `${w} × ${h}`;
  }
}
function renumber() {
  $('#cards').style.setProperty('--card-count', Math.max(1, cards.length));
  cards.filter(c => !c.original).forEach((c, i, list) => {
    c.find('.number').textContent = String(i + 1).padStart(2, '0');
    c.find('.remove').disabled = list.length === 1;
  });
}
function removeCard(c, refresh = true) {
  if (c.job) api(`/api/jobs/${c.job}`, null, null, 'DELETE').catch(() => {});
  c.media?.pause?.(); c.element.remove(); const i = cards.indexOf(c); if (i >= 0) cards.splice(i, 1);
  if (audible === c) audible = cards[0]; renumber(); if (refresh) schedule(0);
}
$('#add').onclick = () => { addCard({ ...cards.at(-1).settings }); schedule(0); };
function pausePlayers() { running = false; players().forEach(m => m.pause()); }
function updateTransport() {
  $('#play').textContent = loading ? 'Preparing…' : playing ? 'Ⅱ Pause' : '▶ Play';
  $('#play').disabled = loading;
  if (!scrubbing) $('#time').value = segmentStart + offset;
  $('#time-label').textContent = clock(Number($('#time').value));
}
function updateAudio() { cards.forEach(c => { if (c.media?.play) c.media.muted = c.type === 'video' || c !== audible; c.find('.listen')?.setAttribute('aria-pressed', String(c === audible)); }); }
async function startTogether() {
  if (loading || scrubbing || !playing) return;
  const generation = revision;
  const media = players(); if (!media.length) { playing = false; updateTransport(); return; }
  pausePlayers();
  if (offset >= clipLength() - .05) offset = 0;
  try {
    await Promise.all(media.map(m => seek(m, offset)));
    if (generation !== revision || loading || scrubbing || !playing) return;
    updateAudio();
    await Promise.all(media.map(m => m.play()));
    if (generation !== revision || loading || scrubbing || !playing) { media.forEach(m => m.pause()); return; }
    running = true;
  } catch { pausePlayers(); playing = false; $('#error').textContent = 'Playback unavailable. Press Space or Play to resume.'; }
  updateTransport();
}
function seek(media, time) {
  const target = Math.max(0, Math.min(time, Math.max(0, media.duration - .02)));
  if (Math.abs(media.currentTime - target) < .01 && !media.seeking) return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(done, 3000);
    function done() { clearTimeout(timeout); media.removeEventListener('seeked', done); resolve(); }
    media.addEventListener('seeked', done, { once: true }); media.currentTime = target;
  });
}
function togglePlayback() {
  if (!file || file.type === 'image') return;
  playing = !playing;
  if (playing) startTogether(); else pausePlayers();
  updateTransport(); saveState();
}
$('#play').onclick = togglePlayback;
for (const event of ['keydown', 'keyup']) window.addEventListener(event, e => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (event === 'keydown' && !e.repeat) togglePlayback();
}, { capture: true });
$('#duration').oninput = () => { $('#duration-label').textContent = `${duration()} s`; offset = Math.min(offset, duration() - .05); schedule(); };
$('#time').oninput = () => {
  scrubbing = true; pausePlayers(); const target = Number($('#time').value); $('#time-label').textContent = clock(target);
  if (!loading && target >= segmentStart && target < segmentStart + clipLength() - .05) { offset = target - segmentStart; players().forEach(m => { m.currentTime = offset; }); drawAll(); }
};
$('#time').onchange = () => {
  const target = Number($('#time').value); scrubbing = false;
  if (!loading && target >= segmentStart && target < segmentStart + clipLength() - .05) { offset = target - segmentStart; if (playing) startTogether(); updateTransport(); }
  else { segmentStart = target; offset = 0; schedule(0); }
};
function schedule(delay = 250) {
  saveState();
  clearTimeout(timer); controller?.abort(); revision++; pausePlayers(); loading = true; updateTransport();
  cards.forEach(c => { c.find('.status').textContent = 'Updating…'; });
  timer = setTimeout(() => refresh(revision), delay);
}
async function refresh(generation) {
  controller = new AbortController(); const signal = controller.signal;
  await Promise.all(cards.map(async c => {
    try { await preview(c, generation, signal); }
    catch (e) { if (generation === revision && e.name !== 'AbortError') { c.find('.status').textContent = 'Preview failed'; c.find('.card-error').textContent = e.message; c.media?.pause?.(); c.media?.remove(); c.media = null; } }
  }));
  if (generation !== revision) return;
  loading = false; drawAll(); updateAudio(); updateTransport();
  if (playing) await startTogether();
}
function ready(media, signal) {
  return new Promise((resolve, reject) => {
    const event = media.tagName === 'IMG' ? 'load' : 'canplay';
    const timeout = setTimeout(() => done(new Error('Preview load timed out')), 20000);
    function done(error) { clearTimeout(timeout); media.removeEventListener(event, success); media.removeEventListener('error', failure); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); }
    const success = () => done(), failure = () => done(new Error('Browser playback unavailable')), abort = () => done(new DOMException('Cancelled', 'AbortError'));
    media.addEventListener(event, success, { once: true }); media.addEventListener('error', failure, { once: true }); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else if (media.tagName === 'IMG' ? media.complete && media.naturalWidth : media.readyState >= 3) success();
  });
}
async function cachedPreview(c, signal) {
  const body = { id: c.file.id, ...c.settings, time: segmentStart, seconds: duration() };
  const key = JSON.stringify(body);
  if (previewCache.has(key)) return previewCache.get(key);
  const pending = pendingPreviews.get(key);
  if (pending && !pending.signal.aborted) return pending.promise;
  const entry = { signal };
  entry.promise = api('/api/preview', body, signal).then(result => {
    if (!signal.aborted) previewCache.set(key, result);
    return result;
  }).finally(() => {
    if (pendingPreviews.get(key) === entry) pendingPreviews.delete(key);
  });
  pendingPreviews.set(key, entry);
  return entry.promise;
}
async function preview(c, generation, signal) {
  c.find('.card-error').textContent = '';
  const result = await cachedPreview(c, signal);
  if (generation !== revision) return;
  c.result = result; c.media?.pause?.(); c.media?.remove(); c.find('.wave')?.remove();
  const media = document.createElement(c.type === 'image' ? 'img' : c.type === 'video' ? 'video' : 'audio'); c.media = media;
  if (c.type === 'image') media.alt = c.original ? 'Original' : `${c.settings.format} preview`;
  else { media.controls = false; media.loop = false; media.playsInline = true; media.muted = true; media.preload = 'auto'; media.onseeked = () => draw(c); }
  if (result.poster) media.poster = result.poster;
  c.find('.preview').prepend(media); const loaded = ready(media, signal); media.src = result.url;
  try { await loaded; }
  catch (e) {
    if (!result.poster || signal.aborted) throw e;
    try {
      const proxy = await api('/api/playback', { url: result.url }, signal);
      const proxyLoaded = ready(media, signal); media.src = proxy.url; await proxyLoaded;
    } catch (proxyError) {
      if (signal.aborted) throw proxyError;
      const still = new Image(); still.alt = 'Encoded still preview'; media.remove(); c.media = still; c.find('.preview').prepend(still);
      const loadedStill = ready(still, signal); still.src = result.poster; await loadedStill;
      c.find('.status').textContent = 'Still preview';
    }
  }
  if (generation !== revision) return;
  if (c.media === media) c.find('.status').textContent = '';
  const size = c.find('.size');
  if (c.original) { size.textContent = bytes(c.file.size); size.title = 'Original file size'; }
  else if (c.type === 'image' || result.seconds >= c.file.duration) { size.textContent = bytes(result.size); size.title = 'Encoded file size'; }
  else { size.textContent = `~${bytes(result.size / result.seconds * c.file.duration)}`; size.title = 'Estimated full file size. Export measures the final size.'; }
  if (c.type === 'audio') {
    const wave = document.createElement('canvas'); wave.className = 'wave'; c.find('.preview').prepend(wave);
    const response = await fetch(result.url, { signal }); const context = new AudioContext();
    try { const buffer = await context.decodeAudioData(await response.arrayBuffer()); if (generation === revision) c.samples = buffer.getChannelData(0); }
    finally { await context.close(); }
  }
  if (c.media.play) await seek(c.media, offset); draw(c);
}
function canvasSize(canvas) {
  const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return [w, h];
}
function waveform(canvas, samples) {
  if (!canvas || !samples) return;
  const [w, h] = canvasSize(canvas), ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#b8e88a'; ctx.lineWidth = Math.max(1, devicePixelRatio); ctx.beginPath();
  for (let x = 0; x < w; x += 3) { const from = Math.floor(x / w * samples.length), to = Math.min(samples.length, Math.ceil(from + 3 / w * samples.length)); let lo = 0, hi = 0; for (let i = from; i < to; i++) { lo = Math.min(lo, samples[i]); hi = Math.max(hi, samples[i]); } ctx.moveTo(x, h / 2 + lo * h * .42); ctx.lineTo(x, h / 2 + hi * h * .42 + 1); } ctx.stroke();
  ctx.fillStyle = '#ffffff88'; ctx.fillRect(offset / clipLength() * w, 0, 1, h);
}
function draw(c) {
  const canvas = c.find('.detail canvas');
  if (c.type === 'audio') { waveform(c.find('.wave'), c.samples); waveform(canvas, c.samples); return; }
  const media = c.media; if (!media) return;
  const sw = media.videoWidth || media.naturalWidth, sh = media.videoHeight || media.naturalHeight; if (!sw || !sh || (media.tagName === 'VIDEO' && media.readyState < 2)) return;
  const [w, h] = canvasSize(canvas), ctx = canvas.getContext('2d'), dpr = devicePixelRatio || 1;
  // One original pixel per CSS pixel, with the same centered source region in every card.
  const originalW = Math.min(c.file.width, w / dpr), originalH = Math.min(c.file.height, h / dpr);
  const cw = originalW * sw / c.file.width, ch = originalH * sh / c.file.height;
  const dw = originalW * dpr, dh = originalH * dpr;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.clearRect(0, 0, w, h); ctx.drawImage(media, (sw - cw) / 2, (sh - ch) / 2, cw, ch, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
function drawAll() { cards.forEach(draw); }
window.addEventListener('resize', drawAll);
let restarting = false;
function animate() {
  if (running && !loading && !scrubbing) {
    const media = players(), master = media[0];
    if (master) {
      offset = master.currentTime;
      if ((offset >= clipLength() - .04 || master.ended || media.some(m => m.ended)) && !restarting) {
        restarting = true; pausePlayers(); offset = 0; startTogether().finally(() => { restarting = false; });
      } else {
        for (const m of media.slice(1)) if (!m.seeking && Math.abs(m.currentTime - offset) > .08) m.currentTime = Math.min(offset, m.duration - .02);
      }
      updateTransport(); drawAll();
    }
  }
  requestAnimationFrame(animate);
} animate();
async function exportCard(c) {
  if (c.job) return;
  const button = c.find('.export'); button.disabled = true; button.textContent = 'Starting…'; c.find('.card-error').textContent = '';
  try {
    const job = await api('/api/export', { id: c.file.id, ...c.settings }); c.job = job.id;
    if (!cards.includes(c)) { await api(`/api/jobs/${job.id}`, null, null, 'DELETE'); return; }
    c.find('.cancel').hidden = false;
    while (cards.includes(c)) {
      const state = await api(`/api/jobs/${job.id}`, null, null, 'GET');
      if (state.status === 'error') throw new Error(state.error);
      if (state.status === 'done') {
        const a = document.createElement('a'); a.href = state.result.url; a.download = state.result.filename; document.body.append(a); a.click(); a.remove();
        c.find('.size').textContent = bytes(state.result.size); break;
      }
      button.textContent = `${Math.round(state.progress)}%`;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  } catch (e) { c.find('.card-error').textContent = e.message; }
  finally { c.job = null; button.disabled = false; button.textContent = 'Export ↗'; c.find('.cancel').hidden = true; }
}

restoreState();
