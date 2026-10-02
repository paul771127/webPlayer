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
const hooks = { onPlay: () => {} };   // browse.js 會接上：顯示「正在播放」資訊

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, playsinline: 1, cc_load_policy: 0 },
    events: {
      onReady: () => {
        ready = true;
        if (pending) { play(pending.id, pending.meta); return; }
        // 開啟頁面時：帶出上次的影片，停在上次的位置（手機需點一下才會出聲播放）
        const last = Resume.lastId();
        if (last) { player.cueVideoById({ videoId: last, startSeconds: Resume.startFor(last) }); hooks.onPlay(last); }
      },
      onStateChange: e => {
        // 換影片後 YouTube 會把速度重設回 1×，這裡補回使用者設定
        if (e.data === YT.PlayerState.PLAYING && player.getPlaybackRate() !== rate) player.setPlaybackRate(rate);
        if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) Resume.save();
      },
      onError: e => msg('無法播放（錯誤碼 ' + e.data + '）：影片可能不允許嵌入。')
    }
  });
};
document.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
});

function play(id, meta) {
  if (!ready) { pending = { id, meta }; return; }
  Resume.save();                       // 先存下前一部的進度
  msg('');
  player.loadVideoById({ videoId: id, startSeconds: Resume.startFor(id) });
  hooks.onPlay(id, meta);
}

/* ========== 播放進度記憶（可開關，開關在「設定」） ========== */
const Resume = (() => {
  const KEY = 'progress', MAX = 50;
  let on = store.get('resumeOn', true);
  const all = () => store.get(KEY, { last: null, items: {} });
  const curId = () => { try { return player.getVideoData().video_id || null; } catch (e) { return null; } };

  function save() {
    if (!on || !ready) return;
    const id = curId(); if (!id) return;
    const t = player.getCurrentTime(), dur = player.getDuration();
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
    lastId: () => on ? all().last : null,
    save
  };
})();

$('resume').checked = Resume.on;
$('resume').onchange = e => Resume.set(e.target.checked);
setInterval(() => { if (ready && player.getPlayerState() === YT.PlayerState.PLAYING) Resume.save(); }, 3000);
window.addEventListener('pagehide', Resume.save);
document.addEventListener('visibilitychange', () => { if (document.hidden) Resume.save(); });

/* ========== 動作 ========== */
// 連續快速滑動時合併成一次跳轉，減少 YouTube 重複緩衝
let seekTarget = null, seekAt = 0;
function seek(delta) {
  if (!ready) return;
  const now = Date.now();
  const base = (seekTarget !== null && now - seekAt < CFG.mergeMs) ? seekTarget : player.getCurrentTime();
  const dur = player.getDuration() || Infinity;
  seekTarget = Math.min(Math.max(base + delta, 0), dur - 0.5);
  seekAt = now;
  player.seekTo(seekTarget, true);
}
function setVol(v) {
  if (!ready) return;
  v = Math.round(Math.min(Math.max(v, 0), 100));
  if (player.isMuted() && v > 0) player.unMute();
  player.setVolume(v);
}
function togglePlay() {
  if (!ready) return;
  player.getPlayerState() === YT.PlayerState.PLAYING ? player.pauseVideo() : player.playVideo();
}

/* ========== 控制列：秒數、速度 ========== */
function renderStep() { $('stepVal').textContent = STEPS[stepIdx] + ' 秒'; store.set('step', STEPS[stepIdx]); }
$('stepDown').onclick = () => { if (stepIdx > 0) { stepIdx--; renderStep(); } };
$('stepUp').onclick = () => { if (stepIdx < STEPS.length - 1) { stepIdx++; renderStep(); } };
renderStep();

$('rate').value = String(rate);
$('rate').onchange = e => {
  rate = parseFloat(e.target.value); store.set('rate', rate);
  if (ready) player.setPlaybackRate(rate);
};

/* ========== 進度條 + 全螢幕細進度線 ========== */
const bar = $('seek'), thin = $('thin').firstElementChild;
let dragging = false;
function paintBar(t, dur) {
  const pct = dur ? (t / dur) * 100 : 0;
  bar.style.setProperty('--played', pct + '%');
  const buf = ready ? (player.getVideoLoadedFraction() || 0) * 100 : 0;
  bar.style.setProperty('--buffered', Math.max(buf, pct) + '%');
  thin.style.width = pct + '%';
}
function tick() {
  if (!ready || dragging) return;
  const dur = player.getDuration() || 0, t = player.getCurrentTime() || 0;
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
  if (ready) { player.seekTo(+bar.value, true); seekTarget = null; }
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
  g = { x0: e.clientX, y0: e.clientY, axis: null, held: false, vol0: ready ? player.getVolume() : 100 };
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
    ArrowUp: () => setVol(player.getVolume() + 10), ArrowDown: () => setVol(player.getVolume() - 10),
    ' ': togglePlay, f: toggleFs
  };
  if (map[e.key] && ready) { e.preventDefault(); map[e.key](); }
});

/* ========== 對外介面 ========== */
window.App = {
  play, parseId, hooks, store, msg, fmt,
  get player() { return player; },
  get ready() { return ready; }
};
