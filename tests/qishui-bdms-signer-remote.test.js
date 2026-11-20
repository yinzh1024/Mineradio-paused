'use strict';

// qishui-bdms-signer 远程 /sign 后端（libmssdk 契约）单元测试。
// 全部通过本地 http server mock 签名服务，不依赖 bdms.node 与网络。

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const SIGNER_PATH = path.join(__dirname, '..', 'qishui-bdms-signer.js');

const ENV_KEYS = [
  'MINERADIO_QISHUI_SIGNER_URL',
  'QISHUI_SIGNER_URL',
  'MINERADIO_QISHUI_SIGNER_TOKEN',
  'QISHUI_SIGNER_TOKEN',
  'MINERADIO_QISHUI_BDMS_SIGN',
  'MINERADIO_QISHUI_SODA_DIR',
];

function freshSigner(env) {
  delete require.cache[require.resolve(SIGNER_PATH)];
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    if (env && Object.prototype.hasOwnProperty.call(env, key)) process.env[key] = env[key];
    else delete process.env[key];
  }
  // 本地客户端目录指向不存在的路径，保证测试只走远程后端
  process.env.MINERADIO_QISHUI_SODA_DIR = '/nonexistent-soda-for-test';
  const signer = require(SIGNER_PATH);
  signer.__restoreEnv = () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[require.resolve(SIGNER_PATH)];
  };
  return signer;
}

function startMockServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

test('远程签名：嵌套 headers 响应形态被接受并序列化为 key\\r\\nvalue', async () => {
  let received = null;
  let receivedAuth = '';
  const { server, port } = await startMockServer(async (req, res) => {
    receivedAuth = req.headers.authorization || '';
    received = JSON.parse(await readBody(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      headers: { 'X-Helios': 'helios-1', 'X-Medusa': 'medusa-1' },
      device_id: 'signer-device',
      elapsed_ms: 6,
    }));
  });
  const signer = freshSigner({
    MINERADIO_QISHUI_SIGNER_URL: `http://127.0.0.1:${port}`,
    MINERADIO_QISHUI_SIGNER_TOKEN: 'tok-abc',
  });
  try {
    assert.equal(signer.isAvailable(), true);
    const result = await signer.generateHttpSignatureHeaders(
      'https://api.qishui.com/luna/pc/track_v2?aid=386088',
      'Content-Type\r\napplication/json\r\nX-SS-STUB\r\nABC123',
      'device-1',
      { method: 'POST', body: '{"track_id":"1"}' }
    );
    assert.equal(result, 'X-Helios\r\nhelios-1\r\nX-Medusa\r\nmedusa-1');
    assert.equal(receivedAuth, 'Bearer tok-abc');
    assert.equal(received.url, 'https://api.qishui.com/luna/pc/track_v2?aid=386088');
    assert.equal(received.method, 'POST');
    assert.equal(received.body, '{"track_id":"1"}');
    assert.equal(received.headers['X-SS-STUB'], 'ABC123');
    assert.ok(Number.isFinite(received.ts_ms));
    const desc = signer.describe();
    assert.equal(desc.backend, 'remote');
    assert.equal(desc.signerUrl, `http://127.0.0.1:${port}`);
  } finally {
    signer.__restoreEnv();
    server.close();
  }
});

test('远程签名：Meting 扁平响应形态同样接受', async () => {
  const { server, port } = await startMockServer(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, 'X-Helios': 'flat-helios', 'X-Medusa': 'flat-medusa' }));
  });
  const signer = freshSigner({ QISHUI_SIGNER_URL: `http://127.0.0.1:${port}/sign` });
  try {
    const result = await signer.generateHttpSignatureHeaders('https://api.qishui.com/x', 'A\r\n1', 'd', {});
    assert.equal(result, 'X-Helios\r\nflat-helios\r\nX-Medusa\r\nflat-medusa');
  } finally {
    signer.__restoreEnv();
    server.close();
  }
});

test('远程签名：503 BUSY 触发一次重试并成功', async () => {
  let calls = 0;
  const { server, port } = await startMockServer(async (req, res) => {
    await readBody(req);
    calls += 1;
    if (calls === 1) {
      res.writeHead(503, { 'Retry-After': '1', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'BUSY' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, headers: { 'X-Helios': 'h2', 'X-Medusa': 'm2' } }));
  });
  const signer = freshSigner({ MINERADIO_QISHUI_SIGNER_URL: `http://127.0.0.1:${port}` });
  try {
    const result = await signer.generateHttpSignatureHeaders('https://api.qishui.com/x', 'A\r\n1', 'd', {});
    assert.match(result, /X-Helios\r\nh2/);
    assert.equal(calls, 2);
  } finally {
    signer.__restoreEnv();
    server.close();
  }
});

test('远程签名：401 不重试直接抛错（调用方走回退链）', async () => {
  let calls = 0;
  const { server, port } = await startMockServer(async (req, res) => {
    await readBody(req);
    calls += 1;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED', error: '缺少或错误的 Bearer Token' }));
  });
  const signer = freshSigner({ MINERADIO_QISHUI_SIGNER_URL: `http://127.0.0.1:${port}` });
  try {
    await assert.rejects(
      () => signer.generateHttpSignatureHeaders('https://api.qishui.com/x', 'A\r\n1', 'd', {}),
      /QISHUI_SIGNER_HTTP_401/
    );
    assert.equal(calls, 1);
    assert.match(signer.describe().remoteLastError, /QISHUI_SIGNER_HTTP_401/);
  } finally {
    signer.__restoreEnv();
    server.close();
  }
});

test('远程签名：响应缺少签名头时抛 QISHUI_SIGNER_BAD_RESPONSE', async () => {
  const { server, port } = await startMockServer(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, headers: {}, device_id: 'd' }));
  });
  const signer = freshSigner({ MINERADIO_QISHUI_SIGNER_URL: `http://127.0.0.1:${port}` });
  try {
    await assert.rejects(
      () => signer.generateHttpSignatureHeaders('https://api.qishui.com/x', 'A\r\n1', 'd', {}),
      /QISHUI_SIGNER_BAD_RESPONSE/
    );
  } finally {
    signer.__restoreEnv();
    server.close();
  }
});

test('总开关 MINERADIO_QISHUI_BDMS_SIGN=0 优先于远程配置', async () => {
  const signer = freshSigner({
    MINERADIO_QISHUI_SIGNER_URL: 'http://127.0.0.1:1',
    MINERADIO_QISHUI_BDMS_SIGN: '0',
  });
  try {
    assert.equal(signer.isAvailable(), false);
  } finally {
    signer.__restoreEnv();
  }
});

test('非法签名服务 URL 被忽略（回退本地通道，本机无客户端时不可用）', async () => {
  const signer = freshSigner({ MINERADIO_QISHUI_SIGNER_URL: 'not-a-url' });
  try {
    assert.equal(signer.isAvailable(), false);
    assert.match(signer.describe().remoteLastError, /无法解析|不受支持/);
  } finally {
    signer.__restoreEnv();
  }
});

test('未配置远程 URL 且无本地客户端时不可用（保持原行为）', async () => {
  const signer = freshSigner({});
  try {
    assert.equal(signer.isAvailable(), false);
    assert.equal(signer.describe().backend, 'local');
    await assert.rejects(
      () => signer.generateHttpSignatureHeaders('https://api.qishui.com/x', 'A\r\n1', 'd', {}),
      /QISHUI_BDMS_UNAVAILABLE/
    );
  } finally {
    signer.__restoreEnv();
  }
});
