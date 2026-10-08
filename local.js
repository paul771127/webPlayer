/* webPlayer — 本機影片：選檔或選資料夾、篩選、排序、縮圖、連續播放
   檔案只在這次開啟期間可用（瀏覽器安全限制），每個檔案的觀看進度會記住 */
'use strict';
(() => {
const { store, fmt, Resume } = App;
const { esc, statusHTML } = Browse;
const $ = id => document.getElementById(id);

/* ========== 檔案清單 ========== */
const files = [];          // { idx, key, file, name, folder, ext, size, mod, dur, thumb, bad }
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|ts|mpe?g|wmv|flv|ogv)$/i;
const MAIN_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];
const keyOf = f => 'local:' + f.name + '|' + f.size + '|' + f.lastModified;

function add(list) {
  const seen = new Set(files.map(f => f.key));
  let n = 0;
  for (const f of list) {
    if (!(f.type.startsWith('video/') || VIDEO_EXT.test(f.name))) continue;
    const key = keyOf(f);
    if (seen.has(key)) continue;
    seen.add(key); n++;
    const m = f.name.match(/\.([^.]+)$/);
    files.push({
      idx: files.length, key, file: f, name: f.name,
      folder: (f.webkitRelativePath || '').split('/').slice(0, -1).join('/'),
      ext: m ? m[1].toLowerCase() : '', size: f.size, mod: f.lastModified,
      dur: null, thumb: '', bad: false
    });
  }
  if (!n && list.length) App.msg('選到的檔案裡沒有影片。');
  render(); probeAll();
}

/* ========== 讀取長度與縮圖（一次一個，不卡畫面） ========== */
let probing = false;
async function probeAll() {
  if (probing) return;
  probing = true;
  for (const f of files) if (f.dur === null) { await probe(f); renderSoon(); }
  probing = false;
}
function probe(f) {
  return new Promise(done => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(f.file);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (f.dur === null) f.dur = 0;
      v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); done();
    };
    const timer = setTimeout(finish, 8000);
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    v.onerror = () => { f.bad = true; finish(); };
    v.onloadedmetadata = () => {
      f.dur = isFinite(v.duration) ? v.duration : 0;
      if (!v.videoWidth) { finish(); return; }
      v.currentTime = Math.min(5, f.dur * 0.1);
    };
    v.onseeked = () => {
      try {
        const c = document.createElement('canvas'); c.width = 160; c.height = 90;
        const g = c.getContext('2d'), r = Math.min(160 / v.videoWidth, 90 / v.videoHeight);
        const w = v.videoWidth * r, h = v.videoHeight * r;
        g.fillStyle = '#000'; g.fillRect(0, 0, 160, 90);
        g.drawImage(v, (160 - w) / 2, (90 - h) / 2, w, h);
        f.thumb = c.toDataURL('image/jpeg', 0.7);
      } catch (e) {}
      finish();
    };
    v.src = url;
  });
}

/* ========== 篩選與排序 ========== */
const FIELDS = ['lcType', 'lcLen', 'lcSort'];
const saved = store.get('lcFilters', {});
FIELDS.forEach(k => { if (saved[k]) $(k).value = saved[k]; });
FIELDS.forEach(k => $(k).addEventListener('change', () => {
  store.set('lcFilters', Object.fromEntries(FIELDS.map(x => [x, $(x).value])));
  render();
}));
$('lcKw').addEventListener('input', renderSoon);

const coll = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });   // 「第2集」排在「第10集」前面
const full = f => (f.folder ? f.folder + '/' : '') + f.name;
const SORTS = {
  nameAsc: (a, b) => coll.compare(full(a), full(b)),
  nameDesc: (a, b) => coll.compare(full(b), full(a)),
  new: (a, b) => b.mod - a.mod,
  old: (a, b) => a.mod - b.mod,
  big: (a, b) => b.size - a.size,
  small: (a, b) => a.size - b.size,
  long: (a, b) => (b.dur || 0) - (a.dur || 0),
  short: (a, b) => (a.dur || 0) - (b.dur || 0)
};
function view() {
  const kw = $('lcKw').value.trim().toLowerCase();
  const type = $('lcType').value, len = $('lcLen').value;
  return files.filter(f => {
    if (kw && !full(f).toLowerCase().includes(kw)) return false;
    if (type === 'mp4' && !['mp4', 'm4v'].includes(f.ext)) return false;
    if (['mov', 'webm', 'mkv'].includes(type) && f.ext !== type) return false;
    if (type === 'other' && MAIN_EXT.includes(f.ext)) return false;
    if (len !== 'any') {
      if (!f.dur) return false;
      if (len === 'short' && f.dur >= 240) return false;
      if (len === 'medium' && (f.dur < 240 || f.dur > 1200)) return false;
      if (len === 'long' && f.dur <= 1200) return false;
    }
    return true;
  }).sort(SORTS[$('lcSort').value] || SORTS.nameAsc);
}

/* ========== 畫面 ========== */
const size = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const day = t => { const d = new Date(t); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
let nowKey = null, q = null;       // q：本機的播放佇列（依勾選、排序、播放模式）
const offKeys = new Set(store.get('lcOff', []));   // 沒勾選、不要播的檔案
const saveOff = () => store.set('lcOff', [...offKeys].slice(-500));
const byKey = k => files.find(f => f.key === k);
const checkedKeys = () => view().filter(f => !offKeys.has(f.key)).map(f => f.key);

function item(f) {
  const p = f.dur ? Math.min(100, Resume.progress(f.key) / f.dur * 100) : 0;
  const off = offKeys.has(f.key);
  return `<div class="lcRow${off ? ' off' : ''}">
  <input type="checkbox" data-lc-chk="${f.idx}" ${off ? '' : 'checked'} aria-label="播放這個檔案">
  <button type="button" class="vid${f.key === nowKey ? ' playing' : ''}" data-lc="${f.idx}">
    <span class="thumb">${f.thumb ? `<img src="${f.thumb}" alt="">` : `<span class="ph">${esc(f.ext.toUpperCase() || '影片')}</span>`}
      ${f.dur ? `<span class="dur">${fmt(f.dur)}</span>` : ''}
      ${p > 1 ? `<span class="pbar"><i style="width:${p.toFixed(1)}%"></i></span>` : ''}</span>
    <span class="info"><span class="title">${esc(f.name)}</span>
      <span class="meta">${f.folder ? esc(f.folder) + '<br>' : ''}${size(f.size)} · ${day(f.mod)}${f.bad ? ' · <span class="warn">可能無法播放</span>' : ''}</span></span>
  </button></div>`;
}
function render() {
  const list = view();
  $('lcClear').hidden = !files.length;
  $('lcSel').hidden = !files.length;
  if (!files.length) {
    $('lcInfo').textContent = '';
    $('lcList').innerHTML = statusHTML('選擇手機裡的影片開始播放。可以一次選多個，或選整個資料夾。');
    return;
  }
  const total = list.reduce((s, f) => s + (f.dur || 0), 0);
  const sel = list.filter(f => !offKeys.has(f.key)).length;
  $('lcInfo').textContent = `共 ${files.length} 個影片` +
    (list.length !== files.length ? `，符合條件 ${list.length} 個` : '') + (total ? ` · 總長 ${fmt(total)}` : '');
  $('lcSelCount').textContent = `已勾選 ${sel}／${list.length}`;
  $('lcList').innerHTML = list.length ? list.map(item).join('') : statusHTML('沒有符合篩選條件的影片。');
}
let raf = 0;
function renderSoon() { clearTimeout(raf); raf = setTimeout(render, 150); }

/* ========== 播放 ========== */
function playKey(k) {
  const f = byKey(k); if (!f) return;
  App.playLocal(f.file, f.key, { id: f.key, title: f.name, channelTitle: '本機影片 · ' + size(f.size) });
}
function playFile(f) {
  const keys = checkedKeys();
  if (!keys.includes(f.key)) keys.unshift(f.key);      // 點了沒勾選的檔案：照樣播
  q = new App.PlayQueue(keys, f.key);
  playKey(f.key);
}
function step(d) {
  if (!q) return;
  const n = d > 0 ? q.next(false) : q.prev();
  if (n) playKey(n);
}
function syncQueue() {
  if (!q) return;
  const keys = checkedKeys();
  if (nowKey && !keys.includes(nowKey)) keys.unshift(nowKey);
  q.setKeys(keys);
  Browse.refreshNow();
}

// 正在播放：顯示第幾個 + 上一個／下一個
const prevExtra = Browse.nowExtra;
Browse.nowExtra = id => {
  if (!id || !id.startsWith('local:')) return prevExtra(id);
  if (!q || q.order.length < 2 && App.PlayMode.repeat === 'off') return '';
  return `<div class="epNav"><span class="meta">本機清單 · 第 ${q.pos + 1}／${q.order.length} 個</span>
    <span class="srBtns">
      <button type="button" class="btn ghost small" data-lc-step="-1" ${q.hasPrev() ? '' : 'disabled'}>上一個</button>
      <button type="button" class="btn ghost small" data-lc-step="1" ${q.hasNext() ? '' : 'disabled'}>下一個</button>
    </span></div>`;
};
const prevPlay = App.hooks.onPlay;
App.hooks.onPlay = (id, meta) => {
  nowKey = id;
  if (q && !q.at(id)) q = null;
  prevPlay(id, meta);
  document.querySelectorAll('[data-lc]').forEach(b => b.classList.toggle('playing', files[+b.dataset.lc].key === id));
};
const prevEnded = App.hooks.onEnded;
App.hooks.onEnded = () => {                  // 本機影片播完：依播放模式接下一個
  if (App.mode !== 'local') return prevEnded();
  if (!q) return false;
  const n = q.next(true);
  if (n) playKey(n);
  renderSoon();
  return true;
};
App.onModeChange(() => { if (q) q.rebuild(q.cur); Browse.refreshNow(); });

/* ========== 選檔 ========== */
const pickFiles = $('pickFiles'), pickDir = $('pickDir');
$('btnFiles').onclick = () => pickFiles.click();
$('btnDir').onclick = () => pickDir.click();
if (/iPhone|iPad|iPod/.test(navigator.userAgent)) $('btnDir').hidden = true;   // iPhone 不支援選資料夾
[pickFiles, pickDir].forEach(inp => inp.addEventListener('change', () => { add([...inp.files]); inp.value = ''; }));
$('lcClear').onclick = () => { files.length = 0; q = null; render(); };
$('lcAll').onclick = () => { view().forEach(f => offKeys.delete(f.key)); saveOff(); syncQueue(); render(); };
$('lcNone').onclick = () => { view().forEach(f => offKeys.add(f.key)); saveOff(); syncQueue(); render(); };
$('lcPlay').onclick = () => {
  const keys = checkedKeys(); if (!keys.length) return;
  const k = App.PlayMode.shuffle ? keys[Math.floor(Math.random() * keys.length)] : keys[0];
  playFile(byKey(k));
};

// 桌機：可以直接把影片拖進來
const panel = $('panel');
panel.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
panel.addEventListener('drop', e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault(); Browse.Tabs.show('local'); add([...e.dataTransfer.files]);
});

document.addEventListener('click', e => {
  const t = e.target.closest('[data-lc],[data-lc-step],[data-lc-chk]');
  if (!t || t.disabled) return;
  if (t.dataset.lcChk) {
    const f = files[+t.dataset.lcChk];
    t.checked ? offKeys.delete(f.key) : offKeys.add(f.key);
    saveOff(); syncQueue(); render();
  }
  else if (t.dataset.lcStep) step(+t.dataset.lcStep);
  else playFile(files[+t.dataset.lc]);
});

// 存進度後讓清單上的觀看進度條更新
setInterval(() => { if (App.mode === 'local' && !$('v-local').hidden) render(); }, 10000);
render();
})();
