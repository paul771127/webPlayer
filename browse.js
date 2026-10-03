/* webPlayer — 瀏覽：搜尋、頻道、訂閱、設定、正在播放
   資料來源：YouTube Data API v3（需要使用者自己的 API 金鑰，只存在這台裝置） */
'use strict';
(() => {
const { store, fmt } = App;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ========== 格式化 ========== */
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  const u = [[31536000, '年'], [2592000, '個月'], [604800, '週'], [86400, '天'], [3600, '小時'], [60, '分鐘']];
  for (const [n, w] of u) if (s >= n) return Math.floor(s / n) + ' ' + w + '前';
  return '剛剛';
}
function count(n) {
  if (n == null || isNaN(n)) return '';
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + ' 億';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + ' 萬';
  return String(n);
}
function isoDur(p) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(p || '') || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
const thumbOf = t => ((t || {}).medium || (t || {}).high || (t || {}).default || {}).url || '';

/* ========== YouTube Data API ========== */
function errText(e) {
  const reason = (e && e.errors && e.errors[0] && e.errors[0].reason) || '';
  const text = (e && e.message) || '';
  if (reason === 'quotaExceeded') return '今天的 API 額度用完了，台灣時間下午 3～4 點會重置。';
  if (/API key not valid|keyInvalid/i.test(text + reason)) return 'API 金鑰無效，請到「設定」重新貼上。';
  if (/referer/i.test(text + reason)) return '這把金鑰不允許從這個網址使用，請檢查金鑰的「網站限制」。';
  if (reason === 'accessNotConfigured' || /has not been used|disabled/i.test(text)) return '這個 Google 專案還沒啟用「YouTube Data API v3」。';
  return '讀取失敗：' + (text || '網路連線有問題');
}
const API = {
  // 優先用這台裝置自己貼的金鑰，沒有就用 config.js 內建的
  get key() { return store.get('apiKey', '') || (window.WP_CONFIG || {}).apiKey || ''; },
  get builtIn() { return !!(window.WP_CONFIG || {}).apiKey; },
  async get(path, params) {
    if (!this.key) throw new Error('NOKEY');
    const qs = new URLSearchParams({ ...params, key: this.key });
    let r, j;
    try { r = await fetch('https://www.googleapis.com/youtube/v3/' + path + '?' + qs); j = await r.json(); }
    catch (e) { throw new Error('讀取失敗：網路連線有問題'); }
    if (!r.ok || j.error) throw new Error(errText(j.error));
    return j;
  },
  // 補上長度與觀看數，同時濾掉私人或已刪除的影片（1 單位）
  async details(ids) {
    if (!ids.length) return [];
    const j = await this.get('videos', { part: 'snippet,contentDetails,statistics', id: ids.join(','), maxResults: 50 });
    const map = {};
    j.items.forEach(v => {
      map[v.id] = {
        id: v.id, title: v.snippet.title, channelId: v.snippet.channelId, channelTitle: v.snippet.channelTitle,
        published: v.snippet.publishedAt, thumb: thumbOf(v.snippet.thumbnails),
        dur: isoDur(v.contentDetails.duration), views: v.statistics ? +v.statistics.viewCount : null,
        live: v.snippet.liveBroadcastContent
      };
    });
    return ids.map(id => map[id]).filter(Boolean);
  },
  // 搜尋（100 單位）
  async search(o) {
    const p = { part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: 20, q: o.q, order: o.order };
    if (o.duration !== 'any') p.videoDuration = o.duration;
    if (+o.within) p.publishedAfter = new Date(Date.now() - o.within * 864e5).toISOString();
    if (o.page) p.pageToken = o.page;
    const j = await this.get('search', p);
    return { items: await this.details(j.items.map(i => i.id.videoId).filter(Boolean)), next: j.nextPageToken };
  },
  // 頻道資料（1 單位）：可用頻道 ID 或 @帳號
  async channel(ref) {
    const p = { part: 'snippet,contentDetails,statistics' };
    if (ref.startsWith('@')) p.forHandle = ref; else p.id = ref;
    const j = await this.get('channels', p);
    const c = j.items && j.items[0];
    if (!c) throw new Error('找不到這個頻道。');
    return {
      id: c.id, title: c.snippet.title, thumb: thumbOf(c.snippet.thumbnails),
      uploads: c.contentDetails.relatedPlaylists.uploads,
      subs: c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount,
      videos: +c.statistics.videoCount
    };
  },
  // 頻道上傳的影片，新的在前（1 單位）
  async uploads(playlistId, page) {
    const p = { part: 'contentDetails', playlistId, maxResults: 20 };
    if (page) p.pageToken = page;
    const j = await this.get('playlistItems', p);
    return { items: await this.details(j.items.map(i => i.contentDetails.videoId)), next: j.nextPageToken };
  },
  async video(id) { return (await this.details([id]))[0] || null; }
};

/* ========== 影片卡片與分頁清單 ========== */
const cache = new Map();          // 影片 ID → 資料，點選時帶給「正在播放」
let nowId = null;

function card(v) {
  const badge = v.live === 'live' ? '<span class="dur live">直播</span>'
              : v.dur ? `<span class="dur">${fmt(v.dur)}</span>` : '';
  const views = v.views != null ? count(v.views) + ' 次觀看 · ' : '';
  return `<button type="button" class="vid${v.id === nowId ? ' playing' : ''}" data-id="${esc(v.id)}">
    <span class="thumb"><img src="${esc(v.thumb)}" alt="" loading="lazy">${badge}</span>
    <span class="info"><span class="title">${esc(v.title)}</span>
      <span class="meta">${esc(v.channelTitle)}<br>${views}${ago(v.published)}</span></span>
  </button>`;
}
const NOKEY_HTML = '要先貼上 YouTube API 金鑰才能使用。<br><button type="button" class="btn small" data-goto="settings">前往設定</button>';
function statusHTML(text, err) {
  return `<p class="status${err ? ' err' : ''}">${text === 'NOKEY' ? NOKEY_HTML : esc(text)}</p>`;
}

function makeList(listEl, moreBtn) {
  let fetcher = null, next = null, seq = 0, busy = false;
  async function page(reset) {
    if (busy && !reset) return;
    const my = ++seq; busy = true; moreBtn.hidden = true;
    if (reset) { listEl.innerHTML = ''; next = null; }
    listEl.insertAdjacentHTML('beforeend', statusHTML('載入中…'));
    const st = listEl.lastElementChild;
    try {
      const r = await fetcher(next);
      if (my !== seq) return;
      st.remove();
      if (!r.render) r.items.forEach(v => cache.set(v.id, v));
      listEl.insertAdjacentHTML('beforeend', r.items.map(r.render || card).join(''));
      next = r.next || null; moreBtn.hidden = !next;
      if (!listEl.querySelector('.vid')) listEl.innerHTML = statusHTML(next
        ? '這一頁沒有符合條件的結果，按「載入更多」繼續找。'
        : '沒有找到結果，試試其他關鍵字或放寬篩選條件。');
    } catch (e) {
      if (my !== seq) return;
      st.outerHTML = statusHTML(e.message, true);
    } finally { if (my === seq) busy = false; }
  }
  moreBtn.onclick = () => page(false);
  return {
    start(f) { fetcher = f; page(true); },
    clear(html) { seq++; busy = false; listEl.innerHTML = html || ''; moreBtn.hidden = true; }
  };
}

/* ========== 分頁切換 ========== */
const Tabs = {
  show(name, tab = name) {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'v-' + name; });
    store.set('tab', tab);
    $('panel').scrollTop = 0;
  }
};
$('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) Tabs.show(b.dataset.tab); });

/* ========== 訂閱（存在這台裝置） ========== */
const Subs = {
  all: () => store.get('subs', []),
  has: id => Subs.all().some(s => s.id === id),
  toggle(c) {
    let list = Subs.all();
    if (list.some(s => s.id === c.id)) list = list.filter(s => s.id !== c.id);
    else list.unshift({ id: c.id, title: c.title, thumb: c.thumb || '' });
    store.set('subs', list);
    Subs.refresh();
  },
  update(c) {            // 開頻道時順便更新名稱與頭像
    const list = Subs.all(), s = list.find(x => x.id === c.id);
    if (s && (s.title !== c.title || s.thumb !== c.thumb)) { s.title = c.title; s.thumb = c.thumb; store.set('subs', list); Subs.render(); }
  },
  render() {
    const list = Subs.all();
    $('subsList').innerHTML = list.length ? list.map(s => `
      <div class="chRow">
        <button type="button" class="chOpen" data-ch="${esc(s.id)}">${avatar(s)}<span>${esc(s.title)}</span></button>
        <button type="button" class="btn ghost small" data-unsub="${esc(s.id)}">取消訂閱</button>
      </div>`).join('')
      : statusHTML('還沒有訂閱任何頻道。播放影片時點「訂閱」，或在頻道頁點「訂閱」就會出現在這裡。');
  },
  refresh() {            // 同步所有訂閱按鈕的狀態
    document.querySelectorAll('[data-sub]').forEach(b => {
      const on = Subs.has(b.dataset.sub);
      b.classList.toggle('on', on); b.textContent = on ? '已訂閱' : '訂閱';
    });
    Subs.render();
  }
};
const chInfo = new Map();        // 頻道 ID → { id, title, thumb }，給訂閱按鈕用
function avatar(c) {
  return c.thumb ? `<img class="avatar" src="${esc(c.thumb)}" alt="">`
                 : `<span class="avatar">${esc((c.title || '?').trim().charAt(0))}</span>`;
}
function subBtn(c) {
  chInfo.set(c.id, { ...(chInfo.get(c.id) || {}), ...c });
  const on = Subs.has(c.id);
  return `<button type="button" class="btn sub${on ? ' on' : ''}" data-sub="${esc(c.id)}">${on ? '已訂閱' : '訂閱'}</button>`;
}

/* ========== 正在播放 ========== */
let nowV = null;
function showNow(v) {
  nowV = v;
  if (!v) { $('now').hidden = true; return; }
  $('now').hidden = false;
  $('now').innerHTML = `<div class="t">${esc(v.title)}</div>` + (v.channelId ? `
    <div class="chLine">
      <button type="button" class="chLink" data-ch="${esc(v.channelId)}">${esc(v.channelTitle)}</button>
      ${subBtn({ id: v.channelId, title: v.channelTitle })}
    </div>` : `<div class="meta">${esc(v.channelTitle || '')}</div>`) + Browse.nowExtra(v.id);
}
App.hooks.onPlay = async (id, meta) => {
  nowId = id;
  document.querySelectorAll('.vid').forEach(b => b.classList.toggle('playing', b.dataset.id === id));
  let v = meta || cache.get(id);
  if (!v && API.key) { try { v = await API.video(id); if (v) cache.set(id, v); } catch (e) {} }
  if (nowId !== id) return;
  if (v) { showNow(v); return; }
  // 沒有金鑰時：從播放器拿標題與作者（無法連到頻道）
  setTimeout(() => {
    if (nowId !== id) return;
    try { const d = App.player.getVideoData(); if (d && d.title) showNow({ id, title: d.title, channelTitle: d.author }); } catch (e) {}
  }, 1500);
};

/* ========== 搜尋 ========== */
const searchList = makeList($('results'), $('moreResults'));
let lastQ = '';
const filters = ['fWithin', 'fDur', 'fOrder'];
const saved = store.get('filters', {});
filters.forEach(f => {
  if (saved[f]) $(f).value = saved[f];
  $(f).onchange = () => {
    store.set('filters', Object.fromEntries(filters.map(k => [k, $(k).value])));
    if (lastQ) doSearch(lastQ);
  };
});
function doSearch(q) {
  lastQ = q;
  Tabs.show('search');
  searchList.start(page => API.search({
    q, within: $('fWithin').value, duration: $('fDur').value, order: $('fOrder').value, page
  }));
}

/* 上方輸入框：影片網址 → 播放；頻道網址 → 開頻道；其他 → 搜尋 */
$('bar').addEventListener('submit', e => {
  e.preventDefault();
  const s = $('q').value.trim();
  if (!s) return;
  $('q').blur();
  const id = App.parseId(s);
  if (id) { App.play(id); return; }
  const ch = s.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || s.match(/youtube\.com\/(@[\w.\-]+)/);
  if (ch) { openChannel(ch[1]); return; }
  doSearch(s);
});

/* ========== 頻道 ========== */
const chList = makeList($('chVideos'), $('moreCh'));
async function openChannel(ref) {
  Tabs.show('channel');
  $('chHead').innerHTML = statusHTML('載入中…');
  chList.clear();
  try {
    const c = await API.channel(ref);
    chInfo.set(c.id, c);
    Subs.update(c);
    const stats = [c.subs != null ? count(c.subs) + ' 位訂閱者' : '', c.videos ? count(c.videos) + ' 部影片' : '']
      .filter(Boolean).join(' · ');
    $('chHead').innerHTML = `<div class="chHead">${avatar(c)}
      <div class="info"><div class="name">${esc(c.title)}</div><div class="meta">${stats}</div></div>
      ${subBtn(c)}</div>`;
    chList.start(page => API.uploads(c.uploads, page));
  } catch (e) {
    $('chHead').innerHTML = statusHTML(e.message, true);
  }
}

/* ========== 設定 ========== */
$('apiKey').value = store.get('apiKey', '');
if (API.builtIn) {
  $('apiKey').placeholder = '已內建金鑰，不用貼（要換才貼）';
  $('keyStatus').textContent = '已使用內建金鑰，這台裝置不用再貼。';
}
$('keyForm').addEventListener('submit', async e => {
  e.preventDefault();
  const k = $('apiKey').value.trim();
  store.set('apiKey', k);
  const out = $('keyStatus');
  if (!k) { out.textContent = API.builtIn ? '已改回使用內建金鑰。' : '已清除金鑰。'; return; }
  out.textContent = '測試中…';
  try { await API.get('videos', { part: 'id', id: 'aqz-KE-bpKQ' }); out.textContent = '金鑰可以使用，已儲存。'; }
  catch (err) { out.textContent = err.message; }
});

/* ========== 點擊事件（統一處理） ========== */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-id],[data-ch],[data-sub],[data-unsub],[data-goto]');
  if (!t) return;
  if (t.dataset.id) App.play(t.dataset.id, cache.get(t.dataset.id));
  else if (t.dataset.ch) openChannel(t.dataset.ch);
  else if (t.dataset.sub) { const c = chInfo.get(t.dataset.sub); if (c) Subs.toggle(c); }
  else if (t.dataset.unsub) Subs.toggle({ id: t.dataset.unsub });
  else if (t.dataset.goto) Tabs.show(t.dataset.goto);
});

/* ========== 對外介面（給 series.js） ========== */
window.Browse = {
  API, makeList, Tabs, esc, statusHTML, card, cache, count, ago, openChannel,
  nowExtra: () => '',
  refreshNow: () => { if (nowV) showNow(nowV); }
};

/* ========== 起始畫面 ========== */
Subs.render();
$('results').innerHTML = statusHTML(API.key ? '在上方輸入關鍵字，按「搜尋」。' : 'NOKEY');
$('chHead').innerHTML = statusHTML('點「正在播放」的頻道名稱，或從「訂閱」選一個頻道。');
Tabs.show(API.key ? store.get('tab', 'search') : 'settings');
})();
