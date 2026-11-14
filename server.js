#!/usr/bin/env node
'use strict';
/**
 * GitHub 热榜 App — 零依赖后端
 *  - 每日定时抓取 GitHub Trending（周榜/月榜）并按日期存档到 data/
 *  - REST API：快照、日期/月份列表、排名对比、手动刷新
 *  - 托管 public/ 下的前端 PWA
 *
 * 环境变量：
 *  PORT          端口（默认 3210）
 *  HOST          监听地址（默认 0.0.0.0，供手机局域网访问）
 *  FETCH_TIME    每日自动抓取时间 HH:MM（默认 08:00，本机时区）
 *  REFRESH_TOKEN 设置后 /api/refresh 需要 ?token=xxx
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const lib = require('./lib/trending');

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const FETCH_TIME = (process.env.FETCH_TIME || '08:00').trim();
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || '';

const pad = (n) => String(n).padStart(2, '0');
const log = (...a) => {
  const d = new Date();
  console.log(`[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`, ...a);
};

/* ---------------- 工具 ---------------- */
function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 给快照补充排名变化信息（与上一份快照对比） */
function annotate(snap, prevSnap) {
  const prevMap = prevSnap ? new Map(prevSnap.repos.map((r) => [r.repo, r.rank])) : null;
  const repos = snap.repos.map((r) => {
    const prevRank = prevMap && prevMap.has(r.repo) ? prevMap.get(r.repo) : null;
    return {
      ...r,
      prevRank,
      isNew: prevMap ? !prevMap.has(r.repo) : false,
      rankChange: prevRank != null ? prevRank - r.rank : null,
    };
  });
  return { ...snap, repos, prevDate: prevSnap ? prevSnap.date : null };
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res, p) {
  const file = p === '/' ? '/index.html' : p;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.png' ? 'public, max-age=604800' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

/* ---------------- API ---------------- */
async function handleApi(req, res, u) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  const p = u.pathname.replace(/^\/api\/?/, '');
  const q = u.searchParams;

  if (p === 'status') {
    const day = lib.todayStr();
    const latest = {};
    const todayReady = {};
    const archives = {};
    for (const s of lib.SINCES) {
      const dates = lib.listDates(ROOT, s);
      archives[s] = dates.length;
      todayReady[s] = dates.includes(day);
      const snap = dates[0] ? lib.readSnap(ROOT, s, dates[0]) : null;
      latest[s] = snap ? { date: snap.date, fetchedAt: snap.fetchedAt, count: snap.count } : null;
    }
    return send(res, 200, {
      now: new Date().toISOString(),
      today: day,
      fetchTime: FETCH_TIME,
      latest,
      todayReady,
      archives,
    });
  }

  if (p === 'dates') {
    const since = lib.SINCES.includes(q.get('since')) ? q.get('since') : 'weekly';
    return send(res, 200, { since, dates: lib.listDates(ROOT, since) });
  }

  if (p === 'months') {
    return send(res, 200, { months: lib.monthsList(ROOT) });
  }

  if (p === 'list') {
    const since = lib.SINCES.includes(q.get('since')) ? q.get('since') : 'weekly';
    const dates = lib.listDates(ROOT, since);
    if (!dates.length) return send(res, 200, { since, date: null, repos: [], dates: [] });
    const date = dates.includes(q.get('date')) ? q.get('date') : dates[0];
    const snap = lib.readSnap(ROOT, since, date);
    const idx = dates.indexOf(date);
    const prev = idx + 1 < dates.length ? lib.readSnap(ROOT, since, dates[idx + 1]) : null;
    const out = annotate(snap, prev);

    // 飙升榜（日榜）附加信息：同时在周榜/月榜的排名、首次收录日期
    if (since === 'daily') {
      const weekSnap = lib.readSnap(ROOT, 'weekly', date);
      const wMap = weekSnap ? new Map(weekSnap.repos.map((r) => [r.repo, r.rank])) : null;
      const monthSnap = (() => {
        const m = lib.monthsList(ROOT).find((x) => date.startsWith(x.month));
        return m ? lib.readSnap(ROOT, 'monthly', m.date) : null;
      })();
      const mMap = monthSnap ? new Map(monthSnap.repos.map((r) => [r.repo, r.rank])) : null;
      const seenIdx = lib.readIndex(ROOT) || {};
      out.repos = out.repos.map((r) => ({
        ...r,
        weeklyRank: wMap ? wMap.get(r.repo) || null : null,
        monthlyRank: mMap ? mMap.get(r.repo) || null : null,
        firstSeen: seenIdx[r.repo] || date,
      }));
    }
    return send(res, 200, out);
  }

  // 月榜：某个月份取该月最新快照；排名与上一份月榜快照对比
  if (p === 'monthly') {
    const months = lib.monthsList(ROOT);
    if (!months.length) return send(res, 200, { month: null, date: null, repos: [], months: [] });
    const target = months.find((m) => m.month === q.get('month')) || months[0];
    const snap = lib.readSnap(ROOT, 'monthly', target.date);
    const allDates = lib.listDates(ROOT, 'monthly');
    const idx = allDates.indexOf(target.date);
    const prev = idx + 1 < allDates.length ? lib.readSnap(ROOT, 'monthly', allDates[idx + 1]) : null;
    return send(res, 200, { ...annotate(snap, prev), month: target.month, final: target.final });
  }

  if (p === 'refresh') {
    if (REFRESH_TOKEN && q.get('token') !== REFRESH_TOKEN) return send(res, 403, { error: '需要有效的 token' });
    log('收到手动刷新请求');
    const r = await lib.ensureToday(ROOT, true, log);
    return send(res, 200, r);
  }

  send(res, 404, { error: 'not found' });
}

/* ---------------- 服务 ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('method not allowed');
    }
    return serveStatic(res, u.pathname);
  } catch (e) {
    log('请求处理出错：', e.message);
    try {
      send(res, 500, { error: e.message });
    } catch {}
  }
});

/* ---------------- 每日定时任务 ---------------- */
let lastAutoDay = '';
let lastAttempt = 0;
function scheduleLoop() {
  const now = new Date();
  const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day = lib.todayStr(now);
  // 到点后如果当天数据缺失则抓取；失败每小时重试一次
  if (hm >= FETCH_TIME && lastAutoDay !== day && Date.now() - lastAttempt >= 3600e3) {
    const missing = lib.SINCES.some((s) => !lib.readSnap(ROOT, s, day));
    if (missing) {
      lastAttempt = Date.now();
      log(`到达每日抓取时间 ${FETCH_TIME}，自动抓取…`);
      lib
        .ensureToday(ROOT, false, log)
        .then((r) => {
          if (r.results.every((x) => x.ok)) lastAutoDay = day;
        })
        .catch(() => {});
    } else {
      lastAutoDay = day;
    }
  }
}

server.listen(PORT, HOST, () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) ips.push(it.address);
    }
  }
  console.log('================================================');
  console.log('  ✅ GitHub 热榜 App 已启动');
  console.log(`  本机访问:  http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  手机访问:  http://${ip}:${PORT}   （与电脑同一 Wi-Fi）`));
  console.log(`  每日自动抓取: ${FETCH_TIME}（环境变量 FETCH_TIME 可改）`);
  console.log('================================================');
  // 启动时如果当天数据缺失，立即补抓
  lib.ensureToday(ROOT, false, log).then(() => log('启动检查完成，数据已就绪')).catch(() => {});
});
setInterval(scheduleLoop, 30 * 1000);
process.on('unhandledRejection', (e) => log('未处理的 Promise 异常：', e && e.message));
process.on('uncaughtException', (e) => log('未捕获异常（服务继续运行）：', e && e.message));
