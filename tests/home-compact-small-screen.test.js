'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'index.css'), 'utf8');

// 取出小屏紧凑布局所在的媒体查询块（文件末尾追加，按大括号配对截取）。
function compactBlock() {
  const start = css.indexOf('@media (max-height:620px), (max-width:900px)');
  assert.ok(start >= 0, 'missing compact media query for small screens');
  let depth = 0;
  let end = -1;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > start, 'compact media query block is not balanced');
  return css.slice(start, end + 1);
}

test('small screens keep the home dashboard inside an 800x480 viewport', () => {
  const block = compactBlock();
  // 首页改为纵向滚动，内容不再被裁切
  assert.match(block, /#empty-home\s*\{[^}]*overflow-y:\s*auto/);
  // 日期卡原本 min-height:420px，短屏必须解除
  assert.match(block, /#empty-home\s+\.daily-review-card\s*\{[^}]*min-height:\s*0/);
  // 外壳收紧为双列自动行高，避免 380px+560px 最小列宽撑破屏幕
  assert.match(block, /\.empty-home-shell[\s\S]*?grid-template-columns:\s*minmax\(0,\s*\.72fr\)\s*minmax\(0,\s*1\.28fr\)/);
  // 洞察区移到底部横跨两列
  assert.match(block, /\.home-insight-rail\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

test('compact quick cards keep titles readable instead of collapsing to a vertical strip', () => {
  const block = compactBlock();
  assert.match(block, /\.home-card-featured\s+\.home-card-title\s*\{[^}]*max-width:\s*calc\(100%\s*-\s*66px\)/);
  assert.match(block, /\.home-card-quick\s+\.home-card-title\s*\{[^}]*max-width:\s*calc\(100%\s*-\s*54px\)/);
  assert.match(block, /\.home-card-featured\s+\.home-card-art\s*\{[^}]*width:\s*46px/);
});

test('desktop reference sizes are untouched by the compact rules', () => {
  const start = css.indexOf('@media (max-height:620px), (max-width:900px)');
  const before = css.slice(0, start);
  assert.match(before, /#empty-home \.home-insight-dock \{[\s\S]*?min-height: 132px/);
  assert.doesNotMatch(before, /@media \(max-height:620px\)/);
});
