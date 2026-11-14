'use strict';
/* GitHub 热榜 App — 前端逻辑（PWA）
 * Tab: daily 飙升榜 / weekly 周榜 / monthly 月榜 / favs 收藏
 * 数据双模式：
 *  - API 模式：能连上自建服务（/api/status）→ 走 REST API
 *  - 云端模式：连不上服务（如部署在 GitHub Pages）→ 直接读 data/*.json 静态存档
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const PERIOD_LABEL = { daily: '飙升榜', weekly: '周榜', monthly: '月榜' };
const TABS = ['daily', 'weekly', 'monthly', 'favs'];

/* 常见语言颜色（GitHub Linguist），后端一般会带回官方色值，这里做兜底 */
const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Go: '#00ADD8',
  Rust: '#dea584', Java: '#b07219', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600',
  Vue: '#41b883', HTML: '#e34c26', CSS: '#563d7c', Shell: '#89e051', Ruby: '#701516',
  Swift: '#F05138', Kotlin: '#A97BFF', Dart: '#00B4AB', PHP: '#4F5D95', Lua: '#000080',
  Zig: '#ec915c', Svelte: '#ff3e00', 'Jupyter Notebook': '#DA5B0B', MDX: '#fcb32c',
  R: '#198CE7', MATLAB: '#e16737', PowerShell: '#012456', Nix: '#7e7eff',
  Haskell: '#5e5086', Elixir: '#6e4a7e', Scala: '#c22d40', Perl: '#0298c3',
  'Objective-C': '#438eff', Assembly: '#6E4C13', Julia: '#a270ba', Solidity: '#AA6746',
  Astro: '#ff5a03', GDScript: '#355570', Groovy: '#4298b8', Clojure: '#db5855',
};

const state = {
  tab: 'daily',       // daily | weekly | monthly | favs
  since: 'daily',
  weekDate: null,     // 周榜选中日期
  dayDate: null,      // 飙升榜选中日期
  month: null,        // 月榜选中月份
  dates: [], dailyDates: [], months: [],
  repos: [], meta: null,
  lang: '', q: '',
  offline: false,
  status: null,
};
const MODE = { api: null }; // null=探测中, true=自建服务, false=云端静态
let favs = [];
let deferredPrompt = null;
let loadSeq = 0; // 列表加载序号，防止快速切 Tab 后旧响应覆盖新数据

/* ---------------- 小工具 ---------------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n || 0).toLocaleString('en-US');
const kfmt = (n) => (n >= 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : fmtNum(n));
const pad = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const chipDate = (d) => { const dt = new Date(d + 'T00:00:00'); return `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${WEEKDAYS[dt.getDay()]}`; };
const fullDate = (d) => {
  const dt = new Date(d + 'T00:00:00');
  const y = dt.getFullYear() === new Date().getFullYear() ? '' : `${dt.getFullYear()}年`;
  return `${y}${dt.getMonth() + 1}月${dt.getDate()}日`;
};
const fmtMonth = (m) => { const [y, mo] = m.split('-'); return `${y}年${+mo}月`; };
const shortDate = (d) => (d ? d.slice(5) : '');
const curDate = () => (state.since === 'daily' ? state.dayDate : state.weekDate);

/** 带 30s 超时的 API 请求（refresh 可放宽） */
async function api(path, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('api/' + path, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2000);
}

/* ---------------- 模式探测与云端静态数据层 ---------------- */
async function detectMode() {
  if (MODE.api !== null) return MODE.api;
  try {
    await api('status', {}, 2500);
    MODE.api = true;
  } catch {
    MODE.api = false; // 没有自建服务 → 云端静态模式（GitHub Pages 等）
  }
  return MODE.api;
}

const fileCache = new Map();
/** 读取 data/ 下的静态 JSON（bust=true 时绕过内存缓存，用于手动刷新） */
async function dataFile(name, bust = false) {
  if (!bust && fileCache.has(name)) return fileCache.get(name);
  const res = await fetch('data/' + name, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  fileCache.set(name, j);
  return j;
}

/** 与后端 annotate() 对齐的本地排名对比 */
function annotateLocal(snap, prevSnap) {
  const prevMap = prevSnap ? new Map(prevSnap.repos.map((r) => [r.repo, r.rank])) : null;
  return {
    ...snap,
    prevDate: prevSnap ? prevSnap.date : null,
    repos: snap.repos.map((r) => ({
      ...r,
      prevRank: prevMap && prevMap.has(r.repo) ? prevMap.get(r.repo) : null,
      isNew: prevMap ? !prevMap.has(r.repo) : false,
      rankChange: prevMap && prevMap.has(r.repo) ? prevMap.get(r.repo) - r.rank : null,
    })),
  };
}

/** 云端模式：组装某期榜单（含排名对比与飙升榜交叉标注），返回结构与 API 一致 */
async function staticList(since, bust = false) {
  const cat = await dataFile('catalog.json', bust);

  if (since === 'monthly') {
    const months = cat.months || [];
    if (!months.length) return { since, month: null, repos: [], months };
    const target = months.find((m) => m.month === state.month) || months[0];
    const snap = await dataFile(`monthly-${target.date}.json`, bust);
    const older = months[months.indexOf(target) + 1];
    const prev = older ? await dataFile(`monthly-${older.date}.json`, bust).catch(() => null) : null;
    return { ...annotateLocal(snap, prev), month: target.month, final: target.final };
  }

  const dates = (since === 'daily' ? cat.dates.daily : cat.dates.weekly) || [];
  if (!dates.length) return { since, date: null, repos: [] };
  const sel = since === 'daily' ? state.dayDate : state.weekDate;
  const date = dates.includes(sel) ? sel : dates[0];
  const snap = await dataFile(`${since}-${date}.json`, bust);
  const older = dates[dates.indexOf(date) + 1];
  const prev = older ? await dataFile(`${since}-${older}.json`, bust).catch(() => null) : null;
  const out = annotateLocal(snap, prev);

  if (since === 'daily') {
    // 飙升榜交叉标注：同时在周榜/月榜的排名 + 首次收录
    const [weekSnap, monthSnap, seenIdx] = await Promise.all([
      dataFile(`weekly-${date}.json`, bust).catch(() => null),
      (async () => {
        const m = (cat.months || []).find((x) => date.startsWith(x.month));
        return m ? dataFile(`monthly-${m.date}.json`, bust).catch(() => null) : null;
      })(),
      dataFile('index.json', bust).catch(() => ({})),
    ]);
    const wMap = weekSnap ? new Map(weekSnap.repos.map((r) => [r.repo, r.rank])) : null;
    const mMap = monthSnap ? new Map(monthSnap.repos.map((r) => [r.repo, r.rank])) : null;
    out.repos = out.repos.map((r) => ({
      ...r,
      weeklyRank: wMap ? wMap.get(r.repo) || null : null,
      monthlyRank: mMap ? mMap.get(r.repo) || null : null,
      firstSeen: (seenIdx && seenIdx[r.repo]) || date,
    }));
  }
  return out;
}

/** 云端模式：把 catalog.json 规范化为与 /api/status 同构的状态对象 */
function statusFromCatalog(cat) {
  const daily = cat.dates.daily || [];
  const weekly = cat.dates.weekly || [];
  const months = cat.months || [];
  return {
    cloud: true,
    today: cat.today,
    fetchTime: cat.fetchTime,
    generatedAt: cat.generatedAt,
    repo: cat.repo || null,
    latest: {
      daily: daily[0] ? { date: daily[0] } : null,
      weekly: weekly[0] ? { date: weekly[0] } : null,
      monthly: months[0] ? { date: months[0].date } : null,
    },
    todayReady: {
      daily: daily.includes(cat.today),
      weekly: weekly.includes(cat.today),
      monthly: months.some((m) => m.month === cat.today.slice(0, 7)),
    },
    archives: { daily: daily.length, weekly: weekly.length, monthly: months.length },
  };
}

/** 「X 分钟/小时/天前」 */
function agoText(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}

/* ---------------- 主题 ---------------- */
function applyTheme(mode) {
  const t = mode || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = t;
  $('#btnTheme').textContent = t === 'dark' ? '☀️' : '🌙';
  LS.set('gh_theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'dark' ? '#0d1117' : '#f6f8fa';
}

/* ---------------- 收藏 ---------------- */
const isFav = (repo) => favs.some((f) => f.repo === repo);
function toggleFav(r) {
  if (isFav(r.repo)) {
    favs = favs.filter((f) => f.repo !== r.repo);
    toast('已取消收藏');
  } else {
    favs.unshift({
      repo: r.repo, owner: r.owner, name: r.name, url: r.url,
      description: r.description, language: r.language, langColor: r.langColor,
      stars: r.stars, periodStars: r.periodStars,
      periodLabel: PERIOD_LABEL[state.since] || state.since,
      snapDate: (state.meta && state.meta.date) || '',
      favAt: Date.now(),
    });
    toast('已收藏 ⭐');
  }
  LS.set('gh_favs', favs);
  state.tab === 'favs' ? renderFavs() : renderList();
}

/* ---------------- 数据加载 ---------------- */
async function loadMeta(bust = false) {
  if (MODE.api) {
    const [dw, dd, m, s] = await Promise.all([
      api('dates?since=weekly').catch(() => ({ dates: [] })),
      api('dates?since=daily').catch(() => ({ dates: [] })),
      api('months').catch(() => ({ months: [] })),
      api('status').catch(() => null),
    ]);
    state.dates = dw.dates || [];
    state.dailyDates = dd.dates || [];
    state.months = m.months || [];
    if (s) renderStatus(s);
  } else {
    const cat = await dataFile('catalog.json', bust).catch(() => null);
    if (!cat) {
      $('#updateInfo').textContent = '云端数据暂不可用 · 稍后自动重试';
      renderChips();
      return;
    }
    state.status = statusFromCatalog(cat);
    state.dates = cat.dates.weekly || [];
    state.dailyDates = cat.dates.daily || [];
    state.months = cat.months || [];
    renderStatus(state.status);
  }
  renderChips();
}

function renderStatus(s) {
  state.status = s;
  $('#btnCloud').hidden = !(s.cloud && s.repo); // ☁️ 仅云端模式且有仓库信息时显示
  const latest = ['daily', 'weekly', 'monthly']
    .map((k) => s.latest && s.latest[k]).filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const total = (s.archives.daily || 0) + (s.archives.weekly || 0) + (s.archives.monthly || 0);
  if (!latest) {
    $('#updateInfo').textContent = s.cloud
      ? '云端暂无存档 · 等首次抓取完成'
      : '尚未抓取数据 · 点右上角 ⟳ 立即抓取';
    return;
  }
  const ready = s.todayReady.daily || s.todayReady.weekly || s.todayReady.monthly;
  const prefix = s.cloud ? `云端数据 · 每日 ${s.fetchTime} 更新` : `每日 ${s.fetchTime} 自动抓取`;
  const fresh = s.generatedAt ? ` · 数据 ${agoText(s.generatedAt)}` : '';
  $('#updateInfo').textContent = `${prefix} · ${ready ? '今日已更新' : '今日待更新'} · 存档 ${total} 份${fresh}`;
}

const SKEL = '<div class="skel"></div>'.repeat(8);

async function loadList() {
  if (state.tab === 'favs') return renderFavs();
  const seq = ++loadSeq;

  // 默认选中最新一期
  if (state.since === 'daily' && !state.dayDate && state.dailyDates.length) state.dayDate = state.dailyDates[0];
  if (state.since === 'weekly' && !state.weekDate && state.dates.length) state.weekDate = state.dates[0];
  if (state.since === 'monthly' && !state.month && state.months.length) state.month = state.months[0].month;
  renderChips();

  const key = state.since === 'monthly'
    ? 'monthly:' + (state.month || 'latest')
    : state.since + ':' + (curDate() || 'latest');
  $('#offlineBadge').hidden = true;
  $('#summaryBar').innerHTML = '';
  $('#repoList').innerHTML = SKEL;
  state.offline = false;

  try {
    let data;
    if (MODE.api) {
      const q = state.since === 'monthly'
        ? 'monthly' + (state.month ? '?month=' + encodeURIComponent(state.month) : '')
        : `list?since=${state.since}` + (curDate() ? '&date=' + encodeURIComponent(curDate()) : '');
      data = await api(q);
    } else {
      data = await staticList(state.since);
    }
    if (seq !== loadSeq) return; // 已有更新的请求，丢弃本次结果
    state.repos = data.repos || [];
    state.meta = data;
    LS.set('gh_cache_' + key, data);
  } catch (e) {
    const cached = LS.get('gh_cache_' + key, null);
    if (seq !== loadSeq) return;
    if (cached) {
      state.repos = cached.repos || [];
      state.meta = cached;
      state.offline = true;
    } else {
      state.repos = [];
      state.meta = null;
      $('#repoList').innerHTML =
        `<div class="empty">加载失败：${esc(e.message)}<br><span>${MODE.api ? '请确认服务端已运行（node server.js）' : '云端数据暂时不可用，请稍后下拉重试'}</span><br><button class="primary" data-fetch>${MODE.api ? '重试 / 立即抓取' : '重新加载'}</button></div>`;
      return;
    }
  }
  if (seq !== loadSeq) return;
  renderList();
}

/* ---------------- 渲染 ---------------- */
function renderChips() {
  const box = $('#selectorChips');
  if (state.tab === 'favs') { box.innerHTML = ''; return; }
  const today = state.status && state.status.today;
  const mark = (d) => (d === today ? '<i class="tag">今日</i>' : '');
  if (state.since === 'monthly') {
    box.innerHTML = state.months.map((m) =>
      `<button class="chip${m.month === state.month ? ' active' : ''}" data-month="${m.month}">${fmtMonth(m.month)}${m.final ? '' : '<i class="tag">至今</i>'}</button>`).join('');
  } else {
    const dates = state.since === 'daily' ? state.dailyDates : state.dates;
    const sel = state.since === 'daily' ? state.dayDate : state.weekDate;
    box.innerHTML = dates.slice(0, 30).map((d) =>
      `<button class="chip${d === sel ? ' active' : ''}" data-date="${d}">${chipDate(d)}${mark(d)}</button>`).join('');
  }
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.repos.filter((r) => {
    if (state.lang && r.language !== state.lang) return false;
    if (!q) return true;
    return (r.repo + ' ' + (r.description || '')).toLowerCase().includes(q);
  });
}

function renderList() {
  const meta = state.meta || {};
  const repos = state.repos;
  $('#offlineBadge').hidden = !state.offline;

  // 语言筛选选项；当前选中语言不在本期列表时自动复位，避免"筛不出任何东西"的死区
  const langs = [...new Set(repos.map((r) => r.language).filter(Boolean))].sort();
  if (state.lang && !langs.includes(state.lang)) state.lang = '';
  const sel = $('#langSelect');
  sel.innerHTML = '<option value="">全部语言</option>' +
    langs.map((l) => `<option${l === state.lang ? ' selected' : ''}>${esc(l)}</option>`).join('');

  // 标题与汇总
  let title = '暂无数据';
  if (state.since === 'monthly' && meta.month) {
    title = `${fmtMonth(meta.month)} · 月榜 TOP ${repos.length}${meta.final ? '' : '（进行中）'}`;
  } else if (meta.date) {
    title = `${fullDate(meta.date)} · ${PERIOD_LABEL[state.since]} TOP ${repos.length}`;
  }
  const parts = [];
  if (meta.date) parts.push(`快照 ${meta.date}`);
  if (meta.prevDate) parts.push(`排名对比 ${shortDate(meta.prevDate)}`);
  if (state.since === 'daily' && repos.length) parts.push('按今日新增 ⭐ 排序');
  if (repos.length) parts.push(`本期合计 +${kfmt(repos.reduce((s, r) => s + (r.periodStars || 0), 0))} ⭐`);
  $('#summaryBar').innerHTML =
    `<div class="s-title">${esc(title)}</div>${parts.length ? `<div class="s-sub">${esc(parts.join(' · '))}</div>` : ''}`;

  const list = filtered();
  $('#repoList').innerHTML = list.length
    ? list.map((r, i) => cardHTML(r, i, { rank: true })).join('')
    : emptyHTML();
}

function emptyHTML() {
  const hasAnyArchive = state.since === 'monthly'
    ? state.months.length > 0
    : (state.since === 'daily' ? state.dailyDates : state.dates).length > 0;
  if (!state.repos.length && !hasAnyArchive) {
    return `<div class="empty">${MODE.api ? '服务器还没有存档数据' : '云端还没有存档数据'}<br><button class="primary" data-fetch>${MODE.api ? '立即抓取' : '重新加载'}</button></div>`;
  }
  if (state.q || state.lang) return '<div class="empty">没有符合筛选条件的项目</div>';
  return '<div class="empty">该期没有数据</div>';
}

function cardHTML(r, i, opts) {
  const fav = isFav(r.repo);
  const lc = r.langColor || LANG_COLORS[r.language] || '#8b949e';
  const isDaily = state.since === 'daily' && !opts.fav;
  const snapDate = state.meta && state.meta.date;

  // 飙升榜：日增速 = 今日新增 ÷ 原存量
  let growth = '';
  if (isDaily && r.periodStars && r.stars > r.periodStars) {
    const pct = (r.periodStars / (r.stars - r.periodStars)) * 100;
    growth = `<span class="badge up" title="今日新增 Star ÷ 原有 Star 数">⚡日增 ${pct.toFixed(1)}%</span>`;
  }
  // 飙升榜交叉标记：同时在周榜/月榜
  let cross = '';
  if (isDaily && r.weeklyRank) cross += `<span class="badge info" title="同时在本周周榜第 ${r.weeklyRank} 名">周榜 #${r.weeklyRank}</span>`;
  if (isDaily && r.monthlyRank) cross += `<span class="badge info" title="同时在本月月榜第 ${r.monthlyRank} 名">月榜 #${r.monthlyRank}</span>`;
  // 首次收录（此前从未在任何榜单出现）优先于 NEW（上一期快照没有）
  let fresh = '';
  if (isDaily && r.firstSeen && snapDate && r.firstSeen === snapDate) {
    fresh = '<span class="badge new" title="今天第一次被收录进任何榜单">首次收录</span>';
  } else if (r.isNew) {
    fresh = '<span class="badge new" title="上一期快照中没有该项目">NEW</span>';
  }

  const delta = r.isNew && fresh
    ? ''
    : r.rankChange > 0
      ? `<span class="badge up" title="上一期第 ${r.prevRank}">▲${r.rankChange}</span>`
      : r.rankChange < 0
        ? `<span class="badge down" title="上一期第 ${r.prevRank}">▼${-r.rankChange}</span>`
        : '';
  const gained = r.periodStars ? `<span class="gained" title="本期新增 Star">+${kfmt(r.periodStars)} ⭐</span>` : '';
  const head = opts.fav
    ? `<div class="rank idx">${i + 1}</div>`
    : `<div class="rank${r.rank <= 3 ? ' r' + r.rank : ''}">${r.rank}</div>`;
  return `<article class="card" data-url="${esc(r.url)}">
    ${head}
    <div class="c-body">
      <div class="c-title"><span class="owner">${esc(r.owner)} /</span> <b>${esc(r.name)}</b></div>
      ${r.description ? `<p class="c-desc">${esc(r.description)}</p>` : ''}
      <div class="c-meta">
        ${r.language ? `<span class="lang"><i style="background:${esc(lc)}"></i>${esc(r.language)}</span>` : ''}
        <span title="总 Star 数">★ ${fmtNum(r.stars)}</span>
        ${gained}
        ${isDaily ? growth + cross + fresh : delta}
      </div>
      ${opts.fav && r.periodLabel ? `<div class="c-from">收录自 ${esc(r.periodLabel)}${r.snapDate ? ' · 快照 ' + esc(r.snapDate) : ''}</div>` : ''}
    </div>
    <div class="c-ops">
      <button class="op fav${fav ? ' on' : ''}" data-fav="${esc(r.repo)}" title="收藏">${fav ? '★' : '☆'}</button>
      <button class="op" data-share="${esc(r.repo)}" title="分享">↗</button>
      ${opts.fav ? `<button class="op del" data-remove="${esc(r.repo)}" title="移除收藏">✕</button>` : ''}
    </div>
  </article>`;
}

function renderFavs() {
  $('#offlineBadge').hidden = true;
  $('#summaryBar').innerHTML =
    `<div class="s-title">收藏 ${favs.length} 个项目</div><div class="s-sub">保存在本机浏览器 · 点 ✕ 移除</div>`;
  $('#favList').innerHTML = favs.length
    ? favs.map((r, i) => cardHTML(r, i, { fav: true })).join('')
    : '<div class="empty">还没有收藏<br><span>在榜单卡片右侧点 ☆ 收藏喜欢的项目</span></div>';
}

/* ---------------- 动作 ---------------- */
function switchTab(tab, initial = false) {
  if (!TABS.includes(tab)) tab = 'daily';
  state.tab = tab;
  if (tab !== 'favs') state.since = tab;
  $('#view-list').hidden = tab === 'favs';
  $('#view-favs').hidden = tab !== 'favs';
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  location.hash = tab;
  if (tab === 'favs') renderFavs();
  else loadList();
}

async function doRefresh() {
  if (doRefresh._busy) return; // 抓取中忽略重复触发
  doRefresh._busy = true;
  const btn = $('#btnRefresh');
  const ptr = $('#ptr');
  btn.classList.add('spinning');
  ptr.classList.add('show');
  try {
    if (MODE.api) {
      await api('refresh', { method: 'POST' }, 120000);
      toast('已重新抓取');
    } else {
      fileCache.clear();
      await loadMeta(true);
      toast('已刷新（云端模式）');
    }
  } catch (e) {
    toast('刷新失败：' + e.message);
  }
  btn.classList.remove('spinning');
  ptr.classList.remove('show');
  doRefresh._busy = false;
  await loadList();
}

async function share(r) {
  if (navigator.share) {
    try {
      await navigator.share({ title: r.repo, text: `${r.repo} — GitHub 热榜`, url: r.url });
      return;
    } catch {}
  }
  try {
    await navigator.clipboard.writeText(r.url);
    toast('链接已复制');
  } catch {
    toast('复制失败');
  }
}

/* ---------------- 事件 ---------------- */
function bindEvents() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#btnTheme').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#btnRefresh').addEventListener('click', doRefresh);
  $('#btnCloud').addEventListener('click', () => {
    const repo = state.status && state.status.repo;
    if (!repo) { toast('当前模式无需云端抓取'); return; }
    window.open(`https://github.com/${repo}/actions/workflows/daily.yml`, '_blank', 'noopener');
    toast('在新页面点「Run workflow」即可立即抓取');
  });
  $('#btnInfo').addEventListener('click', () => {
    if (state.status) $('#infoFetchTime').textContent = state.status.fetchTime;
    $('#modal').hidden = false;
  });
  $('#btnCloseModal').addEventListener('click', () => { $('#modal').hidden = true; });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });
  $('#btnClearCache').addEventListener('click', () => {
    Object.keys(localStorage).filter((k) => k.startsWith('gh_cache_')).forEach((k) => LS.del(k));
    toast('本地缓存已清除');
  });
  $('#tipClose').addEventListener('click', () => { $('#tipbar').hidden = true; LS.set('gh_tip_dismissed', true); });
  $('#btnInstall').addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt = null;
      $('#btnInstall').hidden = true;
    }
  });

  $('#searchInput').addEventListener('input', (e) => {
    state.q = e.target.value;
    renderList();
  });
  $('#langSelect').addEventListener('change', (e) => {
    state.lang = e.target.value;
    renderList();
  });
  $('#selectorChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    if (c.dataset.date) {
      if (state.since === 'daily') state.dayDate = c.dataset.date;
      else state.weekDate = c.dataset.date;
    }
    if (c.dataset.month) state.month = c.dataset.month;
    loadList();
  });

  const findRepo = (repo) =>
    state.repos.find((x) => x.repo === repo) || favs.find((x) => x.repo === repo);
  const listClick = (e) => {
    if (e.target.classList.contains('c-desc')) { e.target.classList.toggle('open'); return; }
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      const r = findRepo(favBtn.dataset.fav);
      if (r) toggleFav(r);
      return;
    }
    const shareBtn = e.target.closest('[data-share]');
    if (shareBtn) {
      const r = findRepo(shareBtn.dataset.share);
      if (r) share(r);
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      favs = favs.filter((x) => x.repo !== rm.dataset.remove);
      LS.set('gh_favs', favs);
      renderFavs();
      toast('已移除');
      return;
    }
    if (e.target.closest('[data-fetch]')) return doRefresh();
    const card = e.target.closest('.card[data-url]');
    if (card) window.open(card.dataset.url, '_blank', 'noopener');
  };
  $('#repoList').addEventListener('click', listClick);
  $('#favList').addEventListener('click', listClick);

  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (TABS.includes(h) && h !== state.tab) switchTab(h);
  });

  // 下拉刷新
  let ptrStart = null;
  const main = $('#main');
  main.addEventListener('touchstart', (e) => {
    ptrStart = window.scrollY <= 0 ? { y: e.touches[0].clientY, pull: 0 } : null;
  }, { passive: true });
  main.addEventListener('touchmove', (e) => {
    if (!ptrStart) return;
    const dy = e.touches[0].clientY - ptrStart.y;
    if (dy > 0 && window.scrollY <= 0) {
      ptrStart.pull = Math.min(dy, 140);
      const ptr = $('#ptr');
      ptr.style.transform = `translate(-50%, ${ptrStart.pull * 0.4 - (ptrStart.pull > 60 ? 0 : 60)}px)`;
      ptr.classList.add('show');
    }
  }, { passive: true });
  main.addEventListener('touchend', () => {
    if (ptrStart && ptrStart.pull > 60) doRefresh();
    ptrStart = null;
    const ptr = $('#ptr');
    ptr.style.transform = '';
    ptr.classList.remove('show');
  });
}

/* ---------------- 启动 ---------------- */
async function init() {
  applyTheme(LS.get('gh_theme', null));
  favs = LS.get('gh_favs', []);
  bindEvents();

  try {
    if (window.isSecureContext && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  } catch {}
  if (!LS.get('gh_tip_dismissed', false)) $('#tipbar').hidden = false;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('#btnInstall').hidden = false;
  });

  await detectMode();
  await loadMeta();
  const h = location.hash.replace('#', '');
  switchTab(TABS.includes(h) ? h : 'daily', true);
}

init();
