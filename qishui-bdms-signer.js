'use strict';

// 通过本机安装的汽水音乐（SodaMusic/Luna PC）客户端加载字节 bdms 设备签名模块，
// 为 /luna/pc/* 播放接口生成 X-Helios / X-Medusa 签名头（官方 PC 客户端同款方案）。
//
// 分发策略（方案A）：不打包任何字节专有二进制，仅当本机装有汽水音乐客户端时
// 从其安装目录动态加载 bdms.node；未检测到客户端时签名器不可用，调用方回退旧通道。
//
// 远程签名后端（Linux 等非 Windows 平台）：设置 MINERADIO_QISHUI_SIGNER_URL（或
// QISHUI_SIGNER_URL，兼容 libresoda/libmssdk 约定）后，签名请求转由远程 HTTP 服务
// （如 sodahub-org/libmssdk，可在 Windows 机器上原生加载 bdms.node）完成。远程模式
// 不需要本机存在汽水客户端；URL 缺 /sign 路径时自动补全。可选 *_SIGNER_TOKEN 提供
// Bearer 鉴权。优先级：MINERADIO_QISHUI_BDMS_SIGN=0 总开关 > 远程 > 本地 bdms.node。

const fs = require('fs');
const path = require('path');

const SODA_PROGRAM_DIR = process.env.MINERADIO_QISHUI_SODA_DIR ||
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Soda Music');

const REMOTE_SIGN_TIMEOUT_MS = 3500;
const REMOTE_SIGN_RETRY_MAX_WAIT_MS = 1500;

const state = {
  loaded: false,
  available: false,
  modulePath: '',
  version: '',
  bdms: null,
  initializedDeviceId: '',
  loadError: '',
  remoteLastError: '',
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

// ---------- 远程签名后端（libmssdk /sign 契约） ----------

let remoteSignerCache;
function remoteSignerConfig() {
  if (remoteSignerCache !== undefined) return remoteSignerCache;
  const rawUrl = process.env.MINERADIO_QISHUI_SIGNER_URL || process.env.QISHUI_SIGNER_URL || '';
  remoteSignerCache = null;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (/^https?:$/.test(parsed.protocol)) {
        if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/sign';
        const token = process.env.MINERADIO_QISHUI_SIGNER_TOKEN || process.env.QISHUI_SIGNER_TOKEN || '';
        remoteSignerCache = { url: parsed.toString(), origin: parsed.origin, token: String(token) };
      } else {
        state.remoteLastError = '签名服务 URL 协议不受支持: ' + rawUrl;
      }
    } catch (_) {
      state.remoteLastError = '签名服务 URL 无法解析: ' + rawUrl;
    }
  }
  return remoteSignerCache;
}

function parseHeaderLines(headerLines) {
  const headers = {};
  const parts = String(headerLines || '').split('\r\n');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const key = parts[i].trim();
    if (key) headers[key] = parts[i + 1];
  }
  return headers;
}

function serializeSignedHeaders(entries) {
  return Object.entries(entries)
    .map(([key, value]) => `${key}\r\n${value}`)
    .join('\r\n');
}

function extractSignedHeaders(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const sources = [payload.headers, payload];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const found = {};
    for (const [key, value] of Object.entries(source)) {
      if (/^x-(helios|medusa)$/i.test(String(key)) && value != null && String(value) !== '') {
        found[key] = String(value);
      }
    }
    if (Object.keys(found).length) return found;
  }
  return null;
}

function retryAfterMs(response) {
  const raw = parseFloat(response.headers.get('retry-after') || '');
  if (!Number.isFinite(raw) || raw <= 0) return 1000;
  return Math.min(Math.round(raw * 1000), REMOTE_SIGN_RETRY_MAX_WAIT_MS);
}

async function remoteSignOnce(url, headerLines, opts, config) {
  const method = String((opts && opts.method) || 'POST').toUpperCase();
  const payload = {
    url,
    method,
    body: String((opts && opts.body) || ''),
    headers: parseHeaderLines(headerLines),
    ts_ms: Date.now(),
  };
  const requestHeaders = { 'Content-Type': 'application/json' };
  if (config.token) requestHeaders['Authorization'] = 'Bearer ' + config.token;
  const response = await fetch(config.url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REMOTE_SIGN_TIMEOUT_MS),
  });
  if (response.status === 503 || response.status === 429) {
    const error = new Error('QISHUI_SIGNER_BUSY: HTTP ' + response.status);
    error.retryable = true;
    error.retryAfterMs = retryAfterMs(response);
    throw error;
  }
  let data = null;
  try { data = await response.json(); } catch (_) { /* 非 JSON 响应按失败处理 */ }
  if (!response.ok) {
    const code = data && data.code ? ' ' + data.code : '';
    throw new Error('QISHUI_SIGNER_HTTP_' + response.status + code);
  }
  const signed = extractSignedHeaders(data);
  if (!signed) {
    throw new Error('QISHUI_SIGNER_BAD_RESPONSE: 响应缺少 X-Helios / X-Medusa 头');
  }
  return serializeSignedHeaders(signed);
}

async function remoteSign(url, headerLines, opts) {
  const config = remoteSignerConfig();
  if (!config) throw new Error('QISHUI_SIGNER_UNCONFIGURED');
  try {
    return await remoteSignOnce(url, headerLines, opts, config);
  } catch (firstError) {
    if (!firstError || firstError.retryable !== true) {
      state.remoteLastError = firstError && firstError.message || String(firstError);
      throw firstError;
    }
    // 单次有界重试：仅服务忙/限流（503/429），尊重 Retry-After，等待过久直接放弃
    // 让调用方走既有回退链（旧通道 → SEO）。
    const waitMs = Math.min(firstError.retryAfterMs || 1000, REMOTE_SIGN_RETRY_MAX_WAIT_MS);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      return await remoteSignOnce(url, headerLines, opts, config);
    } catch (secondError) {
      state.remoteLastError = secondError && secondError.message || String(secondError);
      throw secondError;
    }
  }
}

// 是否具备签名能力：远程模式=已配置 URL；本地模式=找到模块且能读到设备 ID。
// 设置 MINERADIO_QISHUI_BDMS_SIGN=0 可强制关闭签名通道（单元测试用 mock https，需走旧通道）。
function isAvailable() {
  if (process.env.MINERADIO_QISHUI_BDMS_SIGN === '0') return false;
  if (remoteSignerConfig()) return true;
  return !!(ensureInitialized(loadDeviceId()));
}

// 官方客户端 app.ts 同款调用：headers 以 `key\r\nvalue` 行拼接后整体签名，
// 返回 `\r\n` 分隔的名值对文本。
// 远程模式下该函数为异步（POST /sign）；本地模式逻辑保持原样。返回值始终是
// Promise，调用方需 await。
async function generateHttpSignatureHeaders(url, headerLines, deviceId, opts) {
  if (remoteSignerConfig()) {
    return remoteSign(url, headerLines, opts);
  }
  const bdms = ensureInitialized(deviceId || loadDeviceId());
  if (!bdms) throw new Error('QISHUI_BDMS_UNAVAILABLE: ' + (state.loadError || '签名模块不可用'));
  return String(bdms.generateHttpSignatureHeaders(url, headerLines) || '');
}

function describe() {
  const remote = remoteSignerConfig();
  return {
    available: state.available,
    backend: remote ? 'remote' : 'local',
    signerUrl: remote ? remote.origin : '',
    modulePath: state.modulePath,
    sodaVersion: state.version,
    deviceId: state.initializedDeviceId,
    loadError: state.loadError,
    remoteLastError: state.remoteLastError,
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
