'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');

// 800x480 虚拟扩展屏（Hyprland headless 输出）上的窗口表面尺寸问题：
// Chromium 若沿用主屏算出的 960x540 最小尺寸，合成器只能裁掉右下角，
// 用户看到的就是“界面被放大/比例异常”。下面几条保证修复不被回退。

test('linux minimum window size never exceeds the smallest connected display', () => {
  assert.match(main, /function getLinuxMinimumSizeCap\(\)/);
  assert.match(main, /if \(process\.platform !== 'linux'\) return null;/);
  assert.match(main, /smallest\.width - 60/);
  assert.match(main, /Math\.min\(base\.width, cap\.width\)/);
});

test('window surface is reconciled against the display it actually sits on', () => {
  assert.match(main, /function reconcileMainWindowSurface\(win\)/);
  assert.match(main, /win\.setContentSize\(targetWidth, targetHeight\)/);
  assert.match(main, /function scheduleMainWindowSurfaceReconcile\(/);
  // 移动/缩放后重新校正，避免合成器换屏后 Chromium 仍按旧尺寸绘制
  assert.match(main, /win\.on\('move'[\s\S]{0,160}scheduleMainWindowSurfaceReconcile/);
  assert.match(main, /win\.on\('resize'[\s\S]{0,160}scheduleMainWindowSurfaceReconcile/);
});

test('fullscreen on Linux keeps the window resizable and matches the output bounds', () => {
  assert.match(main, /if \(fullscreen && process\.platform === 'linux'\) return;/);
  assert.match(main, /function ensureFullscreenWindowMatchesDisplay\(win\)/);
  assert.match(main, /win\.on\('enter-full-screen'[\s\S]{0,400}syncFullscreenDisplayId\(win\)/);
});

test('wayland cannot report window position, so displays are matched by size', () => {
  assert.match(main, /function findDisplayByWindowSize\(bounds\)/);
  assert.match(main, /process\.platform === 'linux'[\s\S]{0,220}findDisplayByWindowSize\(bounds\)/);
  assert.match(main, /function syncFullscreenDisplayId\(win\)/);
});

test('leaving fullscreen restores the pre-fullscreen geometry', () => {
  assert.match(main, /let windowedBoundsBeforeFullscreen = null;/);
  assert.match(main, /windowedBoundsBeforeFullscreen = win\.getBounds\(\);/);
  assert.match(main, /const restored = windowedBoundsBeforeFullscreen;/);
});
