# GitHub 热榜 App

一个在手机上使用的 GitHub 热榜应用：**每天自动抓取 GitHub Trending 周榜 / 月榜 TOP 20**，支持历史快照回看、按月归档、收藏、深浅色主题、离线缓存，以 PWA 形式「安装」到手机主屏幕，像原生 App 一样全屏使用。

零依赖 —— 只需要 Node.js（≥18），无需 `npm install`。

---

## 快速开始

```bat
:: Windows：直接双击 start.bat
:: 或手动启动：
cd github-trending-app
node server.js
```

启动后会打印类似：

```
✅ GitHub 热榜 App 已启动
  本机访问:  http://localhost:3210
  手机访问:  http://192.168.x.x:3210   （与电脑同一 Wi-Fi）
  每日自动抓取: 08:00
```

手机与电脑连同一 Wi-Fi，用手机浏览器打开「手机访问」地址即可。

### 安装到手机主屏幕（像 App 一样）

- **Android（Chrome）**：右上角菜单 → 「添加到主屏幕 / 安装应用」
- **iPhone（Safari）**：底部「分享」按钮 → 「添加到主屏幕」

安装后有独立图标、全屏无地址栏，断网时还能查看最近一次缓存的数据。

> ⚠️ 服务端要一直开着手机才能看到最新数据；电脑不方便常开？做一次下面的「云端模式」部署即可彻底摆脱电脑。

## 功能

| 功能 | 说明 |
|---|---|
| 🚀 飙升榜 | **收藏量涨得最快的项目独立板块**：今日新增 Star 最快（官方日榜）TOP 20，标注 ⚡日增速（今日新增 ÷ 原有存量）、「首次收录」（此前从未出现在任何榜单，基于自建首见索引）、「周榜 #N / 月榜 #N」交叉在榜标记 |
| 🔥 周榜 | 最近 7 天新增 Star 前 20，保留每日历史快照，可切换任意一天回看 |
| 📅 月榜 | 本自然月至今新增 Star 前 20；**按月归档**，历史月份可回看（已结束月份取该月最后一次快照为最终榜单） |
| ▲▼ 排名变化 | 每期榜单与上一期快照对比：▲上升 / ▼下降 / NEW 新上榜 |
| +⭐ 期榜热度 | 每个项目显示本期（今日/本周/本月）新增 Star 数，汇总显示整期热度 |
| ⭐ 收藏 | 收藏喜欢的项目到本机（localStorage），收藏页显示收录来源（飙升榜/周榜/月榜） |
| 🔍 搜索筛选 | 按项目名/描述搜索，按语言筛选（切榜后语言选项自动复位，避免空结果死区） |
| 🌗 深浅色 | 跟随系统，也可手动切换 |
| 📴 离线兜底 | Service Worker 缓存应用外壳；接口失败时回退到最近一次本地缓存数据 |
| 🔄 手动刷新 | 顶栏 ⟳ 或页面下拉即可重新抓取（进行中防重复触发，120s 超时保护） |

## 每日自动抓取

- 服务进程内置定时器：每天到达 `FETCH_TIME`（默认 08:00）后，若当天快照缺失则自动抓取三榜（飙升/周/月）；失败会每小时重试。
- 启动时若发现当天数据缺失，会立即补抓一次。
- 快照按日期存档为 JSON：`data/daily-2026-11-14.json`、`data/weekly-2026-11-14.json`、`data/monthly-2026-11.json`。
- 同时维护 `data/index.json`（仓库 → 首次收录日期），用于飙升榜「首次收录」标记；索引缺失时自动从历史存档重建。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3210` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址（手机局域网访问需要） |
| `FETCH_TIME` | `08:00` | 每日自动抓取时间（本机时区 HH:MM） |
| `REFRESH_TOKEN` | 空 | 设置后 `/api/refresh` 需带 `?token=xxx`，防止被随意触发 |
| `GH_PROXY` | 自动 | 强制使用的 HTTP 代理，如 `http://127.0.0.1:7890` |

### GitHub 访问不动了？

抓取器按以下顺序自动选择网络通道，失败自动切换并记住可用通道：

1. `GH_PROXY` 环境变量
2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量
3. Windows 系统代理（注册表读取，如 Clash/v2rayN 的 `127.0.0.1:xxxx`）
4. 直连

所以：开着你的代理软件（系统代理模式）通常即可正常抓取；也可以用 `GH_PROXY` 显式指定。

## 常驻运行

- **Windows**：`start.bat` 最小化挂着即可；需要开机自启可用任务计划程序（操作：`node`，参数：`server.js`，起始于项目目录）。
- **Linux / NAS / 树莓派**：`nohup node server.js &`，或用 pm2 / systemd 托管。
- **电脑不方便常开？** 见下面的「云端模式：电脑关机也能看」，一次性部署到 GitHub Pages 后手机直接访问，无需电脑。

## 云端模式：电脑关机也能看

App 支持**双数据模式**，打开时自动判断：

- **API 模式**：能连上自建服务（如电脑开着 `node server.js`）→ 走实时 API
- **云端模式**：连不上服务（如部署在 GitHub Pages）→ 直接读取 `data/` 下的静态 JSON 存档

云端模式由 GitHub Actions 全自动维护：每天约 07:00（北京时间）抓取三榜 → 提交存档到仓库 → 重新发布网站。

### 一次性部署步骤（约 2 分钟）

1. 在 GitHub 上新建一个**公开**仓库（如 `gh-trending`），把本项目整个推上去：
   ```bat
   cd github-trending-app
   git init && git add . && git commit -m "init"
   git remote add origin https://github.com/你的用户名/gh-trending.git
   git push -u origin main
   ```
2. 把 `extras/github-actions-daily.yml` 复制为 `.github/workflows/daily.yml`（保持推送到仓库）
3. 仓库 **Settings → Pages → Build and deployment → Source 选「GitHub Actions」**
4. 打开仓库 Actions 页 → 选 `daily-trending-archive` → **Run workflow** 手动触发一次

完成后手机浏览器访问 `https://你的用户名.github.io/gh-trending/`，「添加到主屏幕」即可。
之后每天自动更新，电脑永远不用开机（想换更新时间改 yml 里的 cron）。

> 提示：GitHub Actions 的定时任务可能延迟几分钟到半小时；数据文件在设备上有网络优先 + 离线兜底缓存。

## API

| 接口 | 说明 |
|---|---|
| `GET /api/status` | 服务状态：最近抓取时间、今日是否就绪、三榜存档数 |
| `GET /api/list?since=daily\|weekly\|monthly&date=YYYY-MM-DD` | 某天飙升榜/周榜（缺省最新），含与上一期排名对比；`daily` 额外带 `weeklyRank`/`monthlyRank`/`firstSeen` |
| `GET /api/monthly?month=YYYY-MM` | 某月月榜（缺省最新） |
| `GET /api/dates?since=daily\|weekly` | 对应榜单可用快照日期 |
| `GET /api/months` | 月榜可用月份（含是否已结束） |
| `POST /api/refresh[?token=]` | 强制重新抓取今日三榜 |

## 项目结构

```
github-trending-app/
├─ server.js               # 后端：API + 静态托管 + 定时任务
├─ lib/trending.js         # 抓取/解析/存档（含代理自适应、chunked 重组、catalog 生成）
├─ public/                 # 前端 PWA（index/app.js/styles.css/sw.js/manifest/图标，双数据模式）
├─ tools/gen-icons.js      # 图标生成脚本（node tools/gen-icons.js 可重新生成）
├─ extras/fetch-cli.js     # 一次性抓取 CLI（供 GitHub Actions / 计划任务）
├─ extras/github-actions-daily.yml   # 云端方案：每日抓取 + 自动发布 GitHub Pages
├─ start.bat               # Windows 一键启动
└─ data/                   # 快照存档（自动生成：三榜 JSON + index.json 首见索引 + catalog.json 云端清单）
```

## 常见问题

- **榜单只有 12~15 个项目，不是 20？** GitHub Trending 页面当天只展示这么多（通常 25 个以内浮动），程序取页面实际条数的前 20。
- **「首次收录」为什么刚上线时全是今天？** 首见索引从开始存档那天建立，此前没有历史数据；运行几天后标记就只出现在真正的新项目上。
- **改了前端文件没生效？** 已安装 PWA 的设备受 Service Worker 缓存影响，递增 `public/sw.js` 里的 `CACHE` 版本号后刷新两次即可。
- **云端模式下页面显示「云端数据暂不可用」？** 说明 Pages 已发布但 `data/` 还没有存档：到仓库 Actions 页手动触发一次 `daily-trending-archive` 即可。
- **想重置所有数据？** 停掉服务，删除 `data/` 目录，重新启动会自动补抓当天（首见索引、catalog 也会随之重建）。
