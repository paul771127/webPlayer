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
  return `<button type="button" class="vid" data-pl="${esc(pl.id)}">
    <span class="thumb"><img src="${esc(pl.thumb)}" alt="" loading="lazy"><span class="dur">${pl.count} 集</span></span>
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

/* ========== 系列頁 ========== */
let cur = null;      // 正在看的系列頁 { pl, eps }
let queue = null;    // 正在播放的系列 { pl, eps, idx }
let nowId = null;
const hideJunk = () => store.get('srHideJunk', true);
const isRev = id => !!store.get('srRev', {})[id];
function epsOf(c) {
  let eps = hideJunk() ? c.eps.filter(v => !JUNK.test(v.title)) : c.eps.slice();
  return isRev(c.pl.id) ? eps.reverse() : eps;
}

async function openSeries(id, autoplay) {
  Tabs.show('series-detail', 'series');
  $('srHead').innerHTML = statusHTML('載入集數中…');
  $('srEps').innerHTML = '';
  try {
    let pl = plCache.get(id);
    if (!pl) { pl = (await playlists([id]))[0]; if (!pl) throw new Error('找不到這個系列，可能已被刪除。'); plCache.set(id, pl); }
    const eps = (queue && queue.pl.id === id) ? queue.raw : await loadEpisodes(id);
    eps.forEach(v => Browse.cache.set(v.id, v));
    cur = { pl, eps };
    renderSeries();
    if (autoplay) {
      const list = epsOf(cur), p = Prog.get(id);
      const i = p ? Math.max(0, list.findIndex(v => v.id === p.vid)) : 0;
      if (list.length) playEp(cur, i);
    }
  } catch (e) {
    $('srHead').innerHTML = `<button type="button" class="btn ghost small" data-sr-back>‹ 返回</button>` + statusHTML(e.message, true);
  }
}

function renderSeries() {
  if (!cur) return;
  const { pl } = cur, eps = epsOf(cur), p = Prog.get(pl.id);
  const ri = p ? eps.findIndex(v => v.id === p.vid) : -1;
  const total = eps.reduce((s, v) => s + (v.dur || 0), 0);
  $('srHead').innerHTML = `
    <button type="button" class="btn ghost small" data-sr-back>‹ 返回</button>
    <div class="srTop">
      <span class="thumb"><img src="${esc(pl.thumb)}" alt=""></span>
      <div class="info">
        <div class="title name2">${esc(pl.title)}</div>
        <button type="button" class="chLink" data-ch="${esc(pl.channelId)}">${esc(pl.channelTitle)}</button>
        <div class="meta">${eps.length} 集${total ? ' · 共 ' + fmt(total) : ''}</div>
      </div>
    </div>
    <div class="srBtns">
      <button type="button" class="btn" data-ep="${ri >= 0 ? ri : 0}">${ri >= 0 ? `繼續看第 ${ri + 1} 集` : '從第 1 集開始'}</button>
      <button type="button" class="btn ghost" data-sr-rev>${isRev(pl.id) ? '改回原順序' : '反轉集數順序'}</button>
    </div>
    <label class="toggle meta"><input type="checkbox" id="srJunk" ${hideJunk() ? 'checked' : ''}> 隱藏預告、花絮、解說</label>`;
  $('srEps').innerHTML = eps.length ? eps.map((v, i) => `
    <button type="button" class="ep${v.id === nowId ? ' playing' : ''}" data-ep="${i}">
      <span class="no">${i + 1}</span><span class="title">${esc(v.title)}</span>
      <span class="d">${v.live === 'live' ? '直播' : fmt(v.dur)}</span>
    </button>`).join('') : statusHTML('這個清單沒有可播放的影片。');
  $('srJunk').onchange = e => { store.set('srHideJunk', e.target.checked); renderSeries(); };
}

function playEp(c, i) {
  const eps = epsOf(c);
  if (!eps[i]) return;
  queue = { pl: c.pl, raw: c.eps, eps, idx: i };
  Prog.set(c.pl, eps[i], i + 1, eps.length);
  App.play(eps[i].id, eps[i]);
  if (cur && cur.pl.id === c.pl.id) renderSeries();   // 更新「繼續看第 N 集」按鈕
}

/* ========== 正在播放：顯示第幾集 + 上一集／下一集 ========== */
Browse.nowExtra = id => {
  if (!queue || !queue.eps[queue.idx] || queue.eps[queue.idx].id !== id) return '';
  const { idx, eps, pl } = queue;
  return `<div class="epNav">
    <button type="button" class="chLink" data-pl="${esc(pl.id)}">${esc(pl.title)} · 第 ${idx + 1}／${eps.length} 集</button>
    <span class="srBtns">
      <button type="button" class="btn ghost small" data-ep-step="-1" ${idx === 0 ? 'disabled' : ''}>上一集</button>
      <button type="button" class="btn ghost small" data-ep-step="1" ${idx >= eps.length - 1 ? 'disabled' : ''}>下一集</button>
    </span></div>`;
};
const prevOnPlay = App.hooks.onPlay;
App.hooks.onPlay = (id, meta) => {
  nowId = id;
  if (queue) {                                   // 播的不是這個系列的影片 → 離開系列模式
    const i = queue.eps.findIndex(v => v.id === id);
    if (i < 0) queue = null; else queue.idx = i;
  }
  prevOnPlay(id, meta);
  document.querySelectorAll('.ep').forEach(b => {
    const eps = cur ? epsOf(cur) : [];
    b.classList.toggle('playing', eps[+b.dataset.ep] && eps[+b.dataset.ep].id === id);
  });
};
App.hooks.onEnded = () => {                      // 播完自動下一集
  if (queue && queue.idx < queue.eps.length - 1) playEp({ pl: queue.pl, eps: queue.raw }, queue.idx + 1);
};

/* ========== 點擊 ========== */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-pl],[data-ep],[data-ep-step],[data-sr-back],[data-sr-rev],[data-cont],[data-cont-del]');
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.pl) openSeries(d.pl);
  else if (d.cont) openSeries(d.cont, true);
  else if (d.contDel) Prog.remove(d.contDel);
  else if (d.epStep) { if (queue) playEp({ pl: queue.pl, eps: queue.raw }, queue.idx + +d.epStep); }
  else if (d.ep !== undefined && cur) playEp(cur, +d.ep);
  else if ('srBack' in d) Tabs.show('series');
  else if ('srRev' in d && cur) {
    const r = store.get('srRev', {}); r[cur.pl.id] = !r[cur.pl.id]; store.set('srRev', r);
    if (queue && queue.pl.id === cur.pl.id) {    // 播放中的系列也跟著換順序
      const id = queue.eps[queue.idx].id;
      queue.eps = epsOf(cur); queue.idx = queue.eps.findIndex(v => v.id === id);
      Browse.refreshNow();
    }
    renderSeries();
  }
});

/* ========== 起始畫面 ========== */
syncUi();
renderContinue();
$('srResults').innerHTML = statusHTML(API.key
  ? '點上面的類型開始找，也可以輸入劇名。只會列出 ' + $('srMin').selectedOptions[0].text + '的完整系列。'
  : 'NOKEY');
})();
