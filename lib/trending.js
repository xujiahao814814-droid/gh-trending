'use strict';
/**
 * GitHub Trending 抓取 / 解析 / 存档（零依赖）
 * 供 server.js 与 extras/fetch-cli.js 共用
 *
 * 网络策略（针对国内直连 GitHub 不稳定的场景）：
 *  1. GH_PROXY 环境变量指定的代理（如 http://127.0.0.1:7890）
 *  2. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 环境变量
 *  3. Windows 系统代理（注册表 Internet Settings）
 *  4. 直连
 * 按顺序尝试，失败自动切换，成功后记住可用通道（进程内）。
 */
const net = require('net');
const tls = require('tls');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SINCES = ['daily', 'weekly', 'monthly']; // 飙升(日榜) / 周榜 / 月榜
const TOP_N = 20;

const pad = (n) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/* ---------------- 代理探测 ---------------- */
function getRegistryProxy() {
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const en = execSync(`reg query "${key}" /v ProxyEnable`, { timeout: 3000 }).toString();
    if (!/0x1/.test(en)) return null;
    const ps = execSync(`reg query "${key}" /v ProxyServer`, { timeout: 3000 }).toString();
    const m = ps.match(/REG_SZ\s+(\S+)/);
    if (!m) return null;
    let v = m[1];
    if (v.includes(';')) {
      // 形如 http=...;https=...;socks=...，取 https 或 http 的
      const mm = v.match(/(?:^|;)https=(\S+)/i) || v.match(/(?:^|;)http=(\S+)/i);
      if (!mm) return null;
      v = mm[1];
    }
    if (/^socks/i.test(v)) return null; // socks 暂不支持
    return v.startsWith('http') ? v : 'http://' + v;
  } catch {
    return null;
  }
}

/** 候选通道列表：[proxy or null(direct)...] */
function buildCandidates() {
  const list = [];
  const push = (p) => { if (p && !list.includes(p)) list.push(p); };
  push(process.env.GH_PROXY || null);
  push(process.env.HTTPS_PROXY || process.env.https_proxy || null);
  push(process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || null);
  push(getRegistryProxy());
  list.push(null); // 直连兜底
  return list;
}

let goodProxy; // undefined=未知, null=直连可用, string=代理可用
function candidateOrder() {
  const all = buildCandidates();
  if (goodProxy === undefined) return all;
  // 上次成功的通道优先
  return [goodProxy, ...all.filter((c) => c !== goodProxy)];
}
const describe = (p) => (p ? `代理 ${p}` : '直连');

/* ---------------- 极简 HTTP 客户端（支持经代理的 HTTPS CONNECT 隧道） ---------------- */
function socketRequest(target, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const port = +target.port || (isHttps ? 443 : 80);
    let socket;

    const fail = (err) => {
      try { socket && socket.destroy(); } catch {}
      reject(err);
    };
    const startReq = (sock) => {
      sock.setTimeout(timeoutMs, () => fail(new Error('请求超时')));
      sock.on('error', fail);
      const hostHeader = port === (isHttps ? 443 : 80) ? target.hostname : `${target.hostname}:${port}`;
      sock.write(
        `GET ${target.pathname}${target.search} HTTP/1.0\r\n` +
        `Host: ${hostHeader}\r\n` +
        `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36\r\n` +
        `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n` +
        `Accept-Language: en-US,en;q=0.9\r\n` +
        `Connection: close\r\n\r\n`
      );
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks)));
    };

    if (!proxy) {
      // 直连
      if (isHttps) {
        socket = tls.connect({ host: target.hostname, port, servername: target.hostname }, () => startReq(socket));
        socket.on('error', fail); // tls 握手失败
      } else {
        socket = net.connect({ host: target.hostname, port }, () => startReq(socket));
      }
      return;
    }

    // 经 HTTP 代理 CONNECT 隧道
    let ph = proxy.replace(/^https?:\/\//, '');
    ph = ph.split('@').pop(); // 去掉可能的 user:pass@
    const pPort = ph.includes(':') ? +ph.split(':')[1] || 80 : 80;
    const pHost = ph.split(':')[0];
    const raw = net.connect({ host: pHost, port: pPort });
    socket = raw;
    raw.setTimeout(timeoutMs, () => fail(new Error('代理连接超时')));
    raw.on('error', fail);
    raw.on('connect', () => {
      raw.write(`CONNECT ${target.hostname}:${port} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\n\r\n`);
    });
    let buf = '';
    raw.on('data', function onData(d) {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(buf)) {
        return fail(new Error(`代理 CONNECT 失败：${buf.split('\r\n')[0]}`));
      }
      if (isHttps) {
        const ts = tls.connect({ socket: raw, servername: target.hostname }, () => startReq(ts));
        socket = ts;
        ts.on('error', fail);
      } else {
        startReq(raw);
      }
    });
  });
}

/** 抓取 URL 文本，自动处理重定向（最多 4 次） */
async function fetchText(url, depth = 0) {
  if (depth > 4) throw new Error('重定向次数过多');
  let lastErr = null;
  for (const proxy of candidateOrder()) {
    try {
      const raw = await socketRequest(new URL(url), proxy, 30000);
      const sep = raw.indexOf('\r\n\r\n');
      const head = raw.slice(0, sep < 0 ? 0 : sep).toString();
      let body = sep < 0 ? Buffer.alloc(0) : raw.slice(sep + 4);
      const status = parseInt((head.match(/^HTTP\/[\d.]+ (\d{3})/) || [])[1] || 0, 10);
      // HTTP/1.0 + Connection:close 理论上无 chunked，但部分代理仍会强制使用且不加头；
      // 头未标注时按「体首为十六进制块大小行」特征识别（注意：块大小是字节数，必须在 Buffer 域处理）
      if (/transfer-encoding:\s*chunked/i.test(head) || /^[0-9a-fA-F]{1,8}\r\n/.test(body.toString('latin1', 0, 16))) {
        body = dechunk(body);
      }
      if (status >= 301 && status <= 308) {
        const loc = (head.match(/location:\s*(\S+)/i) || [])[1];
        if (!loc) throw new Error(`重定向缺少 Location（HTTP ${status}）`);
        return fetchText(new URL(loc, url).href, depth + 1);
      }
      if (status !== 200) throw new Error(`GitHub 返回 HTTP ${status}`);
      goodProxy = proxy;
      return body.toString('utf8');
    } catch (e) {
      lastErr = e;
      // 换下一个通道重试
    }
  }
  throw new Error(`所有网络通道均失败（${lastErr ? lastErr.message : '未知错误'}）`);
}

/** 按 HTTP chunked 规范在字节域重组 body（块大小为字节数，与字符数不同） */
function dechunk(buf) {
  const parts = [];
  let i = 0;
  for (;;) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const line = buf.slice(i, nl).toString('latin1').split(';')[0].trim();
    const size = parseInt(line, 16);
    if (!Number.isFinite(size)) return buf; // 无法解析，按原文返回
    if (size === 0) break;
    parts.push(buf.slice(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/* ---------------- 解析 ---------------- */
function decodeHTML(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}
const stripTags = (s) => decodeHTML(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const toInt = (s) => (s ? parseInt(String(s).replace(/,/g, ''), 10) || 0 : 0);

function parseTrending(html) {
  const repos = [];
  const parts = html.split(/<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>/);
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i].split('</article>')[0];

    // 仓库全名：优先取 h2 里的第一个链接
    let full = null;
    const h2m = seg.match(/<h2[\s\S]{0,600}?<a[^>]+href="\/([\w.-]+\/[\w.-]+)"/);
    if (h2m) full = h2m[1];
    else {
      const fm = seg.match(/href="\/([\w.-]+\/[\w.-]+)"/);
      if (fm) full = fm[1];
    }
    if (!full) continue;
    const [owner, name] = full.split('/');

    const descM = seg.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/) || seg.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const langM = seg.match(/itemprop="programmingLanguage">\s*([^<]+?)\s*</);
    const langColorM = seg.match(/repo-language-color" style="background-color:\s*(#[0-9a-fA-F]{3,8})/);
    const starM = seg.match(/href="\/[^"]+\/stargazers"[\s\S]*?<\/svg>\s*([\d,]+)\s*</);
    const forkM = seg.match(/href="\/[^"]+\/forks"[\s\S]*?<\/svg>\s*([\d,]+)\s*</);
    const periodM = seg.match(/float-sm-right[\s\S]{0,3000}?<\/svg>\s*([\d,]+)\s+stars?\s+([a-z ]+)\s*</i);

    repos.push({
      repo: full,
      owner: decodeHTML(owner),
      name: decodeHTML(name),
      url: 'https://github.com/' + full,
      description: descM ? stripTags(descM[1]) : '',
      language: langM ? decodeHTML(langM[1]) : '',
      langColor: langColorM ? langColorM[1] : '',
      stars: toInt(starM && starM[1]),
      forks: toInt(forkM && forkM[1]),
      periodStars: toInt(periodM && periodM[1]), // 本期（本周/本月）新增 Star
    });
  }
  return repos.slice(0, TOP_N);
}

/* ---------------- 存档 ---------------- */
const dataDirOf = (root) => path.join(root, 'data');
const snapFile = (root, since, date) => path.join(dataDirOf(root), `${since}-${date}.json`);

function readSnap(root, since, date) {
  try {
    return JSON.parse(fs.readFileSync(snapFile(root, since, date), 'utf8'));
  } catch {
    return null;
  }
}

/** 该周期所有快照日期，倒序（新 → 旧） */
function listDates(root, since) {
  const dir = dataDirOf(root);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${since}-`) && f.endsWith('.json'))
      .map((f) => f.slice(since.length + 1, -5))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 月榜可用月份：每月取该月最新一次快照；已结束的月份标记 final */
function monthsList(root) {
  const cur = todayStr().slice(0, 7);
  const seen = new Map();
  for (const d of listDates(root, 'monthly')) {
    const m = d.slice(0, 7);
    if (!seen.has(m)) seen.set(m, { month: m, date: d, final: m < cur });
  }
  return [...seen.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/* ---------------- 首见索引（data/index.json：repo -> 首次收录日期） ---------------- */
const indexFile = (root) => path.join(dataDirOf(root), 'index.json');

function readIndex(root) {
  try {
    return JSON.parse(fs.readFileSync(indexFile(root), 'utf8'));
  } catch {
    // 索引缺失时从存档重建并落盘，保证后续读取 O(1)
    const idx = buildIndexFromArchive(root);
    try {
      fs.writeFileSync(indexFile(root), JSON.stringify(idx));
    } catch {}
    return idx;
  }
}

/** 索引缺失时，从全部历史存档重建（旧 → 新，取最早出现日期） */
function buildIndexFromArchive(root) {
  const idx = {};
  for (const since of SINCES) {
    const dates = listDates(root, since).reverse(); // 新 → 旧 → 翻转为旧 → 新
    for (const date of dates) {
      const snap = readSnap(root, since, date);
      for (const r of (snap && snap.repos) || []) if (!idx[r.repo]) idx[r.repo] = date;
    }
  }
  return idx;
}

/** 把今天抓到的仓库并入索引，返回最新索引 */
function updateIndex(root, repos, date) {
  const idx = readIndex(root);
  let changed = false;
  for (const r of repos) {
    if (!idx[r.repo]) {
      idx[r.repo] = date;
      changed = true;
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(indexFile(root), JSON.stringify(idx));
    } catch {}
  }
  return idx;
}

/** 生成云端目录清单 data/catalog.json（GitHub Pages 静态模式用） */
function writeCatalog(root) {
  const catalog = {
    generatedAt: new Date().toISOString(),
    today: todayStr(),
    fetchTime: (process.env.FETCH_TIME || '08:00').trim(),
    dates: { daily: listDates(root, 'daily'), weekly: listDates(root, 'weekly') },
    months: monthsList(root),
  };
  try {
    fs.writeFileSync(path.join(dataDirOf(root), 'catalog.json'), JSON.stringify(catalog));
  } catch {}
  return catalog;
}

/* ---------------- 抓取当天 ---------------- */
async function fetchTrending(since, root) {
  if (!SINCES.includes(since)) throw new Error('since 必须是 weekly 或 monthly');
  const html = await fetchText(`https://github.com/trending?since=${since}`);
  const repos = parseTrending(html);
  if (!repos.length) {
    if (root) {
      try {
        fs.mkdirSync(dataDirOf(root), { recursive: true });
        fs.writeFileSync(path.join(dataDirOf(root), `_debug-${since}.html`), html);
      } catch {}
    }
    throw new Error(`页面解析结果为空（GitHub 可能改版，原始页面已存到 data/_debug-${since}.html 供排查）`);
  }
  return repos;
}

/** 抓取并保存今天的快照（已有且非 force 则跳过） */
async function ensureToday(root, force = false, log = () => {}) {
  fs.mkdirSync(dataDirOf(root), { recursive: true });
  const date = todayStr();
  const results = [];
  try {
    for (const since of SINCES) {
      if (readSnap(root, since, date) && !force) {
        results.push({ since, date, ok: true, skipped: true });
        continue;
      }
      try {
        const raw = await fetchTrending(since, root);
        const repos = raw.map((r, i) => ({ rank: i + 1, ...r }));
        const snap = { since, date, fetchedAt: new Date().toISOString(), count: repos.length, repos };
        fs.writeFileSync(snapFile(root, since, date), JSON.stringify(snap, null, 1));
        updateIndex(root, repos, date);
        results.push({ since, date, ok: true, count: repos.length });
        log(`已抓取 ${since} ${date}：${repos.length} 个项目（${describe(goodProxy)}）`);
      } catch (e) {
        results.push({ since, date, ok: false, error: e.message });
        log(`抓取失败 ${since}：${e.message}`);
      }
    }
  } finally {
    writeCatalog(root); // 无论成败都刷新云端目录清单
  }
  return { results };
}

module.exports = {
  SINCES,
  TOP_N,
  todayStr,
  fetchText,
  parseTrending,
  fetchTrending,
  ensureToday,
  readSnap,
  listDates,
  monthsList,
  readIndex,
  updateIndex,
  writeCatalog,
  snapFile,
  dataDirOf,
  describe,
};
