/* webPlayer — 播放器核心：播放、手勢、控制列、進度條、全螢幕、續播
   對外提供 window.App 給 browse.js 使用 */
'use strict';

/* ========== 共用 ========== */
const STEPS = [1, 2, 3, 5, 10, 15, 20, 30, 60];
const CFG = { swipeMin: 40, volPerPx: 0.25, tapMaxMove: 10, doubleTapMs: 300, mergeMs: 600, holdMs: 700 };

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const msg = t => { $('msg').textContent = t || ''; };
const fmt = s => {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};

let stepIdx = STEPS.indexOf(store.get('step', 5)); if (stepIdx < 0) stepIdx = 3;
let rate = store.get('rate', 1);

/* 只有像影片網址或影片 ID 的字串才直接播放，其他都當關鍵字搜尋 */
function parseId(input) {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s) && /[\d_-]/.test(s) && /[a-z]/i.test(s)) return s;
  if (!/youtu/i.test(s)) return null;
  try {
    const u = new URL(s.startsWith('http') ? s : 'https://' + s);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1, 12) || null;
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
    if (m) return m[2];
  } catch (e) {}
  return null;
}

/* ========== YouTube 播放器 ========== */
let player = null, ready = false, pending = null;
const hooks = { onPlay: () => {}, onEnded: () => false };  // browse.js / series.js / local.js 會接上；onEnded 回傳 true 表示已處理

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, playsinline: 1, cc_load_policy: 0 },
    events: {
      onReady: () => {
        ready = true;
        if (pending) { play(pending.id, pending.meta); return; }
        // 開啟頁面時：帶出上次的影片，停在上次的位置（手機需點一下才會出聲播放）
        const last = Resume.lastId();
        if (last && !last.startsWith('local:')) { player.cueVideoById({ videoId: last, startSeconds: Resume.startFor(last) }); hooks.onPlay(last); }
      },
      onStateChange: e => {
        if (mode !== 'yt') return;
        // 換影片後 YouTube 會把速度重設回 1×，這裡補回使用者設定
        if (e.data === YT.PlayerState.PLAYING && player.getPlaybackRate() !== rate) player.setPlaybackRate(rate);
        if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) Resume.save();
        if (e.data === YT.PlayerState.ENDED) ended();
      },
      onError: e => msg('無法播放（錯誤碼 ' + e.data + '）：影片可能不允許嵌入。')
    }
  });
};
document.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
});

/* ========== 播放引擎：YouTube 與本機影片共用同一組操作 ========== */
const video = $('local'), audio = $('localAudio');
let media = video;                       // 本機播放用的元素：一般是 <video>，背景播放時改用 <audio>
let pendingSeek = 0;
let mode = 'yt', localKey = null, localUrl = null;
const YTE = {
  ok: () => ready,
  id: () => { try { return player.getVideoData().video_id || null; } catch (e) { return null; } },
  time: () => player.getCurrentTime() || 0,
  dur: () => player.getDuration() || 0,
  seek: t => player.seekTo(t, true),
  playing: () => player.getPlayerState() === YT.PlayerState.PLAYING,
  toggle: () => (YTE.playing() ? player.pauseVideo() : player.playVideo()),
  play: () => player.playVideo(),
  vol: () => player.getVolume(),
  setVol: v => { if (player.isMuted() && v > 0) player.unMute(); player.setVolume(v); },
  rate: r => player.setPlaybackRate(r),
  buffered: () => player.getVideoLoadedFraction() || 0
};
const LOC = {
  ok: () => !!localKey,
  id: () => localKey,
  time: () => media.currentTime || 0,
  dur: () => (isFinite(media.duration) ? media.duration : 0),
  seek: t => { media.currentTime = t; },
  playing: () => !media.paused && !media.ended,
  toggle: () => (media.paused ? media.play().catch(() => {}) : media.pause()),
  play: () => media.play().catch(() => {}),
  vol: () => Math.round(media.volume * 100),
  setVol: v => { media.muted = false; media.volume = v / 100; },
  rate: r => { media.playbackRate = r; },
  buffered: () => {
    const d = LOC.dur(), b = media.buffered;
    return d && b.length ? b.end(b.length - 1) / d : 0;
  }
};
const E = () => (mode === 'local' ? LOC : YTE);
function setMode(m) {
  if (m === mode) return;
  if (m === 'local' && ready) player.pauseVideo();
  if (m === 'yt') { video.pause(); audio.pause(); }
  mode = m; document.body.dataset.mode = m;
}
document.body.dataset.mode = 'yt';

// 本機影片
[video, audio].forEach(el => {
  el.addEventListener('loadedmetadata', () => {
    if (el !== media) return;
    if (pendingSeek) el.currentTime = pendingSeek;
    pendingSeek = 0;
    el.playbackRate = rate;
  });
  el.addEventListener('pause', () => { if (el === media) Resume.save(); });
  el.addEventListener('ended', () => { if (el === media) { Resume.save(); ended(); } });
  el.addEventListener('error', () => {
    if (el === media && mode === 'local' && localKey) msg('手機無法播放這個檔案的格式（常見於 MKV、AVI、WMV），請換 MP4 檔。');
  });
});

/* ========== 背景播放（本機影片）：改用 <audio> 只播聲音，關螢幕也會繼續 ========== */
let bgOn = store.get('bgPlay', false);
function renderBg() {
  $('bgBtn').classList.toggle('on', bgOn);
  $('bgBtn').textContent = bgOn ? '背景播放：開' : '背景播放：關';
  document.body.dataset.bg = bgOn ? 'on' : 'off';
}
$('bgBtn').onclick = () => {
  bgOn = !bgOn; store.set('bgPlay', bgOn); renderBg();
  const next = bgOn ? audio : video;
  if (next === media) return;
  const was = media, t = was.currentTime, playing = !was.paused;
  media = next;
  if (localUrl) {                           // 正在播本機影片：無縫換到另一個元素
    pendingSeek = t;
    was.pause();
    media.src = localUrl;
    if (playing) media.play().catch(() => {});
  }
  msg(bgOn ? '背景播放：本機影片只播聲音，可以關螢幕或切到其他 App。' : '');
};
renderBg();
media = bgOn ? audio : video;
/* ========== 播放模式：依序／隨機 × 不循環／全部循環／單曲循環 ========== */
const PlayMode = { shuffle: store.get('pmShuffle', false), repeat: store.get('pmRepeat', 'off') };
const modeListeners = [];
const REPEAT_TEXT = { off: '不循環', all: '全部循環', one: '單曲循環' };
function renderMode() {
  $('pmShuffle').textContent = PlayMode.shuffle ? '隨機播放' : '依序播放';
  $('pmShuffle').classList.toggle('on', PlayMode.shuffle);
  $('pmRepeat').textContent = REPEAT_TEXT[PlayMode.repeat];
  $('pmRepeat').classList.toggle('on', PlayMode.repeat !== 'off');
}
function setPlayMode(k, v) {
  PlayMode[k] = v;
  store.set(k === 'shuffle' ? 'pmShuffle' : 'pmRepeat', v);
  renderMode();
  modeListeners.forEach(f => f());
}
$('pmShuffle').onclick = () => setPlayMode('shuffle', !PlayMode.shuffle);
$('pmRepeat').onclick = () => setPlayMode('repeat', { off: 'all', all: 'one', one: 'off' }[PlayMode.repeat]);
renderMode();

// 播完：先交給清單處理（劇集、播放清單、本機），沒有清單時單支影片也能循環
function ended() {
  if (hooks.onEnded()) return;
  if (PlayMode.repeat !== 'off') { E().seek(0); E().play(); }
}

/* 播放佇列：清單模組共用。keys 是已勾選、依顯示順序排列的項目 */
class PlayQueue {
  constructor(keys, cur) { this.keys = keys.slice(); this.rebuild(cur); }
  rebuild(cur) {
    this.cur = cur;
    if (PlayMode.shuffle) {
      const rest = this.keys.filter(k => k !== cur);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.order = this.keys.includes(cur) ? [cur, ...rest] : rest;
    } else this.order = this.keys.slice();
    this.pos = Math.max(0, this.order.indexOf(cur));
  }
  setKeys(keys) { this.keys = keys.slice(); this.rebuild(this.cur); }
  at(key) {                                  // 播到某一項時更新位置；不在清單內回傳 false
    const i = this.order.indexOf(key);
    if (i < 0) return false;
    this.pos = i; this.cur = key; return true;
  }
  next(auto) {
    if (!this.order.length) return null;
    if (auto && PlayMode.repeat === 'one') return this.cur;
    if (this.pos < this.order.length - 1) return this.order[this.pos + 1];
    if (PlayMode.repeat !== 'all') return null;
    if (PlayMode.shuffle) this.rebuild(null);  // 全部循環 + 隨機：每輪重新洗牌
    return this.order[0];
  }
  prev() {
    if (this.pos > 0) return this.order[this.pos - 1];
    return PlayMode.repeat === 'all' ? this.order[this.order.length - 1] : null;
  }
  hasNext() { return this.pos < this.order.length - 1 || PlayMode.repeat === 'all'; }
  hasPrev() { return this.pos > 0 || PlayMode.repeat === 'all'; }
}

function playLocal(file, key, meta) {
  Resume.save();                       // 先存下前一部的進度
  setMode('local');
  msg('');
  if (localUrl) URL.revokeObjectURL(localUrl);
  localUrl = URL.createObjectURL(file);
  localKey = key;
  pendingSeek = Resume.startFor(key);
  media.src = localUrl;
  media.play().catch(() => msg('點一下影片開始播放。'));
  hooks.onPlay(key, meta);
  if ('mediaSession' in navigator && window.MediaMetadata) {   // 鎖定畫面顯示的標題
    navigator.mediaSession.metadata = new MediaMetadata({ title: (meta && meta.title) || '本機影片', artist: 'webPlayer' });
  }
}

function play(id, meta) {
  if (!ready) { pending = { id, meta }; return; }
  Resume.save();                       // 先存下前一部的進度
  setMode('yt');
  msg('');
  player.loadVideoById({ videoId: id, startSeconds: Resume.startFor(id) });
  hooks.onPlay(id, meta);
}

/* ========== 播放進度記憶（可開關，開關在「設定」） ========== */
const Resume = (() => {
  const KEY = 'progress', MAX = 50;
  let on = store.get('resumeOn', true);
  const all = () => store.get(KEY, { last: null, items: {} });

  function save() {
    const e = E();
    if (!on || !e.ok()) return;
    const id = e.id(); if (!id) return;
    const t = e.time(), dur = e.dur();
    const d = all();
    if (dur && t > dur - 10) delete d.items[id];           // 看完了就不再續播
    else if (t > 3) d.items[id] = { t: Math.floor(t), at: Date.now() };
    d.last = id;
    Object.keys(d.items).sort((a, b) => d.items[b].at - d.items[a].at)
      .slice(MAX).forEach(k => delete d.items[k]);         // 只保留最近 50 部
    store.set(KEY, d);
  }
  return {
    get on() { return on; },
    set(v) { on = v; store.set('resumeOn', v); if (v) save(); },
    startFor: id => (on && all().items[id]) ? all().items[id].t : 0,
    progress: id => (all().items[id] || {}).t || 0,
    lastId: () => on ? all().last : null,
    save
  };
})();

$('resume').checked = Resume.on;
$('resume').onchange = e => Resume.set(e.target.checked);
setInterval(() => { if (E().ok() && E().playing()) Resume.save(); }, 3000);
window.addEventListener('pagehide', Resume.save);
document.addEventListener('visibilitychange', () => { if (document.hidden) Resume.save(); });

/* ========== 動作 ========== */
// 連續快速滑動時合併成一次跳轉，減少 YouTube 重複緩衝
let seekTarget = null, seekAt = 0;
function seek(delta) {
  const e = E(); if (!e.ok()) return;
  const now = Date.now();
  const base = (seekTarget !== null && now - seekAt < CFG.mergeMs) ? seekTarget : e.time();
  const dur = e.dur() || Infinity;
  seekTarget = Math.min(Math.max(base + delta, 0), dur - 0.5);
  seekAt = now;
  e.seek(seekTarget);
}
function setVol(v) {
  if (!E().ok()) return;
  E().setVol(Math.round(Math.min(Math.max(v, 0), 100)));
}
function togglePlay() { if (E().ok()) E().toggle(); }

/* ========== 控制列：秒數、速度 ========== */
function renderStep() { $('stepVal').textContent = STEPS[stepIdx] + ' 秒'; store.set('step', STEPS[stepIdx]); }
$('stepDown').onclick = () => { if (stepIdx > 0) { stepIdx--; renderStep(); } };
$('stepUp').onclick = () => { if (stepIdx < STEPS.length - 1) { stepIdx++; renderStep(); } };
renderStep();

$('rate').value = String(rate);
$('rate').onchange = e => {
  rate = parseFloat(e.target.value); store.set('rate', rate);
  if (E().ok()) E().rate(rate);
};

/* ========== 進度條 + 全螢幕細進度線 ========== */
const bar = $('seek'), thin = $('thin').firstElementChild;
let dragging = false;
function paintBar(t, dur) {
  const pct = dur ? (t / dur) * 100 : 0;
  bar.style.setProperty('--played', pct + '%');
  const buf = E().ok() ? E().buffered() * 100 : 0;
  bar.style.setProperty('--buffered', Math.max(buf, pct) + '%');
  thin.style.width = pct + '%';
}
function tick() {
  const e = E();
  if (!e.ok() || dragging) return;
  const dur = e.dur(), t = e.time();
  if (+bar.max !== dur) { bar.max = dur; $('tDur').textContent = fmt(dur); }
  bar.value = t; $('tCur').textContent = fmt(t);
  paintBar(t, dur);
}
setInterval(tick, 250);
bar.addEventListener('input', () => {             // 拖曳中：只更新顯示
  dragging = true;
  $('tCur').textContent = fmt(+bar.value);
  paintBar(+bar.value, +bar.max);
});
bar.addEventListener('change', () => {            // 放開：跳到該位置
  if (E().ok()) { E().seek(+bar.value); seekTarget = null; }
  dragging = false;
});

/* ========== 全螢幕 ========== */
// 有原生全螢幕就用（Android / 桌機），沒有（iPhone）就用網頁內全螢幕
const isFs = () => document.body.classList.contains('fs');
async function enterFs() {
  document.body.classList.add('fs');
  fitViewport();
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch (e) {}
}
async function exitFs() {
  document.body.classList.remove('fs');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
  } catch (e) {}
  onRotate();
}
const toggleFs = () => (isFs() ? exitFs() : enterFs());
$('fsBtn').onclick = toggleFs;
// 用系統返回鍵 / Esc 離開原生全螢幕時，同步回視窗模式
['fullscreenchange', 'webkitfullscreenchange'].forEach(ev =>
  document.addEventListener(ev, () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) document.body.classList.remove('fs');
  }));

/* 旋轉時：瀏覽器常沿用直向的尺寸或自動放大，這裡強制重新量測並還原縮放 */
const vpMeta = document.querySelector('meta[name=viewport]');
function fitViewport() {
  const vv = window.visualViewport;
  const r = document.documentElement.style;
  r.setProperty('--appW', Math.round(vv ? vv.width : window.innerWidth) + 'px');
  r.setProperty('--appH', Math.round(vv ? vv.height : window.innerHeight) + 'px');
  window.scrollTo(0, 0);
}
function onRotate() {
  const c = vpMeta.content;                       // 重設 viewport 讓 iOS 取消旋轉時的自動放大
  vpMeta.content = c + ', width=device-width';
  vpMeta.content = c;
  [0, 150, 400, 800].forEach(ms => setTimeout(fitViewport, ms)); // 部分手機旋轉後尺寸會晚一點才更新
}
window.addEventListener('orientationchange', onRotate);
window.addEventListener('resize', fitViewport);
if (window.visualViewport) visualViewport.addEventListener('resize', fitViewport);
if (screen.orientation) screen.orientation.addEventListener('change', onRotate);
fitViewport();

/* ========== 手勢 ========== */
const pad = $('touch');
let g = null, lastTap = 0, tapTimer = null, holdTimer = null;

pad.addEventListener('pointerdown', e => {
  pad.setPointerCapture(e.pointerId);
  g = { x0: e.clientX, y0: e.clientY, axis: null, held: false, vol0: E().ok() ? E().vol() : 100 };
  // 全螢幕時長按：退回視窗模式（備用方式）
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { if (g && !g.axis && isFs()) { g.held = true; exitFs(); } }, CFG.holdMs);
});
pad.addEventListener('pointermove', e => {
  if (!g) return;
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  if (!g.axis && Math.hypot(dx, dy) > CFG.tapMaxMove) { g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; clearTimeout(holdTimer); }
  if (g.axis === 'y') setVol(g.vol0 - dy * CFG.volPerPx);
});
pad.addEventListener('pointerup', e => {
  clearTimeout(holdTimer);
  if (!g) return;
  if (g.held) { g = null; return; }
  const dx = e.clientX - g.x0;
  if (g.axis === 'x' && Math.abs(dx) >= CFG.swipeMin) {
    seek(dx > 0 ? STEPS[stepIdx] : -STEPS[stepIdx]);
  } else if (!g.axis) {
    const now = Date.now();
    if (now - lastTap < CFG.doubleTapMs) { clearTimeout(tapTimer); lastTap = 0; toggleFs(); } // 雙擊：切換全螢幕
    else { lastTap = now; tapTimer = setTimeout(togglePlay, CFG.doubleTapMs); }             // 單擊：播放／暫停
  }
  g = null;
});
pad.addEventListener('pointercancel', () => { clearTimeout(holdTimer); g = null; });

/* 桌機鍵盤 */
document.addEventListener('keydown', e => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const map = {
    ArrowRight: () => seek(STEPS[stepIdx]), ArrowLeft: () => seek(-STEPS[stepIdx]),
    ArrowUp: () => setVol(E().vol() + 10), ArrowDown: () => setVol(E().vol() - 10),
    ' ': togglePlay, f: toggleFs
  };
  if (map[e.key] && E().ok()) { e.preventDefault(); map[e.key](); }
});

/* ========== 鎖定畫面／耳機的控制鍵（本機影片） ========== */
function clickStep(d) {
  const b = document.querySelector(`#now [data-ep-step="${d}"], #now [data-lc-step="${d}"]`);
  if (b && !b.disabled) b.click();
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const on = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) {} };
  on('play', () => E().play());
  on('pause', () => { if (E().playing()) E().toggle(); });
  on('seekbackward', () => seek(-STEPS[stepIdx]));
  on('seekforward', () => seek(STEPS[stepIdx]));
  on('seekto', d => { if (E().ok()) E().seek(d.seekTime); });
  on('previoustrack', () => clickStep(-1));
  on('nexttrack', () => clickStep(1));
  setInterval(() => {
    if (mode !== 'local' || !LOC.ok() || !LOC.dur()) return;
    try { ms.setPositionState({ duration: LOC.dur(), position: Math.min(LOC.time(), LOC.dur()), playbackRate: rate }); } catch (e) {}
  }, 1000);
}

/* ========== 對外介面 ========== */
window.App = {
  play, playLocal, parseId, hooks, store, msg, fmt, Resume, PlayMode, PlayQueue,
  onModeChange: f => modeListeners.push(f),
  get mode() { return mode; },
  get player() { return player; },
  get ready() { return ready; }
};
