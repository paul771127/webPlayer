/* webPlayer — 劇集：搜尋短劇／動畫／劇集的「系列播放清單」或「合輯長片」
   排除預告、花絮、解說；系列可看全部集數、自動播下一集、記住看到第幾集 */
'use strict';
(() => {
const { API, makeList, Tabs, esc, statusHTML, card, count, ago } = Browse;
const { store, fmt } = App;
const $ = id => document.getElementById(id);

/* ========== 設定 ========== */
// 標題含這些字的清單或集數會被排除
const JUNK = /預告|预告|trailer|teaser|花絮|幕後|幕后|reaction|解說|解说|精彩片段|精華|精华|片頭曲|片尾曲|\bMV\b|\bOST\b|highlights?|recap|搶先看|抢先看/i;
const CATS = {
  all:   '短劇|微短劇|動畫|動漫|電視劇|連續劇',
  short: '短劇|微短劇|短剧',
  anime: '動畫|動漫|anime',
  drama: '電視劇|連續劇|影集|电视剧'
};
const NEG = ' -預告 -預告片 -trailer -teaser -花絮 -reaction -解說';
const MAX_EPS = 500;

/* ========== 資料 ========== */
const plCache = new Map();
async function playlists(ids) {
  if (!ids.length) return [];
  const j = await API.get('playlists', { part: 'snippet,contentDetails', id: ids.join(','), maxResults: 50 });
  const map = {};
  j.items.forEach(p => {
    const t = p.snippet.thumbnails || {};
    map[p.id] = {
      id: p.id, title: p.snippet.title, channelId: p.snippet.channelId, channelTitle: p.snippet.channelTitle,
      published: p.snippet.publishedAt, count: p.contentDetails.itemCount,
      thumb: (t.medium || t.high || t.default || {}).url || ''
    };
  });
  return ids.map(id => map[id]).filter(Boolean);
}

async function searchSeries(o) {
  const long = o.form === 'long';
  const p = {
    part: 'snippet', type: long ? 'video' : 'playlist', maxResults: 25, order: o.order,
    regionCode: 'TW', relevanceLanguage: 'zh-Hant',
    q: `${o.kw} ${CATS[o.cat]}${long ? ' 全集|合集|完整版' : ''}${NEG}`.trim()
  };
  if (long) { p.videoDuration = 'long'; p.videoEmbeddable = 'true'; }
  if (+o.within) p.publishedAfter = new Date(Date.now() - o.within * 864e5).toISOString();
  if (o.page) p.pageToken = o.page;
  const j = await API.get('search', p);
  if (long) {
    const items = await API.details(j.items.map(i => i.id.videoId).filter(Boolean));
    return { items: items.filter(v => !JUNK.test(v.title)), next: j.nextPageToken };
  }
  const pls = await playlists(j.items.map(i => i.id.playlistId).filter(Boolean));
  pls.forEach(pl => plCache.set(pl.id, pl));
  pls.forEach(pl => { pl.drama = true; });
  return { items: pls.filter(pl => pl.count >= o.min && !JUNK.test(pl.title)), next: j.nextPageToken, render: plCard };
}

// 讀取整個播放清單（每 50 集 1 單位），並補上每集長度
async function loadEpisodes(plId) {
  let page = null; const ids = [];
  do {
    const p = { part: 'contentDetails', playlistId: plId, maxResults: 50 };
    if (page) p.pageToken = page;
    const j = await API.get('playlistItems', p);
    ids.push(...j.items.map(i => i.contentDetails.videoId));
    page = j.nextPageToken;
  } while (page && ids.length < MAX_EPS);
  const out = [];
  for (let i = 0; i < ids.length; i += 50) out.push(...await API.details(ids.slice(i, i + 50)));
  return out;
}

/* ========== 追劇進度（存在這台裝置，最多 30 部） ========== */
const Prog = {
  all: () => store.get('seriesProg', {}),
  get: id => Prog.all()[id] || null,
  set(pl, v, ep, total) {
    const d = Prog.all();
    d[pl.id] = { vid: v.id, ep, total, title: pl.title, thumb: pl.thumb, channelTitle: pl.channelTitle, at: Date.now() };
    Object.keys(d).sort((a, b) => d[b].at - d[a].at).slice(30).forEach(k => delete d[k]);
    store.set('seriesProg', d);
    renderContinue();
  },
  remove(id) { const d = Prog.all(); delete d[id]; store.set('seriesProg', d); renderContinue(); }
};
function renderContinue() {
  const d = Prog.all();
  const ids = Object.keys(d).sort((a, b) => d[b].at - d[a].at).slice(0, 10);
  $('srCont').innerHTML = ids.length ? '<h3>繼續觀看</h3>' + ids.map(id => `
    <div class="chRow">
      <button type="button" class="chOpen" data-cont="${esc(id)}">
        <img class="mini" src="${esc(d[id].thumb)}" alt="">
        <span class="stack"><span class="title">${esc(d[id].title)}</span><span class="meta">看到第 ${d[id].ep} 集（共 ${d[id].total} 集）</span></span>
      </button>
      <button type="button" class="btn ghost small" data-cont-del="${esc(id)}" aria-label="從清單移除">移除</button>
    </div>`).join('') : '';
}

/* ========== 卡片 ========== */
function plCard(pl) {
  return `<button type="button" class="vid" data-pl="${esc(pl.id)}"${pl.drama ? ' data-drama="1"' : ''}>
    <span class="thumb"><img src="${esc(pl.thumb)}" alt="" loading="lazy"><span class="dur">${pl.count} 部</span></span>
    <span class="info"><span class="title">${esc(pl.title)}</span>
      <span class="meta">${esc(pl.channelTitle)}<br>建立於 ${ago(pl.published)}</span></span>
  </button>`;
}

/* ========== 搜尋畫面 ========== */
const list = makeList($('srResults'), $('moreSr'));
let cat = store.get('srCat', 'all'), searched = false;
const FIELDS = ['srKind', 'srMin', 'srWithin', 'srOrder'];
const saved = store.get('srFilters', {});
FIELDS.forEach(f => { if (saved[f]) $(f).value = saved[f]; });

function syncUi() {
  document.querySelectorAll('#srCat button').forEach(b => b.classList.toggle('on', b.dataset.cat === cat));
  $('srMin').disabled = $('srKind').value === 'long';
}
function runSearch() {
  searched = true;
  const o = {
    kw: $('srKw').value.trim(), cat, form: $('srKind').value, min: +$('srMin').value,
    within: $('srWithin').value, order: $('srOrder').value
  };
  list.start(page => searchSeries({ ...o, page }));
}
$('srCat').addEventListener('click', e => {
  const b = e.target.closest('button[data-cat]'); if (!b) return;
  cat = b.dataset.cat; store.set('srCat', cat); syncUi(); runSearch();
});
FIELDS.forEach(f => $(f).addEventListener('change', () => {
  store.set('srFilters', Object.fromEntries(FIELDS.map(k => [k, $(k).value])));
  syncUi(); if (searched) runSearch();
}));
$('srForm').addEventListener('submit', e => { e.preventDefault(); $('srKw').blur(); runSearch(); });

/* ========== 系列／播放清單頁 ========== */
let cur = null;      // 正在看的清單 { pl, eps }
let queue = null;    // 正在播放的清單 { pl, raw, q: PlayQueue }
let nowId = null;
const junkDefault = new Map();                       // 這次開啟時的預設：劇集找來的才預設隱藏預告
const hideJunk = id => { const m = store.get('srJunkMap', {}); return id in m ? m[id] : (junkDefault.get(id) ?? false); };
const isRev = id => !!store.get('srRev', {})[id];
function epsOf(c) {
  const eps = hideJunk(c.pl.id) ? c.eps.filter(v => !JUNK.test(v.title)) : c.eps.slice();
  return isRev(c.pl.id) ? eps.reverse() : eps;
}
// 勾選：記住「不播」的集數
const offSet = id => new Set(store.get('srOff', {})[id] || []);
function setOff(id, set) { const m = store.get('srOff', {}); m[id] = [...set]; store.set('srOff', m); }
const checkedIds = c => { const off = offSet(c.pl.id); return epsOf(c).filter(v => !off.has(v.id)).map(v => v.id); };

async function openSeries(id, opt = {}) {
  if (opt.junk !== undefined && !junkDefault.has(id)) junkDefault.set(id, opt.junk);
  Tabs.show('series-detail', 'series');
  $('srHead').innerHTML = statusHTML('載入清單中…');
  $('srEps').innerHTML = '';
  try {
    let pl = plCache.get(id);
    if (!pl) { pl = (await playlists([id]))[0]; if (!pl) throw new Error('找不到這個播放清單（YouTube 自動產生的「合輯／Mix」無法讀取）。'); plCache.set(id, pl); }
    const eps = (queue && queue.pl.id === id) ? queue.raw : await loadEpisodes(id);
    eps.forEach(v => Browse.cache.set(v.id, v));
    cur = { pl, eps };
    renderSeries();
    if (opt.startVideo && eps.some(v => v.id === opt.startVideo)) playId(cur, opt.startVideo);
    else if (opt.autoplay) playStart();
  } catch (e) {
    $('srHead').innerHTML = `<button type="button" class="btn ghost small" data-sr-back>‹ 返回</button>` + statusHTML(e.message, true);
  }
}

function renderSeries() {
  if (!cur) return;
  const { pl } = cur, eps = epsOf(cur), p = Prog.get(pl.id), off = offSet(pl.id);
  const ri = p ? eps.findIndex(v => v.id === p.vid) : -1;
  const sel = eps.filter(v => !off.has(v.id));
  const total = sel.reduce((s, v) => s + (v.dur || 0), 0);
  const startText = App.PlayMode.shuffle ? '隨機播放' : ri >= 0 && !off.has(eps[ri].id) ? `繼續看第 ${ri + 1} 集` : '從頭播放';
  $('srHead').innerHTML = `
    <button type="button" class="btn ghost small" data-sr-back>‹ 返回</button>
    <div class="srTop">
      <span class="thumb"><img src="${esc(pl.thumb)}" alt=""></span>
      <div class="info">
        <div class="title name2">${esc(pl.title)}</div>
        <button type="button" class="chLink" data-ch="${esc(pl.channelId)}">${esc(pl.channelTitle)}</button>
        <div class="meta">${eps.length} 部${total ? ' · 已選的共 ' + fmt(total) : ''}</div>
      </div>
    </div>
    <div class="srBtns">
      <button type="button" class="btn" data-sr-start ${sel.length ? '' : 'disabled'}>${startText}</button>
      <button type="button" class="btn ghost" data-sr-rev>${isRev(pl.id) ? '改回原順序' : '反轉順序'}</button>
    </div>
    <div class="selBar">
      <span class="meta">已勾選 ${sel.length}／${eps.length}</span>
      <span class="srBtns">
        <button type="button" class="btn ghost small" data-sr-all="1">全選</button>
        <button type="button" class="btn ghost small" data-sr-all="0">全不選</button>
      </span>
    </div>
    <label class="toggle meta"><input type="checkbox" id="srJunk" ${hideJunk(pl.id) ? 'checked' : ''}> 隱藏預告、花絮、解說、MV</label>`;
  $('srEps').innerHTML = eps.length ? eps.map((v, i) => `
    <div class="ep${v.id === nowId ? ' playing' : ''}${off.has(v.id) ? ' off' : ''}">
      <input type="checkbox" data-sr-chk="${esc(v.id)}" ${off.has(v.id) ? '' : 'checked'} aria-label="播放這部">
      <button type="button" class="epBtn" data-ep="${esc(v.id)}">
        <span class="no">${i + 1}</span><span class="title">${esc(v.title)}</span>
        <span class="d">${v.live === 'live' ? '直播' : fmt(v.dur)}</span>
      </button>
    </div>`).join('') : statusHTML('這個清單沒有可播放的影片。');
  $('srJunk').onchange = e => {
    const m = store.get('srJunkMap', {}); m[pl.id] = e.target.checked; store.set('srJunkMap', m);
    syncQueue(); renderSeries();
  };
}

// 依目前的勾選、順序、播放模式重建佇列
function syncQueue() {
  if (!queue || !cur || queue.pl.id !== cur.pl.id) return;
  const keys = checkedIds(cur);
  if (nowId && !keys.includes(nowId)) keys.unshift(nowId);
  queue.q.setKeys(keys);
  Browse.refreshNow();
}

function playId(c, vid) {
  const keys = checkedIds(c);
  if (!keys.includes(vid)) keys.unshift(vid);          // 點了沒勾選的那部：照樣播
  queue = { pl: c.pl, raw: c.eps, q: new App.PlayQueue(keys, vid) };
  go(vid);
}
function go(vid) {
  const c = { pl: queue.pl, eps: queue.raw }, eps = epsOf(c), i = eps.findIndex(v => v.id === vid);
  const v = eps[i] || queue.raw.find(x => x.id === vid);
  if (!v) return;
  queue.q.at(vid);
  Prog.set(queue.pl, v, i + 1, eps.length);
  App.play(v.id, v);
  if (cur && cur.pl.id === queue.pl.id) renderSeries();
}
function playStart() {
  if (!cur) return;
  const keys = checkedIds(cur);
  if (!keys.length) return;
  const p = Prog.get(cur.pl.id);
  let vid = keys[0];
  if (App.PlayMode.shuffle) vid = keys[Math.floor(Math.random() * keys.length)];
  else if (p && keys.includes(p.vid)) vid = p.vid;
  playId(cur, vid);
}

/* ========== 正在播放：顯示第幾部 + 上一個／下一個 ========== */
Browse.nowExtra = id => {
  if (!queue || queue.q.cur !== id) return '';
  const eps = epsOf({ pl: queue.pl, eps: queue.raw }), i = eps.findIndex(v => v.id === id);
  const { q } = queue;
  return `<div class="epNav">
    <button type="button" class="chLink" data-pl="${esc(queue.pl.id)}">${esc(queue.pl.title)} · 第 ${i + 1}／${eps.length} 部（播放 ${q.order.length} 部）</button>
    <span class="srBtns">
      <button type="button" class="btn ghost small" data-ep-step="-1" ${q.hasPrev() ? '' : 'disabled'}>上一個</button>
      <button type="button" class="btn ghost small" data-ep-step="1" ${q.hasNext() ? '' : 'disabled'}>下一個</button>
    </span></div>`;
};
const prevOnPlay = App.hooks.onPlay;
App.hooks.onPlay = (id, meta) => {
  nowId = id;
  if (queue && !queue.q.at(id)) queue = null;      // 播的不是這個清單的影片 → 離開清單模式
  prevOnPlay(id, meta);
  document.querySelectorAll('#srEps .ep').forEach(r => {
    r.classList.toggle('playing', r.querySelector('[data-ep]').dataset.ep === id);
  });
};
App.hooks.onEnded = () => {                      // 播完：依播放模式接下一個
  if (!queue || App.mode !== 'yt') return false;
  const n = queue.q.next(true);
  if (n) go(n);
  return true;
};
App.onModeChange(() => {
  if (queue) queue.q.rebuild(queue.q.cur);
  Browse.refreshNow();
  if (cur) renderSeries();
});

/* ========== 點擊 ========== */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-pl],[data-ep],[data-ep-step],[data-sr-back],[data-sr-rev],[data-sr-start],[data-sr-all],[data-sr-chk],[data-cont],[data-cont-del]');
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.pl) openSeries(d.pl, { junk: !!d.drama });
  else if (d.cont) openSeries(d.cont, { autoplay: true, junk: true });
  else if (d.contDel) Prog.remove(d.contDel);
  else if (d.epStep) {
    if (!queue) return;
    const n = +d.epStep > 0 ? queue.q.next(false) : queue.q.prev();
    if (n) go(n);
  }
  else if (d.ep && cur) playId(cur, d.ep);
  else if (d.srChk && cur) {
    const off = offSet(cur.pl.id);
    t.checked ? off.delete(d.srChk) : off.add(d.srChk);
    setOff(cur.pl.id, off); syncQueue(); renderSeries();
  }
  else if (d.srAll !== undefined && cur) {
    setOff(cur.pl.id, d.srAll === '1' ? new Set() : new Set(epsOf(cur).map(v => v.id)));
    syncQueue(); renderSeries();
  }
  else if ('srStart' in d) playStart();
  else if ('srBack' in d) Tabs.show('series');
  else if ('srRev' in d && cur) {
    const r = store.get('srRev', {}); r[cur.pl.id] = !r[cur.pl.id]; store.set('srRev', r);
    syncQueue(); renderSeries();
  }
});

/* ========== 給其他模組用：開啟播放清單、搜尋播放清單 ========== */
window.Series = {
  open: openSeries,
  async search(o) {          // 搜尋分頁的「播放清單／專輯」
    const p = { part: 'snippet', type: 'playlist', maxResults: 20, q: o.q, order: o.order === 'rating' ? 'relevance' : o.order };
    if (+o.within) p.publishedAfter = new Date(Date.now() - o.within * 864e5).toISOString();
    if (o.page) p.pageToken = o.page;
    const j = await API.get('search', p);
    const pls = await playlists(j.items.map(i => i.id.playlistId).filter(Boolean));
    pls.forEach(pl => plCache.set(pl.id, pl));
    return { items: pls.filter(pl => pl.count > 0), next: j.nextPageToken, render: plCard };
  }
};

/* ========== 起始畫面 ========== */
syncUi();
renderContinue();
$('srResults').innerHTML = statusHTML(API.key
  ? '點上面的類型開始找，也可以輸入劇名。只會列出 ' + $('srMin').selectedOptions[0].text + '的完整系列。'
  : 'NOKEY');
})();
