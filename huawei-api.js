'use strict';

// 华为音乐 provider（协议参考开源项目 talongao/tinglan 的 native/internal/huawei）。
//
// 两段式登录：
//   1. 华为账号 OAuth 2.0 + PKCE（client_id 101444301，redirect hms://redirect_uri，
//      scope=openid），在 Electron 窗口里完成，回调是自定义 scheme；
//   2. 用 access_token 调 /music-odpapp-service/v5/service/userinfo/loginex 换音乐会话 token。
//
// 请求头是 Digest 风格（无加密签名）：
//   Authorization: Digest username=app-music-baseline, nonce=<随机>, created=<ISO8601>[, token=<会话>]
//
// 响应信封 {result:{resultCode:"000000"}}；非 000000 视为失败。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const HUAWEI_AUTHORIZE_ENDPOINT = 'https://oauth-login.platform.hicloud.com/oauth2/v3/authorize';
const HUAWEI_TOKEN_ENDPOINT = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token';
const HUAWEI_API_BASE = (process.env.MINERADIO_HUAWEI_API_BASE || 'https://api-drcn.music.dbankcloud.cn').replace(/\/+$/, '');
const HUAWEI_CLIENT_ID = '101444301';
const HUAWEI_REDIRECT_URI = 'hms://redirect_uri';
const HUAWEI_LOGIN_PARTITION = 'persist:mineradio-huawei-login';
const HUAWEI_MAX_BYTES = 2 * 1024 * 1024;
const HUAWEI_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const HUAWEI_ALLOWED_LOGIN_HOSTS = [
    'oauth-login.platform.hicloud.com',
    'oauth-login.cloud.huawei.com',
    'id1.cloud.huawei.com',
    'account.huawei.com',
    'consumer.huawei.com',
];
// 音频 / 封面 / 歌词的资源域名白名单（来源可被服务端指定，必须限制）
const HUAWEI_RESOURCE_SUFFIXES = ['.dbankcdn.cn', '.tingmall.com', '.kuke.com'];
const HUAWEI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function normalizeText(value) {
    return String(value == null ? '' : value).trim();
}

function base64Url(buffer) {
    return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function safeParse(value, fallback) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(String(value || ''));
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function isHuaweiResourceUrl(raw) {
    const value = normalizeText(raw);
    if (!value) return false;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
        if (parsed.port && parsed.port !== '443') return false;
        const host = parsed.hostname.toLowerCase();
        return HUAWEI_RESOURCE_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
    } catch (_) {
        return false;
    }
}

// ── 会话持久化 ────────────────────────────────────────────────

function huaweiSessionFile() {
    return normalizeText(process.env.MINERADIO_HUAWEI_SESSION_FILE) || path.join(__dirname, '.huawei-session.json');
}

function readHuaweiSession() {
    try {
        const doc = JSON.parse(fs.readFileSync(huaweiSessionFile(), 'utf8'));
        const token = normalizeText(doc.token);
        const snsUserID = normalizeText(doc.snsUserID || doc.userId);
        if (!token || !snsUserID) return null;
        return {
            token,
            snsUserID,
            expireTime: normalizeText(doc.expireTime),
            createdAt: Number(doc.createdAt) || 0,
            accessToken: normalizeText(doc.accessToken),
            refreshToken: normalizeText(doc.refreshToken),
            accessTokenExpiresAt: Number(doc.accessTokenExpiresAt) || 0,
            vipLevel: normalizeText(doc.vipLevel) || 'unknown',
            vipCheckedAt: Number(doc.vipCheckedAt) || 0,
        };
    } catch (_) {
        return null;
    }
}

function writeHuaweiSession(session) {
    const file = huaweiSessionFile();
    const payload = {
        token: normalizeText(session && session.token),
        snsUserID: normalizeText(session && session.snsUserID),
        expireTime: normalizeText(session && session.expireTime),
        createdAt: Number(session && session.createdAt) || Date.now(),
        accessToken: normalizeText(session && session.accessToken),
        refreshToken: normalizeText(session && session.refreshToken),
        accessTokenExpiresAt: Number(session && session.accessTokenExpiresAt) || 0,
        vipLevel: normalizeText(session && session.vipLevel) || 'unknown',
        vipCheckedAt: Number(session && session.vipCheckedAt) || 0,
    };
    if (!payload.token || !payload.snsUserID) {
        throw Object.assign(new Error('HUAWEI_SESSION_INCOMPLETE'), { code: 'HUAWEI_SESSION_INCOMPLETE' });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    return payload;
}

function clearHuaweiSession() {
    try { fs.unlinkSync(huaweiSessionFile()); } catch (_) {}
}

// ── HTTP ─────────────────────────────────────────────────────

function requestBuffer(targetUrl, options) {
    options = options || {};
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(targetUrl);
        } catch (err) {
            reject(Object.assign(new Error('HUAWEI_URL_INVALID'), { code: 'HUAWEI_URL_INVALID' }));
            return;
        }
        const transport = parsed.protocol === 'http:' ? http : https;
        const body = options.body == null ? null : Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body));
        const headers = Object.assign({ 'User-Agent': HUAWEI_UA }, options.headers || {});
        if (body) headers['Content-Length'] = body.length;
        const req = transport.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
            path: parsed.pathname + parsed.search,
            method: options.method || 'GET',
            headers,
            timeout: Math.max(1000, Number(options.timeoutMs) || 8000),
        }, (res) => {
            const chunks = [];
            let total = 0;
            const maxBytes = Math.max(HUAWEI_MAX_BYTES, Number(options.maxBytes) || 0);
            res.on('data', (chunk) => {
                total += chunk.length;
                if (total > maxBytes) {
                    req.destroy(Object.assign(new Error('HUAWEI_RESPONSE_TOO_LARGE'), { code: 'HUAWEI_RESPONSE_TOO_LARGE' }));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, buffer: Buffer.concat(chunks) }));
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('HUAWEI_TIMEOUT'), { code: 'HUAWEI_TIMEOUT' })));
        req.on('error', (err) => reject(Object.assign(new Error('HUAWEI_NETWORK_FAILED'), {
            code: err && err.code || 'HUAWEI_NETWORK_FAILED',
            cause: err,
        })));
        if (body) req.write(body);
        req.end();
    });
}

function musicAuthHeader(token) {
    const nonce = base64Url(crypto.randomBytes(18));
    let value = 'Digest username=app-music-baseline, nonce=' + nonce + ', created=' + nowIso();
    if (token) {
        if (/[\r\n,]/.test(token)) throw Object.assign(new Error('HUAWEI_SESSION_INVALID'), { code: 'HUAWEI_SESSION_INVALID' });
        value += ', token=' + token;
    }
    return value;
}

async function musicPost(apiPath, payload, token) {
    const res = await requestBuffer(HUAWEI_API_BASE + apiPath, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': musicAuthHeader(token),
        },
        body: JSON.stringify(payload || {}),
        timeoutMs: 12000,
    });
    const text = res.buffer.toString('utf8');
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch (_) {
        throw Object.assign(new Error('HUAWEI_BAD_JSON'), { code: 'HUAWEI_BAD_JSON', status: res.status });
    }
    const envelope = json && json.result;
    if (!envelope || envelope.resultCode !== '000000') {
        const code = envelope && envelope.resultCode || ('HTTP_' + res.status);
        const message = envelope && envelope.resultMessage || '';
        const expired = /token\s*(has\s+)?expired|session\s+expired|token已过期|令牌已过期|登录已过期|会话已过期/i.test(message);
        // 990000 = 服务端通用错误：token 失效/风控时也回这个，按会话失效处理（可续期/需重登）
        const sessionInvalid = expired || code === '990000';
        throw Object.assign(new Error(message || 'HUAWEI_API_FAILED'), {
            code: sessionInvalid ? 'HUAWEI_SESSION_INVALID' : 'HUAWEI_API_FAILED',
            resultCode: code,
            status: res.status,
            detail: message,
        });
    }
    return json;
}

// ── 会话续期（refresh_token → access_token → loginex） ────────

function updateHuaweiSessionMeta(patch) {
    const session = readHuaweiSession();
    if (!session) return null;
    const next = Object.assign({}, session, patch || {});
    try {
        return writeHuaweiSession(next);
    } catch (_) {
        return session;
    }
}

// 华为 OAuth 的 refresh_token 授权要求 client_secret（官方客户端未带），
// 因此续期分两步：
//   1) 音乐 token 失效但 OAuth accessToken 仍有效 → 直接用 accessToken 重走 loginex；
//   2) accessToken 也过期 → 尝试 refresh_token（多数客户端会 1101 missing client_secret），
//      失败则要求重新登录。
async function refreshHuaweiSession() {
    const session = readHuaweiSession();
    if (!session) {
        throw Object.assign(new Error('HUAWEI_REFRESH_UNAVAILABLE'), { code: 'HUAWEI_REFRESH_UNAVAILABLE' });
    }

    const exchangeWithAccessToken = async (accessToken) => {
        const json = await musicPost('/music-odpapp-service/v5/service/userinfo/loginex', { accessToken }, '');
        const token = normalizeText(json.token);
        const snsUserID = normalizeText(json.snsUserID);
        if (!token || !snsUserID) {
            throw Object.assign(new Error('HUAWEI_REFRESH_INCOMPLETE'), { code: 'HUAWEI_REFRESH_INCOMPLETE' });
        }
        return writeHuaweiSession({
            token,
            snsUserID,
            expireTime: normalizeText(json.expireTime),
            accessToken,
            refreshToken: session.refreshToken,
            accessTokenExpiresAt: session.accessTokenExpiresAt,
            vipLevel: session.vipLevel,
            vipCheckedAt: session.vipCheckedAt,
        });
    };

    // 1) 用仍在有效期内的 OAuth accessToken 重换音乐会话
    if (session.accessToken && (!session.accessTokenExpiresAt || session.accessTokenExpiresAt > Date.now())) {
        try {
            return await exchangeWithAccessToken(session.accessToken);
        } catch (_) {}
    }

    // 2) 尝试 refresh_token（需要 client_secret，通常不可用）
    if (session.refreshToken) {
        const form = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: HUAWEI_CLIENT_ID,
            refresh_token: session.refreshToken,
        });
        const tokenRes = await requestBuffer(HUAWEI_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            timeoutMs: 12000,
        });
        let tokenJson = null;
        try {
            tokenJson = JSON.parse(tokenRes.buffer.toString('utf8'));
        } catch (_) {
            throw Object.assign(new Error('HUAWEI_REFRESH_BAD_JSON'), { code: 'HUAWEI_REFRESH_BAD_JSON' });
        }
        const accessToken = normalizeText(tokenJson && tokenJson.access_token);
        if (accessToken) {
            try {
                return await exchangeWithAccessToken(accessToken).then((saved) => writeHuaweiSession({
                    token: saved.token,
                    snsUserID: saved.snsUserID,
                    expireTime: saved.expireTime,
                    accessToken,
                    refreshToken: normalizeText(tokenJson.refresh_token) || session.refreshToken,
                    accessTokenExpiresAt: Date.now() + Math.max(60, Number(tokenJson.expires_in) || 3600) * 1000,
                    vipLevel: session.vipLevel,
                    vipCheckedAt: session.vipCheckedAt,
                }));
            } catch (_) {}
        }
    }
    throw Object.assign(new Error('HUAWEI_REFRESH_FAILED'), { code: 'HUAWEI_REFRESH_FAILED' });
}

// 带会话的 API 调用：token 过期时自动续期并重试一次
async function musicCall(apiPath, payload) {
    const session = readHuaweiSession();
    if (!session) throw Object.assign(new Error('HUAWEI_LOGIN_REQUIRED'), { code: 'HUAWEI_LOGIN_REQUIRED' });
    try {
        return await musicPost(apiPath, payload, session.token);
    } catch (err) {
        if (err && (err.code === 'HUAWEI_SESSION_EXPIRED' || err.code === 'HUAWEI_SESSION_INVALID') && session.refreshToken) {
            const refreshed = await refreshHuaweiSession();
            return musicPost(apiPath, payload, refreshed.token);
        }
        throw err;
    }
}

// ── 会员状态（用无损取流能力探测） ───────────────────────────

const HUAWEI_VIP_PROBE_TRACKS = ['MqJCfErkcFN0rrFxS'];
const HUAWEI_VIP_PROBE_TTL_MS = 12 * 60 * 60 * 1000;

async function probeHuaweiVip() {
    const session = readHuaweiSession();
    if (!session) return 'unknown';
    for (const id of HUAWEI_VIP_PROBE_TRACKS) {
        try {
            const json = await musicPost('/music-play-service/v3/service/file/bycontentcode', {
                contentCode: id,
                contentType: '1',
                qualityType: '3',
            }, session.token);
            const url = normalizeText(json && json.fileURL);
            const quality = Number(json && json.playQuality) || 0;
            if (url && isHuaweiResourceUrl(url) && quality === 3) {
                updateHuaweiSessionMeta({ vipLevel: 'vip', vipCheckedAt: Date.now() });
                return 'vip';
            }
        } catch (_) {}
    }
    updateHuaweiSessionMeta({ vipLevel: 'unknown', vipCheckedAt: Date.now() });
    return 'unknown';
}

// ── 登录（OAuth PKCE） ───────────────────────────────────────

let huaweiOAuthAttempt = null;

function createHuaweiOAuthAttempt() {
    const verifier = base64Url(crypto.randomBytes(48));
    const state = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    const params = new URLSearchParams({
        client_id: HUAWEI_CLIENT_ID,
        redirect_uri: HUAWEI_REDIRECT_URI,
        response_type: 'code',
        access_type: 'offline',
        scope: 'openid',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        countryCode: 'cn',
        ui_locales: 'zh-cn',
    });
    huaweiOAuthAttempt = { verifier, state, createdAt: Date.now(), consumed: false, code: '' };
    return {
        url: HUAWEI_AUTHORIZE_ENDPOINT + '?' + params.toString(),
        state,
        createdAt: huaweiOAuthAttempt.createdAt,
    };
}

function isHuaweiLoginUrl(raw) {
    const value = normalizeText(raw);
    if (!value) return false;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
        if (parsed.port && parsed.port !== '443') return false;
        const host = parsed.hostname.toLowerCase();
        if (host === 'oauth-login1.cloud.huawei.com') return parsed.pathname === '/oauth2/v3/loginCallback';
        return HUAWEI_ALLOWED_LOGIN_HOSTS.indexOf(host) >= 0;
    } catch (_) {
        return false;
    }
}

function isHuaweiCallbackUrl(raw) {
    const value = normalizeText(raw);
    if (!value || value.indexOf('#') >= 0) return false;
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'hms:' && parsed.hostname === 'redirect_uri' && !parsed.pathname && !parsed.username;
    } catch (_) {
        return false;
    }
}

function acceptHuaweiOAuthCallback(rawUrl) {
    const attempt = huaweiOAuthAttempt;
    if (!attempt) return { ok: false, error: 'HUAWEI_OAUTH_NO_ATTEMPT', message: '登录会话已失效，请重新打开登录窗口。' };
    if (attempt.consumed) return { ok: false, error: 'HUAWEI_OAUTH_SETTLED', message: '本次登录已结束，请重新打开登录窗口。' };
    if (!isHuaweiCallbackUrl(rawUrl)) return { ok: false, error: 'HUAWEI_OAUTH_BAD_CALLBACK', message: '回调地址不合法。' };
    attempt.consumed = true;
    if (Date.now() - attempt.createdAt > HUAWEI_ATTEMPT_TTL_MS) {
        return { ok: false, error: 'HUAWEI_OAUTH_EXPIRED', message: '登录超时，请重新打开登录窗口。' };
    }
    let params;
    try {
        params = new URL(normalizeText(rawUrl)).searchParams;
    } catch (_) {
        return { ok: false, error: 'HUAWEI_OAUTH_BAD_CALLBACK', message: '回调参数无法解析。' };
    }
    if (attempt.state && params.get('state') !== attempt.state) {
        return { ok: false, error: 'HUAWEI_OAUTH_STATE_MISMATCH', message: '登录状态校验失败，请重新登录。' };
    }
    if (params.get('error')) {
        return { ok: false, error: 'HUAWEI_OAUTH_DENIED', message: '华为账号授权被取消。' };
    }
    const code = normalizeText(params.get('code'));
    if (!code) return { ok: false, error: 'HUAWEI_OAUTH_CODE_MISSING', message: '回调没有返回授权码。' };
    attempt.code = code;
    return { ok: true, code };
}

async function exchangeHuaweiOAuthCode(code) {
    const attempt = huaweiOAuthAttempt;
    if (!attempt || !attempt.verifier) {
        throw Object.assign(new Error('HUAWEI_OAUTH_NO_ATTEMPT'), { code: 'HUAWEI_OAUTH_NO_ATTEMPT' });
    }
    const verifier = attempt.verifier;
    attempt.verifier = '';
    const form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: HUAWEI_CLIENT_ID,
        redirect_uri: HUAWEI_REDIRECT_URI,
        code: normalizeText(code),
        code_verifier: verifier,
    });
    const tokenRes = await requestBuffer(HUAWEI_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: 12000,
    });
    let tokenJson = null;
    try {
        tokenJson = JSON.parse(tokenRes.buffer.toString('utf8'));
    } catch (_) {
        throw Object.assign(new Error('HUAWEI_TOKEN_BAD_JSON'), { code: 'HUAWEI_TOKEN_BAD_JSON' });
    }
    const accessToken = normalizeText(tokenJson && tokenJson.access_token);
    if (!accessToken) {
        throw Object.assign(new Error((tokenJson && (tokenJson.error_description || tokenJson.error)) || 'HUAWEI_TOKEN_MISSING'), {
            code: 'HUAWEI_TOKEN_MISSING',
        });
    }
    const json = await musicPost('/music-odpapp-service/v5/service/userinfo/loginex', { accessToken }, '');
    const token = normalizeText(json.token);
    const snsUserID = normalizeText(json.snsUserID);
    if (!token || !snsUserID) {
        throw Object.assign(new Error('HUAWEI_MUSIC_SESSION_INCOMPLETE'), { code: 'HUAWEI_MUSIC_SESSION_INCOMPLETE' });
    }
    return writeHuaweiSession({
        token,
        snsUserID,
        expireTime: normalizeText(json.expireTime),
        accessToken,
        refreshToken: normalizeText(tokenJson.refresh_token),
        accessTokenExpiresAt: Date.now() + Math.max(60, Number(tokenJson.expires_in) || 3600) * 1000,
    });
}

async function validateHuaweiSession(session) {
    const json = await musicPost('/music-userbehavior-service/v3/service/favorite/simple/all', {
        targetSnsUserID: session.snsUserID,
        start: 0,
        limit: 1,
        contentTypes: [4, 5, 7],
    }, session.token);
    return json;
}

function getHuaweiStatus() {
    const session = readHuaweiSession();
    if (!session) {
        return {
            provider: 'huawei',
            configured: true,
            loggedIn: false,
            nickname: '华为音乐',
            userId: '',
            vipLevel: 'unknown',
            vipType: 0,
            isVip: false,
            isSvip: false,
            vipLabel: '未知会员状态',
            playbackKeyReady: false,
            playbackMode: 'direct-url',
        };
    }
    const vipLevel = normalizeText(session.vipLevel) || 'unknown';
    const isVip = vipLevel === 'vip';
    return {
        provider: 'huawei',
        configured: true,
        loggedIn: true,
        nickname: '华为音乐账号',
        userId: session.snsUserID,
        accountKey: session.snsUserID,
        expireTime: session.expireTime,
        vipLevel,
        vipType: isVip ? 1 : 0,
        isVip,
        isSvip: false,
        vipLabel: isVip ? '华为音乐 VIP' : '未知会员状态',
        playbackKeyReady: true,
        playbackMode: 'direct-url',
    };
}

async function handleHuaweiStatusWithVerify() {
    const session = readHuaweiSession();
    if (!session) return getHuaweiStatus();
    try {
        await validateHuaweiSession(session);
        const vipStale = !session.vipLevel || session.vipLevel === 'unknown'
            || !session.vipCheckedAt || Date.now() - session.vipCheckedAt > 12 * 60 * 60 * 1000;
        if (vipStale) {
            try { await probeHuaweiVip(); } catch (_) {}
        }
        return getHuaweiStatus();
    } catch (err) {
        const sessionInvalid = err && (err.code === 'HUAWEI_SESSION_EXPIRED' || err.code === 'HUAWEI_SESSION_INVALID');
        if (sessionInvalid && session.refreshToken) {
            try {
                await refreshHuaweiSession();
                await validateHuaweiSession(readHuaweiSession());
                return getHuaweiStatus();
            } catch (_) {}
        }
        if (sessionInvalid) {
            return Object.assign(getHuaweiStatus(), {
                loggedIn: false,
                reauthRequired: true,
                stale: true,
                message: '华为音乐登录已失效，请重新登录。',
            });
        }
        // 网络失败不代表会话失效
        return Object.assign(getHuaweiStatus(), { stale: true, warning: err && err.message || String(err) });
    }
}

// ── 曲目解析 ─────────────────────────────────────────────────

function pickDurationSeconds(...candidates) {
    for (const candidate of candidates) {
        if (candidate == null) continue;
        const list = Array.isArray(candidate) ? candidate : [candidate];
        for (const item of list) {
            const value = Number(item && (item.duration || item));
            if (Number.isFinite(value) && value > 0) return Math.round(value);
        }
    }
    return 0;
}

function huaweiCover(picture) {
    const candidates = [picture && picture.bigImgURL, picture && picture.middleImgURL, picture && picture.smallImgURL];
    for (const candidate of candidates) {
        if (isHuaweiResourceUrl(candidate)) return normalizeText(candidate);
    }
    return '';
}

function huaweiArtists(item) {
    const out = [];
    const pairs = Array.isArray(item && item.artistNamePairs) ? item.artistNamePairs : [];
    pairs.forEach((pair) => {
        const name = normalizeText(pair && (pair.name || pair.artistName));
        if (!name) return;
        out.push({ id: normalizeText(pair.id || pair.artistID), name });
    });
    if (!out.length) {
        const name = normalizeText(item && (item.artistName || item.singerName));
        if (name) {
            const ids = Array.isArray(item && item.artistID) ? item.artistID : [];
            out.push({ id: ids.length === 1 ? normalizeText(ids[0]) : '', name });
        }
    }
    return out;
}

function normalizeHuaweiTrack(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = normalizeText(raw.contentID || raw.contentId || raw.songCode);
    const name = normalizeText(raw.contentName || raw.songName);
    if (!id || !name) return null;
    const artists = huaweiArtists(raw);
    const artistName = artists.map((a) => a.name).join(' / ');
    const albumName = normalizeText(raw.albumName || (raw.albumNamePair && (raw.albumNamePair.name || raw.albumNamePair.albumName)));
    const albumId = normalizeText(raw.albumID || raw.albumId || (raw.albumNamePair && (raw.albumNamePair.id || raw.albumNamePair.albumID)));
    const exInfo = safeParse(raw.contentExInfo, {});
    const fileInfos = Array.isArray(exInfo.fileInfos) ? exInfo.fileInfos : [];
    const duration = pickDurationSeconds(fileInfos, exInfo.duration, raw.duration);
    const vip = normalizeText(exInfo.vip);
    // status: 1=可播；0=下架/不可播（歌单里常见）。缺省视为可播。
    const status = normalizeText(raw.status);
    const playable = status === '' || status === '1';
    const quality = normalizeText(raw.quality);
    return {
        provider: 'huawei',
        source: 'huawei',
        type: 'huawei',
        id,
        providerSongId: id,
        name,
        artist: artistName,
        artists,
        album: albumName,
        albumId,
        cover: huaweiCover(raw.picture),
        duration,
        fee: vip === '2' ? 1 : 0,
        vipRequired: vip === '2',
        quality,
        playable,
        offline: !playable,
        playbackMode: 'direct-url',
        lyricAddress: normalizeText(raw.lyricAddress),
        huaweiExInfo: undefined,
    };
}

function normalizeHuaweiTracks(items) {
    return (Array.isArray(items) ? items : []).map(normalizeHuaweiTrack).filter(Boolean);
}

const huaweiSearchCache = new Map();
const HUAWEI_SEARCH_TTL_MS = 2 * 60 * 1000;

async function handleHuaweiSearch(keywords, limit, offset) {
    keywords = normalizeText(keywords);
    limit = Math.max(1, Math.min(30, Number(limit) || 10));
    offset = Math.max(0, Number(offset) || 0);
    const status = getHuaweiStatus();
    if (!keywords) {
        return { provider: 'huawei', songs: [], configured: true, loggedIn: status.loggedIn, message: '请输入搜索关键词' };
    }
    const cacheKey = keywords.toLowerCase() + '|' + limit + '|' + offset;
    const cached = huaweiSearchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < HUAWEI_SEARCH_TTL_MS) return cached.value;
    const json = await musicPost('/music-search-service/v10/service/fuzzysearch', {
        contentType: '1',
        correct: '1',
        queryWord: keywords,
        start: String(offset),
        limit: String(limit),
    }, '');
    const songs = normalizeHuaweiTracks(json.songSimpleInfos);
    const value = {
        provider: 'huawei',
        configured: true,
        loggedIn: status.loggedIn,
        songs,
        rawCount: songs.length,
        offset,
        hasMore: String(json.hasNextPage) === '1' || json.hasNextPage === true,
        source: 'huawei-music',
    };
    huaweiSearchCache.set(cacheKey, { at: Date.now(), value });
    if (huaweiSearchCache.size > 60) {
        const oldest = [...huaweiSearchCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) huaweiSearchCache.delete(oldest[0]);
    }
    return value;
}

// ── 播放地址 ─────────────────────────────────────────────────

const huaweiPlaybackCache = new Map();
const HUAWEI_PLAYBACK_TTL_MS = 3 * 60 * 1000;

function huaweiUnavailable(message, code, extra) {
    return Object.assign({
        provider: 'huawei',
        url: '',
        playable: false,
        trial: false,
        loggedIn: !!readHuaweiSession(),
        error: message,
        code: code || 'HUAWEI_SOURCE_UNAVAILABLE',
    }, extra || {});
}

async function resolveHuaweiPlayback(id, qualityType) {
    const session = readHuaweiSession();
    const body = { contentCode: id, contentType: '1', qualityType };
    const json = session
        ? await musicCall('/music-play-service/v3/service/file/bycontentcode', body)
        : await musicPost('/music-play-service/v3/service/file/bycontentcode', body, '');
    return { json, session };
}

function huaweiLyricAddresses(json) {
    const songInfo = safeParse(json && json.songInfo, {});
    const blocks = [];
    if (songInfo && songInfo.lyrics) blocks.push(songInfo.lyrics);
    if (json && json.lyrics) blocks.push(json.lyrics);
    let lrc = '';
    let hmrc = '';
    for (const block of blocks) {
        const parsed = safeParse(block, null);
        if (!parsed) continue;
        if (!lrc && isHuaweiResourceUrl(parsed.lineByLineLyric)) lrc = normalizeText(parsed.lineByLineLyric);
        if (!hmrc && isHuaweiResourceUrl(parsed.wordByWordLyric)) hmrc = normalizeText(parsed.wordByWordLyric);
        if (lrc && hmrc) break;
    }
    if (!lrc && isHuaweiResourceUrl(songInfo && songInfo.lyricAddress)) lrc = normalizeText(songInfo.lyricAddress);
    if (!lrc && isHuaweiResourceUrl(json && json.lyricAddress)) lrc = normalizeText(json.lyricAddress);
    return { lrc, hmrc };
}

// ── 下架曲目：同名重匹配（官方曲目下架后仍可能有同名/同版本可用） ──

const huaweiRematchCache = new Map();

function huaweiNormalizeMatchText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
        .replace(/[\s·・,，。.!！?？'"“”‘’|\-_/]+/g, '');
}

function huaweiBaseTitle(name) {
    return String(name || '')
        .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
        .replace(/(live|remix|伴奏|纯音乐|dj版?|翻唱|cover|版)$/i, '')
        .trim();
}

function huaweiPrimaryArtist(artist) {
    return String(artist || '').split(/\s*[/、,&]\s*/)[0].trim();
}

async function rematchHuaweiTrack(opts) {
    opts = opts || {};
    const name = normalizeText(opts.name);
    if (!name) return null;
    const cacheKey = huaweiNormalizeMatchText(name) + '|' + huaweiNormalizeMatchText(opts.artist);
    if (huaweiRematchCache.has(cacheKey)) return huaweiRematchCache.get(cacheKey);
    const baseTitle = huaweiBaseTitle(name);
    const artist = huaweiPrimaryArtist(opts.artist);
    const query = [baseTitle, artist].filter(Boolean).join(' ').trim();
    if (!query) return null;
    let best = null;
    try {
        const json = await musicPost('/music-search-service/v10/service/fuzzysearch', {
            contentType: '1',
            correct: '1',
            queryWord: query,
            start: '0',
            limit: '10',
        }, '');
        const items = (Array.isArray(json.songSimpleInfos) ? json.songSimpleInfos : [])
            .filter((item) => normalizeText(item.status) === '1');
        const targetName = huaweiNormalizeMatchText(name);
        const targetBase = huaweiNormalizeMatchText(baseTitle);
        const targetArtist = huaweiNormalizeMatchText(artist);
        const targetDuration = Number(opts.duration) || 0;
        items.forEach((item) => {
            const candidateName = huaweiNormalizeMatchText(item.contentName);
            const candidateBase = huaweiNormalizeMatchText(huaweiBaseTitle(item.contentName));
            const candidateArtist = huaweiNormalizeMatchText(item.artistName);
            let score = 0;
            if (candidateName === targetName) score += 100;
            else if (targetBase && candidateBase === targetBase) score += 60;
            else if (targetBase && candidateBase.indexOf(targetBase) >= 0) score += 30;
            if (targetArtist && candidateArtist.indexOf(targetArtist) >= 0) score += 40;
            const candidateDuration = pickDurationSeconds(item.contentExInfo);
            if (targetDuration > 0 && candidateDuration > 0) {
                const diff = Math.abs(candidateDuration - targetDuration);
                if (diff <= 3) score += 20;
                else if (diff <= 8) score += 8;
            }
            const nameMatched = candidateName === targetName || (targetBase && candidateBase.indexOf(targetBase) >= 0);
            const artistMatched = !!(targetArtist && candidateArtist.indexOf(targetArtist) >= 0);
            if (!nameMatched) return;
            if (!artistMatched && score < 60) return;
            if (!best || score > best.score) {
                best = { id: normalizeText(item.contentID), name: normalizeText(item.contentName), artist: normalizeText(item.artistName), score };
            }
        });
    } catch (_) {
        best = null;
    }
    huaweiRematchCache.set(cacheKey, best);
    if (huaweiRematchCache.size > 500) {
        const first = huaweiRematchCache.keys().next().value;
        if (first) huaweiRematchCache.delete(first);
    }
    return best;
}

async function handleHuaweiSongUrl(id, quality, opts) {
    opts = opts || {};
    id = normalizeText(id);
    if (!id) return huaweiUnavailable('缺少歌曲 ID', 'missing_id');
    const requested = normalizeText(quality || 'standard').toLowerCase();
    const requestedQualityType = requested === 'lossless' ? '3' : '1';
    const cacheKey = id + '|' + requestedQualityType + '|' + (readHuaweiSession() ? 'in' : 'out');
    const cached = huaweiPlaybackCache.get(cacheKey);
    if (cached && Date.now() - cached.at < HUAWEI_PLAYBACK_TTL_MS) return cached.value;

    let json = null;
    let usedQualityType = requestedQualityType;
    try {
        const attempt = await resolveHuaweiPlayback(id, requestedQualityType);
        json = attempt.json;
    } catch (err) {
        if (requestedQualityType === '3') {
            // 无损需要会员；失败后回落到标准档
            try {
                const fallback = await resolveHuaweiPlayback(id, '1');
                json = fallback.json;
                usedQualityType = '1';
            } catch (fallbackErr) {
                return huaweiUnavailable(fallbackErr.message || '华为音乐取流失败', fallbackErr.code || 'HUAWEI_SONG_URL_FAILED', {
                    requestedLevel: 'lossless',
                });
            }
        } else {
            const message = normalizeText(err && (err.detail || err.message));
            const offline = (err && String(err.resultCode) === '200002')
                || /offline|下架|版权|不可播/i.test(message);
            if (offline) {
                // 下架曲目：先按名称/歌手/时长重匹配同名可用版本
                const matched = await rematchHuaweiTrack({
                    name: opts.name || opts.title,
                    artist: opts.artist,
                    duration: opts.duration,
                }).catch(() => null);
                if (matched && matched.id && matched.id !== id) {
                    try {
                        const retry = await resolveHuaweiPlayback(matched.id, requestedQualityType);
                        const retryUrl = normalizeText(retry.json && retry.json.fileURL);
                        if (retryUrl && isHuaweiResourceUrl(retryUrl)) {
                            const value = {
                                provider: 'huawei',
                                playbackMode: 'direct-url',
                                url: retryUrl,
                                playable: true,
                                trial: false,
                                loggedIn: true,
                                playbackKeyReady: true,
                                membershipKnown: false,
                                vipLevel: 'unknown',
                                level: usedQualityType === '3' ? 'lossless' : 'standard',
                                quality: usedQualityType === '3' ? 'lossless' : 'standard',
                                requestedQuality: requested,
                                duration: pickDurationSeconds(retry.json && retry.json.fileInfos) || 0,
                                source: 'huawei-music-rematch',
                                rematchedFrom: id,
                                rematchedTo: matched.id,
                                rematchedName: matched.name,
                                encrypted: false,
                            };
                            huaweiPlaybackCache.set(cacheKey, { at: Date.now(), value });
                            return value;
                        }
                    } catch (_) {}
                }
            }
            return huaweiUnavailable(
                offline ? '该曲目已在华为音乐下架，正在尝试其他音源' : (message || '华为音乐取流失败'),
                offline ? 'HUAWEI_CONTENT_OFFLINE' : (err.code || 'HUAWEI_SONG_URL_FAILED'),
                { reauthRequired: err.code === 'HUAWEI_SESSION_EXPIRED', offline }
            );
        }
    }

    const url = normalizeText(json && json.fileURL);
    if (!url || !isHuaweiResourceUrl(url)) {
        return huaweiUnavailable('华为音乐没有返回可用音频地址', 'HUAWEI_SOURCE_UNAVAILABLE', {
            trial: !!normalizeText(json && json.auditionEnd),
        });
    }
    const songInfo = safeParse(json && json.songInfo, {});
    const fileInfos = Array.isArray(json && json.fileInfos) ? json.fileInfos : [];
    const duration = pickDurationSeconds(fileInfos, songInfo && songInfo.duration);
    // 未登录时服务端给 30 秒预览（URL 里没有 /preview/ 标记，只有 auditionEnd）；
    // 已登录时 auditionEnd 也可能出现在整曲资源上，不能作为登录态下的判据。
    const auditionEnd = Number(json && json.auditionEnd) || 0;
    const session = readHuaweiSession();
    const preview = /\/preview\//i.test(url) || (!session && auditionEnd > 0);
    const level = usedQualityType === '3' ? 'lossless' : 'standard';
    if (level === 'lossless') updateHuaweiSessionMeta({ vipLevel: 'vip', vipCheckedAt: Date.now() });
    const value = {
        provider: 'huawei',
        playbackMode: 'direct-url',
        url,
        playable: true,
        trial: preview,
        loggedIn: !!session,
        playbackKeyReady: !!session,
        membershipKnown: false,
        vipLevel: 'unknown',
        level,
        quality: level,
        requestedQuality: requested,
        requestedLevel: requestedQualityType === '3' ? 'lossless' : 'standard',
        bitrate: 0,
        size: 0,
        duration,
        source: 'huawei-music',
        encrypted: false,
    };
    huaweiPlaybackCache.set(cacheKey, { at: Date.now(), value });
    if (huaweiPlaybackCache.size > 80) {
        const oldest = [...huaweiPlaybackCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) huaweiPlaybackCache.delete(oldest[0]);
    }
    return value;
}

// ── 歌词（HMRC 逐字 → QRC 文本；LRC 兜底） ─────────────────

const huaweiLyricCache = new Map();
const HUAWEI_LYRIC_TTL_MS = 30 * 60 * 1000;

function hmrcToQrcText(raw) {
    const out = [];
    String(raw || '').replace(/\r\n/g, '\n').split('\n').forEach((line) => {
        line = line.trim();
        if (!line || line[0] !== '[') return;
        const end = line.indexOf(']');
        if (end < 0) return;
        const head = line.slice(1, end);
        const pair = head.split(',');
        if (pair.length !== 2) return;
        const lineStart = Number(pair[0]);
        const lineDur = Number(pair[1]);
        if (!Number.isFinite(lineStart) || !Number.isFinite(lineDur)) return;
        let rest = line.slice(end + 1);
        // 粤语罗马音 / 翻译在 ^ 之后，QRC 只保留正文
        const caret = rest.indexOf('^');
        if (caret >= 0) rest = rest.slice(0, caret);
        const words = [];
        const reg = /<(\d+),(\d+)>([^<]*)/g;
        let match;
        while ((match = reg.exec(rest))) {
            const text = String(match[3] || '').replace(/[()]/g, '');
            if (!text) continue;
            const start = lineStart + (Number(match[1]) || 0);
            const dur = Number(match[2]) || 0;
            words.push('(' + start + ',' + Math.max(1, dur) + ',0)' + text);
        }
        if (!words.length) return;
        out.push('[' + lineStart + ',' + Math.max(1, lineDur) + ']' + words.join(''));
    });
    return out.join('\n');
}

async function fetchHuaweiText(url) {
    if (!isHuaweiResourceUrl(url)) return '';
    const res = await requestBuffer(url, { timeoutMs: 8000 });
    if (res.status < 200 || res.status >= 300) return '';
    return res.buffer.toString('utf8');
}

async function handleHuaweiLyric(id) {
    id = normalizeText(id);
    if (!id) return { provider: 'huawei', lyric: '', yrc: '', tlyric: '', error: 'missing_id' };
    const cached = huaweiLyricCache.get(id);
    if (cached && Date.now() - cached.at < HUAWEI_LYRIC_TTL_MS) return cached.value;
    try {
        const { json } = await resolveHuaweiPlayback(id, '1');
        const { lrc, hmrc } = huaweiLyricAddresses(json);
        let lyricText = '';
        let yrcText = '';
        if (hmrc) {
            try {
                const raw = await fetchHuaweiText(hmrc);
                yrcText = hmrcToQrcText(raw);
            } catch (_) {}
        }
        if (lrc) {
            try { lyricText = await fetchHuaweiText(lrc); } catch (_) {}
        }
        if (!lyricText && !yrcText) {
            return { provider: 'huawei', lyric: '', yrc: '', tlyric: '', source: 'huawei-music', error: 'no_lyric' };
        }
        const value = {
            provider: 'huawei',
            lyric: lyricText,
            yrc: yrcText,
            tlyric: '',
            source: 'huawei-music',
        };
        huaweiLyricCache.set(id, { at: Date.now(), value });
        if (huaweiLyricCache.size > 200) {
            const oldest = [...huaweiLyricCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (oldest) huaweiLyricCache.delete(oldest[0]);
        }
        return value;
    } catch (err) {
        return { provider: 'huawei', lyric: '', yrc: '', tlyric: '', source: 'huawei-music', error: err && err.message || String(err) };
    }
}

// ── 收藏（我喜欢的音乐） ─────────────────────────────────────

// 用户歌单：favorite/simple/all 返回的是「收藏/自己的歌单/榜单」，不是曲目。
// contentType: 4=收藏歌单, 5=自己的歌单, 7=榜单（与 tinglan 一致）
async function handleHuaweiUserPlaylists(limit, offset) {
    const session = readHuaweiSession();
    if (!session) {
        return { provider: 'huawei', configured: true, loggedIn: false, playlists: [] };
    }
    limit = Math.max(1, Math.min(200, Number(limit) || 50));
    offset = Math.max(0, Number(offset) || 0);
    const json = await musicPost('/music-userbehavior-service/v3/service/favorite/simple/all', {
        targetSnsUserID: session.snsUserID,
        start: offset,
        limit,
        contentTypes: [4, 5, 7],
    }, session.token);
    const kinds = { 4: 'collected', 5: 'owned', 7: 'chart' };
    const playlists = [];
    (Array.isArray(json.favoriteInfos) ? json.favoriteInfos : []).forEach((item) => {
        const id = normalizeText(item && item.contentID);
        const name = normalizeText(item && item.contentName);
        const kind = kinds[Number(item && item.contentType)];
        if (!id || !name || !kind) return;
        playlists.push({
            provider: 'huawei',
            id,
            name,
            cover: huaweiCover(item && item.picture),
            trackCount: Number(item && item.totalCount) || 0,
            kind,
            source: 'huawei',
        });
    });
    const rawCount = Array.isArray(json.favoriteInfos) ? json.favoriteInfos.length : 0;
    return { provider: 'huawei', configured: true, loggedIn: true, playlists, hasMore: rawCount >= limit };
}

// 歌单曲目（自己的歌单走 bymusiclistid；收藏/榜单同端点通常也适用）
async function handleHuaweiPlaylistTracks(id, offset, limit) {
    id = normalizeText(id);
    const session = readHuaweiSession();
    if (!session) {
        return { provider: 'huawei', songs: [], loggedIn: false, error: 'HUAWEI_LOGIN_REQUIRED' };
    }
    if (!id) return { provider: 'huawei', songs: [], error: 'HUAWEI_PLAYLIST_ID_REQUIRED' };
    offset = Math.max(0, Number(offset) || 0);
    limit = Math.max(1, Math.min(100, Number(limit) || 50));
    // 自己的歌单走 playListID（playListInfoEx.playListSongInfoList）；
    // 收藏/榜单等走 musiclist/detail/bymusiclistid（musicListInfoEx.songSimpleInfos）。
    let songs = [];
    try {
        const ownedUrl = HUAWEI_API_BASE + '/music-userbehavior-service/v1/service/playlist/detail/all'
            + '?playListID=' + encodeURIComponent(id)
            + '&start=' + offset + '&limit=' + limit;
        const res = await requestBuffer(ownedUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': musicAuthHeader(session.token),
            },
            timeoutMs: 15000,
            maxBytes: 16 * 1024 * 1024,
        });
        const json = JSON.parse(res.buffer.toString('utf8') || '{}');
        const detail = safeParse(json && json.playListInfoEx, {});
        const all = normalizeHuaweiTracks(detail && detail.playListSongInfoList);
        // 该端点无视 limit，一次返回整张歌单；这里按请求窗口切片
        songs = all.slice(offset, offset + limit);
        if (all.length > 0) {
            return {
                provider: 'huawei',
                configured: true,
                loggedIn: true,
                songs,
                tracks: songs,
                rawCount: songs.length,
                total: all.length,
                offset,
                hasMore: offset + songs.length < all.length,
                source: 'huawei-music',
            };
        }
    } catch (_) {
        songs = [];
    }
    if (!songs.length) {
        const json = await musicPost('/music-operation-service/v2/service/musiclist/detail/bymusiclistid', {
            musicListID: id,
            copyrightSwitch: '1',
            start: offset,
            limit: String(limit),
        }, session.token);
        const detail = safeParse(json && json.musicListInfoEx, {});
        songs = normalizeHuaweiTracks(detail && detail.songSimpleInfos);
    }
    return {
        provider: 'huawei',
        configured: true,
        loggedIn: true,
        songs,
        tracks: songs,
        rawCount: songs.length,
        total: songs.length,
        offset,
        hasMore: songs.length >= limit,
        source: 'huawei-music',
    };
}

// ── 写操作（喜欢 / 歌单） ───────────────────────────────────

async function huaweiFavoriteExist(token, id) {
    const url = HUAWEI_API_BASE + '/music-userbehavior-service/v1/service/favorite/simple/exist'
        + '?contentType=1&contentID=' + encodeURIComponent(id);
    const res = await requestBuffer(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'Authorization': musicAuthHeader(token) },
        timeoutMs: 8000,
    });
    const json = JSON.parse(res.buffer.toString('utf8') || '{}');
    const exist = normalizeText(json && json.exist);
    if (exist !== '0' && exist !== '1') throw Object.assign(new Error('HUAWEI_FAVORITE_STATE_UNKNOWN'), { code: 'HUAWEI_FAVORITE_STATE_UNKNOWN' });
    return exist === '1';
}

async function handleHuaweiLikeCheck(ids) {
    const session = readHuaweiSession();
    const liked = {};
    if (!session) return { provider: 'huawei', liked, loggedIn: false };
    const list = (Array.isArray(ids) ? ids : []).map(normalizeText).filter(Boolean).slice(0, 50);
    await Promise.all(list.map(async (id) => {
        try {
            liked[id] = await huaweiFavoriteExist(session.token, id);
        } catch (_) {}
    }));
    return { provider: 'huawei', liked, loggedIn: true };
}

async function handleHuaweiSetLike(id, liked) {
    id = normalizeText(id);
    if (!id) throw Object.assign(new Error('HUAWEI_TRACK_ID_REQUIRED'), { code: 'HUAWEI_TRACK_ID_REQUIRED' });
    const session = readHuaweiSession();
    if (!session) throw Object.assign(new Error('HUAWEI_LOGIN_REQUIRED'), { code: 'HUAWEI_LOGIN_REQUIRED' });
    const target = !!liked;
    const current = await huaweiFavoriteExist(session.token, id).catch(() => null);
    if (current === target) return { provider: 'huawei', success: true, liked: target, unchanged: true };
    await musicCall('/music-userbehavior-service/v1/service/favorite/' + (target ? 'create' : 'delete'), {
        contentType: '1',
        contentID: id,
    });
    // 回读确认（失败不重试，交给前端提示）
    let confirmed = null;
    try {
        confirmed = await huaweiFavoriteExist(session.token, id);
    } catch (_) {}
    return { provider: 'huawei', success: true, liked: confirmed == null ? target : confirmed };
}

async function handleHuaweiPlaylistAddSong(playlistId, songId) {
    playlistId = normalizeText(playlistId);
    songId = normalizeText(songId);
    if (!playlistId || !songId) throw Object.assign(new Error('HUAWEI_PLAYLIST_ARGS_REQUIRED'), { code: 'HUAWEI_PLAYLIST_ARGS_REQUIRED' });
    await musicCall('/music-userbehavior-service/v1/service/playlist/song/create', {
        playListID: playlistId,
        songCodes: [songId],
    });
    return { provider: 'huawei', ok: true, success: true, playlistId, songId };
}

async function handleHuaweiPlaylistRemoveSong(playlistId, songId) {
    playlistId = normalizeText(playlistId);
    songId = normalizeText(songId);
    if (!playlistId || !songId) throw Object.assign(new Error('HUAWEI_PLAYLIST_ARGS_REQUIRED'), { code: 'HUAWEI_PLAYLIST_ARGS_REQUIRED' });
    await musicCall('/music-userbehavior-service/v1/service/playlist/song/delete', {
        playListID: playlistId,
        songCodes: [songId],
    });
    return { provider: 'huawei', ok: true, success: true, playlistId, songId };
}

async function handleHuaweiCreatePlaylist(name, songIds) {
    name = normalizeText(name);
    const ids = (Array.isArray(songIds) ? songIds : []).map(normalizeText).filter(Boolean).slice(0, 200);
    if (!name || name.length > 60) throw Object.assign(new Error('HUAWEI_PLAYLIST_NAME_INVALID'), { code: 'HUAWEI_PLAYLIST_NAME_INVALID' });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const createTime = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
        + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds());
    const json = await musicCall('/music-userbehavior-service/v1/service/playlist/create', {
        createTime,
        playListName: name,
        songCodes: ids,
        shareFlag: '0',
    });
    const id = normalizeText(json && (json.playListID || json.playlistID));
    if (!id) throw Object.assign(new Error('HUAWEI_PLAYLIST_CREATE_UNCONFIRMED'), { code: 'HUAWEI_PLAYLIST_CREATE_UNCONFIRMED' });
    return { provider: 'huawei', ok: true, success: true, id, playlistId: id, name, count: ids.length };
}

function clearHuaweiLogin() {
    clearHuaweiSession();
    huaweiOAuthAttempt = null;
    huaweiPlaybackCache.clear();
    huaweiLyricCache.clear();
    return { provider: 'huawei', ok: true, loggedIn: false };
}

module.exports = {
    HUAWEI_LOGIN_PARTITION,
    HUAWEI_REDIRECT_URI,
    HUAWEI_CLIENT_ID,
    isHuaweiLoginUrl,
    isHuaweiCallbackUrl,
    isHuaweiResourceUrl,
    createHuaweiOAuthAttempt,
    acceptHuaweiOAuthCallback,
    exchangeHuaweiOAuthCode,
    validateHuaweiSession,
    getHuaweiStatus,
    handleHuaweiStatusWithVerify,
    handleHuaweiSearch,
    handleHuaweiSongUrl,
    handleHuaweiLyric,
    handleHuaweiPlaylistTracks,
    handleHuaweiUserPlaylists,
    handleHuaweiLikeCheck,
    handleHuaweiSetLike,
    handleHuaweiPlaylistAddSong,
    handleHuaweiPlaylistRemoveSong,
    handleHuaweiCreatePlaylist,
    refreshHuaweiSession,
    clearHuaweiLogin,
    readHuaweiSession,
    // 测试用
    _test: {
        hmrcToQrcText,
        normalizeHuaweiTrack,
        musicAuthHeader,
    },
};
