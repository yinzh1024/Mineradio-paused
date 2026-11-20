'use strict';

/**
 * Mineradio MPRIS 2 服务（仅 Linux）
 * - 在 session bus 注册 org.mpris.MediaPlayer2.mineradio
 * - 暴露 org.mpris.MediaPlayer2 与 .Player 接口：播放状态、元数据、媒体按键控制
 * - 与渲染进程通过 IPC 同步状态、转发 Play/Pause/Next/Previous/Seek 指令
 */

const { app, ipcMain, BrowserWindow } = require('electron');

let DBus = null;
let bus = null;
let enabled = false;

const SERVICE_NAME = 'org.mpris.MediaPlayer2.mineradio';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';

let currentState = {
  playing: false,
  metadata: {},
  volume: 1.0,
  position: 0,
  canGoNext: true,
  canGoPrevious: true,
  canSeek: true,
  canPlay: true,
  canPause: true,
  canControl: true,
};

function shouldEnable() {
  return process.platform === 'linux' && !process.env.MINERADIO_MPRIS_DISABLE;
}

function sendToRenderer(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send('mpris-action', payload); } catch (_) {}
    }
  }
}

function emitPropertiesChanged(interfaceName, changed, invalidated) {
  if (!bus) return;
  try {
    bus.emitPropertiesChanged(OBJECT_PATH, interfaceName, changed, invalidated);
  } catch (e) {
    console.warn('[MPRIS] emitPropertiesChanged 失败:', e && e.message || e);
  }
}

function buildMetadataVariant() {
  const meta = currentState.metadata || {};
  const out = {};
  if (meta.title) out['xesam:title'] = new DBus.Variant('s', String(meta.title));
  if (meta.artist) out['xesam:artist'] = new DBus.Variant('as', [String(meta.artist)]);
  if (meta.album) out['xesam:album'] = new DBus.Variant('s', String(meta.album));
  if (meta.artUrl) out['mpris:artUrl'] = new DBus.Variant('s', String(meta.artUrl));
  const tid = String(meta.trackId || '');
  if (tid) out['mpris:trackid'] = new DBus.Variant('o', OBJECT_PATH + '/track/' + tid);
  const len = Number(meta.length);
  if (isFinite(len) && len > 0) out['mpris:length'] = new DBus.Variant('x', Math.floor(len * 1e6));
  // a{sv} 属性按声明类型封装，返回裸对象即可（dbus-native 按声明类型序列化）
  return out;
}

async function start() {
  if (!shouldEnable() || enabled) return false;
  try {
    DBus = require('dbus-native');
  } catch (e) {
    console.warn('[MPRIS] dbus-native 未安装，系统媒体控制不可用:', e.message);
    return false;
  }

  try {
    bus = DBus.sessionBus();
    bus.on('error', () => {});
  } catch (e) {
    console.warn('[MPRIS] session bus 连接失败:', e.message);
    bus = null;
    return false;
  }

  const result = await new Promise((resolve) => {
    bus.requestName(SERVICE_NAME, 0, (err, reply) => resolve(err ? { err } : { reply }));
  });
  if (result.err) {
    console.warn('[MPRIS] 名称占用:', result.err.message);
    bus = null;
    return false;
  }
  enabled = true;

  // ---- org.mpris.MediaPlayer2 根接口 ----
  const rootIface = DBus.defineInterface({
    name: 'org.mpris.MediaPlayer2',
    methods: {
      Raise: { in: {}, out: {}, handler: () => sendToRenderer({ action: 'raise' }) },
      Quit: { in: {}, out: {}, handler: () => app.quit() },
    },
    properties: {
      Identity: { type: 's', get: () => 'Mineradio' },
      DesktopEntry: { type: 's', get: () => 'mineradio' },
      CanQuit: { type: 'b', get: () => true },
      CanRaise: { type: 'b', get: () => true },
      HasTrackList: { type: 'b', get: () => false },
      SupportedUriSchemes: { type: 'as', get: () => [] },
      SupportedMimeTypes: { type: 'as', get: () => [] },
      CanSetFullscreen: { type: 'b', get: () => false },
    },
  });

  // ---- org.mpris.MediaPlayer2.Player 接口 ----
  const playerIface = DBus.defineInterface({
    name: 'org.mpris.MediaPlayer2.Player',
    methods: {
      Play: { in: {}, out: {}, handler: () => sendToRenderer({ action: 'play' }) },
      Pause: { in: {}, out: {}, handler: () => sendToRenderer({ action: 'pause' }) },
      PlayPause: { in: {}, out: {}, handler: () => sendToRenderer({ action: 'play-pause' }) },
      Stop: { in: {}, out: {}, handler: () => sendToRenderer({ action: 'stop' }) },
      Next: { in: {}, out: {}, handler: () => sendToRenderer({ action: 'next' }) },
      Previous: { in: {}, out: {}, handler: () => sendToRenderer({ action: 'previous' }) },
      Seek: {
        in: { Offset: 'x' },
        out: {},
        handler: (args) => sendToRenderer({ action: 'seek', offset: Number(args.Offset) }),
      },
      SetPosition: {
        in: { TrackId: 'o', Position: 'x' },
        out: {},
        handler: (args) => sendToRenderer({
          action: 'set-position',
          trackId: String(args.TrackId),
          position: Number(args.Position),
        }),
      },
      OpenUri: {
        in: { Uri: 's' },
        out: {},
        handler: (args) => sendToRenderer({ action: 'open-uri', uri: String(args.Uri) }),
      },
    },
    properties: {
      PlaybackStatus: { type: 's', get: () => (currentState.playing ? 'Playing' : 'Paused') },
      LoopStatus: { type: 's', get: () => 'None' },
      Rate: { type: 'd', get: () => 1.0 },
      Shuffle: { type: 'b', get: () => false },
      Metadata: { type: 'a{sv}', get: () => buildMetadataVariant() },
      Volume: {
        type: 'd',
        get: () => currentState.volume,
        set: (v) => {
          const vol = Math.max(0, Math.min(1, Number(v)));
          currentState.volume = vol;
          sendToRenderer({ action: 'volume', volume: vol });
          emitPropertiesChanged('org.mpris.MediaPlayer2.Player', { Volume: vol }, []);
        },
      },
      Position: { type: 'x', get: () => Math.floor(currentState.position) },
      MinimumRate: { type: 'd', get: () => 1.0 },
      MaximumRate: { type: 'd', get: () => 1.0 },
      CanGoNext: { type: 'b', get: () => currentState.canGoNext },
      CanGoPrevious: { type: 'b', get: () => currentState.canGoPrevious },
      CanPlay: { type: 'b', get: () => currentState.canPlay },
      CanPause: { type: 'b', get: () => currentState.canPause },
      CanSeek: { type: 'b', get: () => currentState.canSeek },
      CanControl: { type: 'b', get: () => currentState.canControl },
    },
  });

  bus.exportInterface(rootIface.impl, OBJECT_PATH, rootIface.descriptor);
  bus.exportInterface(playerIface.impl, OBJECT_PATH, playerIface.descriptor);

  // ---- IPC：渲染进程上报播放状态 ----
  ipcMain.handle('mpris-update-state', (_event, state) => {
    if (!state || typeof state !== 'object') return false;
    const prevPlaying = currentState.playing;
    if (state.playing !== undefined) currentState.playing = !!state.playing;
    if (state.metadata && typeof state.metadata === 'object') currentState.metadata = state.metadata;
    if (typeof state.volume === 'number') currentState.volume = state.volume;
    if (typeof state.position === 'number') currentState.position = state.position;
    if (state.canGoNext !== undefined) currentState.canGoNext = !!state.canGoNext;
    if (state.canGoPrevious !== undefined) currentState.canGoPrevious = !!state.canGoPrevious;
    if (state.canSeek !== undefined) currentState.canSeek = !!state.canSeek;
    if (state.canPlay !== undefined) currentState.canPlay = !!state.canPlay;
    if (state.canPause !== undefined) currentState.canPause = !!state.canPause;
    if (state.canControl !== undefined) currentState.canControl = !!state.canControl;

    const changed = {};
    if (state.playing !== undefined && state.playing !== prevPlaying) {
      changed.PlaybackStatus = state.playing ? 'Playing' : 'Paused';
    }
    if (typeof state.volume === 'number') changed.Volume = state.volume;
    if (typeof state.position === 'number') {
      changed.Position = Math.floor(state.position);
    }
    if (state.metadata && typeof state.metadata === 'object') {
      changed.Metadata = buildMetadataVariant();
    }
    if (Object.keys(changed).length) {
      emitPropertiesChanged('org.mpris.MediaPlayer2.Player', changed, []);
    }
    return true;
  });

  ipcMain.handle('mpris-get-status', () => ({
    available: enabled,
    serviceName: SERVICE_NAME,
    objectPath: OBJECT_PATH,
  }));

  console.log('[MPRIS] 系统媒体控制已启用:', SERVICE_NAME);
  return true;
}

function stop() {
  if (bus) {
    try { bus.close(); } catch (_) {}
  }
  bus = null;
  enabled = false;
}

module.exports = { start, stop, shouldEnable };
