'use strict';

// 通过本机安装的汽水音乐（SodaMusic/Luna PC）客户端加载字节 bdms 设备签名模块，
// 为 /luna/pc/* 播放接口生成 X-Helios / X-Medusa 签名头（官方 PC 客户端同款方案）。
//
// 分发策略（方案A）：不打包任何字节专有二进制，仅当本机装有汽水音乐客户端时
// 从其安装目录动态加载 bdms.node；未检测到客户端时签名器不可用，调用方回退旧通道。

const fs = require('fs');
const path = require('path');

const SODA_PROGRAM_DIR = process.env.MINERADIO_QISHUI_SODA_DIR ||
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Soda Music');

const state = {
  loaded: false,
  available: false,
  modulePath: '',
  version: '',
  bdms: null,
  initializedDeviceId: '',
  loadError: '',
};

function compareVersionDesc(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
}

function readLauncherVersion(root) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'launcher_config.json'), 'utf8'));
    const version = String((config && config.cur_path) || '').trim();
    if (/^\d+\.\d+\.\d+$/.test(version)) return version;
  } catch (_) { /* 忽略 */ }
  return '';
}

function listInstalledVersions(root) {
  try {
    return fs.readdirSync(root)
      .filter(name => /^\d+\.\d+\.\d+$/.test(name))
      .sort(compareVersionDesc);
  } catch (_) {
    return [];
  }
}

// 定位 <安装目录>/<版本>/resources/app.asar.unpacked/bdms.node
function resolveBdmsModulePath(root) {
  if (!root || !fs.existsSync(root)) return null;
  const candidates = [];
  const launcherVersion = readLauncherVersion(root);
  if (launcherVersion) candidates.push(launcherVersion);
  candidates.push(...listInstalledVersions(root));
  for (const version of candidates) {
    const unpackedDir = path.join(root, version, 'resources', 'app.asar.unpacked');
    const modulePath = path.join(unpackedDir, 'bdms.node');
    try {
      if (!fs.existsSync(modulePath)) continue;
      fs.accessSync(modulePath, fs.constants.R_OK);
      return { modulePath, version };
    } catch (_) { /* 继续尝试 */ }
  }
  return null;
}

function loadBdms() {
  if (state.loaded) return state.bdms;
  state.loaded = true;
  try {
    const resolved = resolveBdmsModulePath(SODA_PROGRAM_DIR);
    if (!resolved) {
      state.loadError = '未检测到本机汽水音乐客户端（Soda Music）安装目录。';
      return null;
    }
    // require 同目录下 bdms.node；其伴生 DLL（metasecml.dll 等）位于同目录，
    // Windows 加载器按模块目录搜索，无需额外 PATH 设置。
    state.bdms = require(resolved.modulePath);
    state.modulePath = resolved.modulePath;
    state.version = resolved.version;
    state.available = typeof state.bdms.generateHttpSignatureHeaders === 'function';
    if (!state.available) state.loadError = 'bdms.node 缺少 generateHttpSignatureHeaders 导出。';
  } catch (err) {
    state.available = false;
    state.loadError = '加载 bdms.node 失败: ' + (err && err.message || String(err));
  }
  return state.available ? state.bdms : null;
}

// 从汽水扫码登录持久化文件读取设备 ID（与 qishui-auth-v6 同一身份源）
function loadDeviceId() {
  const candidates = [];
  if (process.env.QISHUI_QR_CONFIG_FILE) candidates.push(process.env.QISHUI_QR_CONFIG_FILE);
  candidates.push(path.join(__dirname, '.qishui-qr-login.json'));
  const appData = process.env.APPDATA;
  if (appData) candidates.push(path.join(appData, 'Mineradio', '.qishui-qr-login.json'));
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const deviceId = String(config && config.deviceId || '').trim();
      if (deviceId) return deviceId;
    } catch (_) { /* 尝试下一个 */ }
  }
  return '';
}

function ensureInitialized(deviceId) {
  const bdms = loadBdms();
  if (!bdms) return null;
  const id = String(deviceId || '').trim();
  if (!id) return null;
  if (state.initializedDeviceId !== id) {
    bdms.init({ deviceId: id });
    state.initializedDeviceId = id;
  }
  return bdms;
}

// 是否具备签名能力（找到了模块且能读到设备 ID）。
// 设置 MINERADIO_QISHUI_BDMS_SIGN=0 可强制关闭签名通道（单元测试用 mock https，需走旧通道）。
function isAvailable() {
  if (process.env.MINERADIO_QISHUI_BDMS_SIGN === '0') return false;
  return !!(ensureInitialized(loadDeviceId()));
}

// 官方客户端 app.ts 同款调用：headers 以 `key\r\nvalue` 行拼接后整体签名，
// 返回 `\r\n` 分隔的名值对文本。
function generateHttpSignatureHeaders(url, headerLines, deviceId) {
  const bdms = ensureInitialized(deviceId || loadDeviceId());
  if (!bdms) throw new Error('QISHUI_BDMS_UNAVAILABLE: ' + (state.loadError || '签名模块不可用'));
  return String(bdms.generateHttpSignatureHeaders(url, headerLines) || '');
}

function describe() {
  return {
    available: state.available,
    modulePath: state.modulePath,
    sodaVersion: state.version,
    deviceId: state.initializedDeviceId,
    loadError: state.loadError,
    sodaProgramDir: SODA_PROGRAM_DIR,
  };
}

module.exports = {
  SODA_PROGRAM_DIR,
  isAvailable,
  loadDeviceId,
  loadBdms,
  resolveBdmsModulePath,
  generateHttpSignatureHeaders,
  describe,
};
