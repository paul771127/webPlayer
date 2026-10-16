/* webPlayer — 片庫：像網路電視一樣依分類（短劇、陸劇、韓劇…）× 劇情（穿越、懸疑…）瀏覽，
   有今日熱播、本月熱播、最新上架與整季系列；排除預告、花絮、解說；系列可看全部集數、自動播下一集 */
'use strict';
(() => {
const { API, makeList, Tabs, esc, statusHTML, card, count, ago } = Browse;
const { store, fmt } = App;
const $ = id => document.getElementById(id);

/* ========== 設定 ========== */
// 標題含這些字的清單或集數會被排除
const JUNK = /預告|预告|trailer|teaser|花絮|幕後|幕后|reaction|解說|解说|精彩片段|精華|精华|片頭曲|片尾曲|\bMV\b|\bOST\b|highlights?|recap|搶先看|抢先看/i;
const NEG = ' -預告 -預告片 -trailer -teaser -花絮 -reaction -解說';
const MAX_EPS = 500;

// 片庫分類：q 是搜尋用的關鍵字，long 表示排行榜只找 20 分鐘以上的整集（排除片段）
const DRAMA_GENRES = ['愛情', '古裝', '穿越', '懸疑', '喜劇', '家庭', '職場', '校園', '武俠', '奇幻', '科幻', '動作', '犯罪', '醫療', '歷史', '恐怖'];
const CATS = {
  all:   { name: '全部',   q: '短劇|電視劇|連續劇|韓劇|日劇|美劇|動畫', long: false, genres: ['愛情', '古裝', '穿越', '懸疑', '喜劇', '復仇', '霸總', '甜寵', '奇幻', '熱血'] },
  short: { name: '短劇',   q: '短劇|微短劇|短剧', long: false, genres: ['霸總', '甜寵', '逆襲', '穿越', '重生', '復仇', '古裝', '戰神', '神醫', '萌寶', '虐戀', '懸疑'] },
  cn:    { name: '陸劇',   q: '陸劇|大陸劇|國產劇|电视剧', long: true, genres: DRAMA_GENRES },
  tw:    { name: '台劇',   q: '台劇|台灣劇|偶像劇|八點檔', long: true, genres: DRAMA_GENRES },
  kr:    { name: '韓劇',   q: '韓劇|韩剧|Korean drama', long: true, genres: DRAMA_GENRES },
  jp:    { name: '日劇',   q: '日劇|日剧|Japanese drama', long: true, genres: DRAMA_GENRES },
  us:    { name: '美劇',   q: '美劇|美剧|影集|TV series', long: true, genres: DRAMA_GENRES },
  anime: { name: '卡通動畫', q: '動畫|動漫|卡通|anime', long: true, genres: ['熱血', '冒險', '搞笑', '校園', '戀愛', '奇幻', '異世界', '機甲', '運動', '治癒', '親子', '推理'] }
};
const MODES = {
  today:  { name: '今日熱播', note: '今天上架的影片中，觀看次數最多的' },
  month:  { name: '本月熱播', note: '近 30 天上架的影片中，觀看次數最多的' },
  latest: { name: '最新上架', note: '依上架時間，最新的在前' },
  series: { name: '整季系列', note: '完整的整季播放清單，點進去可看全部集數' }
};

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

/* ========== 片庫畫面：分類 × 劇情 × 排行 ========== */
const list = makeList($('srResults'), $('moreSr'));
let cat = store.get('srCat', 'all'), genre = store.get('srGenre', ''), mode = store.get('srMode', 'today');
if (!CATS[cat]) cat = 'all';
if (!MODES[mode]) mode = 'today';
let loaded = false;

// 同樣的條件 1 小時內直接用存下來的結果，省每日搜尋額度
async function cached(key, fn) {
  const all = store.get('srCache', {}), hit = all[key];
  if (hit && Date.now() - hit.at < 36e5) return hit.v;
  const v = await fn();
  all[key] = { at: Date.now(), v };
  Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(30).forEach(k => delete all[k]);
  store.set('srCache', all);
  return v;
}

async function fetchCatalog(o) {
  const c = CATS[o.cat];
  const q = `${o.kw} ${o.genre} ${c.q}${NEG}`.replace(/\s+/g, ' ').trim();
  const base = { part: 'snippet', maxResults: 25, regionCode: 'TW', relevanceLanguage: 'zh-Hant', q };
  if (o.page) base.pageToken = o.page;
  if (o.mode === 'series') {
    const j = await API.get('search', { ...base, type: 'playlist', order: 'relevance' });
    const pls = await playlists(j.items.map(i => i.id.playlistId).filter(Boolean));
    return { kind: 'pl', items: pls.filter(pl => pl.count >= o.min && !JUNK.test(pl.title)), next: j.nextPageToken };
  }
  const p = { ...base, type: 'video', videoEmbeddable: 'true', order: o.mode === 'latest' ? 'date' : 'viewCount' };
  if (o.mode === 'today') p.publishedAfter = new Date(Date.now() - 864e5).toISOString();
  if (o.mode === 'month') p.publishedAfter = new Date(Date.now() - 30 * 864e5).toISOString();
  if (c.long) p.videoDuration = 'long';
  const j = await API.get('search', p);
  const vids = await API.details(j.items.map(i => i.id.videoId).filter(Boolean));
  return { kind: 'vid', items: vids.filter(v => !JUNK.test(v.title)), next: j.nextPageToken };
}

function renderChips() {
  $('srCat').innerHTML = Object.entries(CATS).map(([k, c]) =>
    `<button type="button" data-cat="${k}" class="${k === cat ? 'on' : ''}">${c.name}</button>`).join('');
  $('srGenre').innerHTML = ['', ...CATS[cat].genres].map(g =>
    `<button type="button" data-genre="${esc(g)}" class="${g === genre ? 'on' : ''}">${g || '全部劇情'}</button>`).join('');
  $('srMode').innerHTML = Object.entries(MODES).map(([k, m]) =>
    `<button type="button" data-mode="${k}" class="${k === mode ? 'on' : ''}">${m.name}</button>`).join('');
  $('srNote').textContent = MODES[mode].note;
  $('srMin').hidden = mode !== 'series';
}

function runSearch() {
  loaded = true;
  if (!API.key) { $('srResults').innerHTML = statusHTML('NOKEY'); return; }
  const o = { kw: $('srKw').value.trim(), cat, genre, mode, min: +$('srMin').value };
  let rank = 0;
  const ranked = mode === 'today' || mode === 'month';
  const renderVid = v => {
    const html = card(v);
    return ranked ? html.replace('<span class="thumb">', `<span class="thumb"><span class="rank">${++rank}</span>`) : html;
  };
  list.start(async page => {
    const r = await cached(JSON.stringify({ ...o, page: page || '' }), () => fetchCatalog({ ...o, page }));
    if (r.kind === 'pl') {
      r.items.forEach(pl => { pl.drama = true; plCache.set(pl.id, pl); });
      return { items: r.items, next: r.next, render: plCard };
    }
    r.items.forEach(v => Browse.cache.set(v.id, v));
    return { items: r.items, next: r.next, render: renderVid };
  });
}

$('srCat').addEventListener('click', e => {
  const b = e.target.closest('button[data-cat]'); if (!b) return;
  cat = b.dataset.cat; store.set('srCat', cat);
  if (!CATS[cat].genres.includes(genre)) { genre = ''; store.set('srGenre', ''); }
  renderChips(); runSearch();
});
$('srGenre').addEventListener('click', e => {
  const b = e.target.closest('button[data-genre]'); if (!b) return;
  genre = b.dataset.genre; store.set('srGenre', genre); renderChips(); runSearch();
});
$('srMode').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]'); if (!b) return;
  mode = b.dataset.mode; store.set('srMode', mode); renderChips(); runSearch();
});
$('srMin').value = String(store.get('srMinEps', 5));
$('srMin').addEventListener('change', () => { store.set('srMinEps', +$('srMin').value); runSearch(); });
$('srForm').addEventListener('submit', e => { e.preventDefault(); $('srKw').blur(); runSearch(); });
// 第一次切到「片庫」就自動載入目前分類
document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab="series"]');
  if (b && !loaded) runSearch();
});

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

/* ========== 免 API：用 YouTube 播放器本身讀出清單裡的影片 ========== */
// 另開一個隱藏的小播放器載入清單，取得影片 ID（不影響正在播的影片）
function keylessIds(listId) {
  return new Promise((resolve, reject) => {
    if (!window.YT || !YT.Player) { reject(new Error('播放器還在載入，請稍等幾秒再試一次。')); return; }
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:-9999px;top:0;width:2px;height:2px;overflow:hidden';
    const holder = document.createElement('div');
    box.appendChild(holder); document.body.appendChild(box);
    let tries = 0, p;
    const done = (ids, err) => {
      clearInterval(timer);
      try { p.destroy(); } catch (e) {}
      box.remove();
      ids && ids.length ? resolve(ids) : reject(err || new Error('讀不到這個播放清單，可能是私人清單或已被刪除。'));
    };
    const timer = setInterval(() => {
      tries++;
      try { const ids = p && p.getPlaylist && p.getPlaylist(); if (ids && ids.length) done(ids); } catch (e) {}
      if (tries > 40) done(null);                     // 約 12 秒還讀不到就放棄
    }, 300);
    p = new YT.Player(holder, {
      width: 2, height: 2,
      playerVars: { listType: 'playlist', list: listId, autoplay: 0, controls: 0, playsinline: 1 },
      events: {
        onReady: e => { try { e.target.cuePlaylist({ listType: 'playlist', list: listId }); } catch (err) {} },
        onError: () => done(null)
      }
    });
  });
}
// 標題用公開的 oEmbed 補上（不需要金鑰）；讀不到就顯示「第 N 部」
async function oembed(url) {
  const u = encodeURIComponent(url);
  for (const src of ['https://www.youtube.com/oembed?format=json&url=' + u, 'https://noembed.com/embed?url=' + u]) {
    try { const r = await fetch(src); if (r.ok) { const j = await r.json(); if (j.title) return j; } } catch (e) {}
  }
  return null;
}
async function fillTitles(c) {
  let i = 0, dirty = false;
  const work = async () => {
    while (i < c.eps.length) {
      const v = c.eps[i++];
      const j = await oembed('https://www.youtube.com/watch?v=' + v.id);
      if (j) { v.title = j.title; v.channelTitle = j.author_name || ''; dirty = true; }
    }
  };
  const tick = setInterval(() => { if (dirty && cur === c) { dirty = false; renderSeries(); Browse.refreshNow(); } }, 800);
  await Promise.all([work(), work(), work(), work()]);
  clearInterval(tick);
  if (cur === c) { renderSeries(); Browse.refreshNow(); }
}
async function keylessOpen(id) {
  const ids = await keylessIds(id);
  const eps = ids.map((vid, k) => ({
    id: vid, title: `第 ${k + 1} 部`, channelTitle: '', channelId: '', dur: 0, views: null,
    thumb: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, published: null, live: 'none'
  }));
  const pl = { id, title: id.startsWith('RD') ? 'YouTube 合輯' : '播放清單', channelId: '', channelTitle: '', thumb: eps[0].thumb, count: eps.length, keyless: true };
  oembed('https://www.youtube.com/playlist?list=' + id).then(j => {
    if (j) { pl.title = j.title; pl.channelTitle = j.author_name || ''; if (cur && cur.pl === pl) renderSeries(); }
  });
  return { pl, eps };
}

async function openSeries(id, opt = {}) {
  if (opt.junk !== undefined && !junkDefault.has(id)) junkDefault.set(id, opt.junk);
  Tabs.show('series-detail', 'series');
  $('srHead').innerHTML = statusHTML('載入清單中…');
  $('srEps').innerHTML = '';
  try {
    let pl = plCache.get(id), eps;
    if (queue && queue.pl.id === id) { pl = queue.pl; eps = queue.raw; }
    else if (!API.key || id.startsWith('RD')) {     // 沒有金鑰，或是 API 讀不到的合輯（Mix）
      ({ pl, eps } = await keylessOpen(id));
      plCache.set(id, pl);
    } else {
      if (!pl) { pl = (await playlists([id]))[0]; if (!pl) throw new Error('找不到這個播放清單，可能是私人清單或已被刪除。'); plCache.set(id, pl); }
      eps = await loadEpisodes(id);
    }
    eps.forEach(v => Browse.cache.set(v.id, v));
    cur = { pl, eps };
    renderSeries();
    if (pl.keyless && !eps.titled) { eps.titled = true; fillTitles(cur); }
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
        ${pl.channelId ? `<button type="button" class="chLink" data-ch="${esc(pl.channelId)}">${esc(pl.channelTitle)}</button>` : `<div class="meta">${esc(pl.channelTitle)}</div>`}
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
        <span class="d">${v.live === 'live' ? '直播' : v.dur ? fmt(v.dur) : ''}</span>
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
renderChips();
renderContinue();
$('srResults').innerHTML = statusHTML(API.key ? '選分類和劇情，就會列出排行。' : 'NOKEY');
if (API.key && store.get('tab') === 'series') runSearch();
})();
