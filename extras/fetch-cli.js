#!/usr/bin/env node
'use strict';
/**
 * 一次性抓取今天的周榜/月榜并存档（供 GitHub Actions / Windows 计划任务调用）
 * 用法：node extras/fetch-cli.js   （在项目根目录执行）
 */
const path = require('path');
const lib = require('../lib/trending');

const ROOT = path.resolve(__dirname, '..');

(async () => {
  console.log('开始抓取 GitHub Trending …');
  const r = await lib.ensureToday(ROOT, false, console.log);
  console.log(JSON.stringify(r, null, 2));
  const failed = r.results.filter((x) => !x.ok);
  if (failed.length) {
    console.error(`有 ${failed.length} 项抓取失败`);
    process.exit(1);
  }
  console.log('全部完成 ✅');
})();
