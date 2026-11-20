/* global playQueue, currentIdx, playing, audio, playQueueAt, togglePlay, nextTrack, prevTrack, setPlayIcon, setPlaybackVolume, seekToPosition, seekBy */
/* 系统媒体控制（MPRIS）客户端：把播放状态上报主进程，响应 Play/Pause/Next/Previous/Seek 指令。 */

(function () {
  var MPRIS_CHANNEL = '__mineradioMprisClient';
  if (window[MPRIS_CHANNEL]) return window[MPRIS_CHANNEL];
  var coils = window[MPRIS_CHANNEL] = {
    enabled: false,
    lastPush: 0,
    _unsubscribe: null,
    timer: 0,
    onPlayStateChange: function () {},  // 占位，enable 后替换为 push
  };

  function song() {
    return (Array.isArray(playQueue) && currentIdx >= 0 && currentIdx < playQueue.length)
      ? playQueue[currentIdx]
      : null;
  }

  function coverFor(s) {
    if (!s) return '';
    var c = s.cover || s.albumCover || '';
    if (typeof coverUrlWithSize === 'function') {
      var sized = coverUrlWithSize(c, 600);
      if (sized) return sized;
    }
    return c;
  }

  function buildMetadata() {
    var s = song();
    if (!s) return {};
    var meta = {
      title: String(s.name || s.title || ''),
      artist: String(s.artist || s.singer || ''),
      album: String(s.album || ''),
      trackId: String(s.id || s.mid || s.hash || 'unknown-' + (currentIdx || 0)),
      length: 0,
    };
    if (audio && typeof audio.duration === 'number' && isFinite(audio.duration)) {
      meta.length = audio.duration;
    }
    var cover = coverFor(s);
    if (cover) meta.artUrl = cover;
    return meta;
  }

  function push(extra) {
    if (!coils.enabled) return;
    if (window.desktopWindow && typeof window.desktopWindow.updateMprisState === 'function') {
      var s = song();
      var payload = {
        playing: !!playing,
        position: audio && typeof audio.currentTime === 'number' ? audio.currentTime * 1e6 : 0,
        canGoNext: !!nextTrack,
        canGoPrevious: !!prevTrack,
        canSeek: !!audio,
        canPlay: true,
        canPause: true,
        canControl: true,
        metadata: buildMetadata(),
      };
      window.desktopWindow.updateMprisState(payload);
      coils.lastPush = Date.now();
    }
  }

  // 监听 MPRIS 指令
  function handleAction(action) {
    if (!action || !action.action) return;
    try {
      console.log('[MPRIS] 收到指令:', action.action,
        '| nextTrack:', typeof nextTrack,
        '| prevTrack:', typeof prevTrack,
        '| playQueueAt:', typeof playQueueAt,
        '| playQueue len:', Array.isArray(playQueue) ? playQueue.length : -1,
        '| currentIdx:', currentIdx);
    } catch (e) {
      console.log('[MPRIS] debug err:', e.message);
    }
    switch (action.action) {
      case 'play':
        if (typeof togglePlay === 'function') {
          // 兜底：无队列时尝试恢复播放（首页「继续播放」）
          if ((!playQueue || !playQueue.length || currentIdx < 0) && typeof resumeHomeDashboardPlayback === 'function') {
            console.log('[MPRIS] 无播放队列，尝试恢复首页播放');
            resumeHomeDashboardPlayback();
          } else {
            togglePlay(true);
          }
        }
        break;
      case 'pause':
        if (typeof togglePlay === 'function') togglePlay(false);
        break;
      case 'play-pause':
        if (typeof togglePlay === 'function') {
          if ((!playQueue || !playQueue.length || currentIdx < 0) && typeof resumeHomeDashboardPlayback === 'function') {
            console.log('[MPRIS] 无播放队列，尝试恢复首页播放');
            resumeHomeDashboardPlayback();
          } else {
            togglePlay();
          }
        }
        break;
      case 'next':
        if (typeof nextTrack === 'function') nextTrack();
        else if (typeof playQueueAt === 'function' && Array.isArray(playQueue)) {
          playQueueAt(currentIdx + 1, { trackSwitch: true });
        }
        break;
      case 'previous':
        if (typeof prevTrack === 'function') prevTrack();
        else if (typeof playQueueAt === 'function' && Array.isArray(playQueue)) {
          playQueueAt(Math.max(0, currentIdx - 1), { trackSwitch: true });
        }
        break;
      case 'stop':
        if (typeof togglePlay === 'function') togglePlay(false);
        break;
      case 'seek':
        if (audio && typeof action.offset === 'number') {
          var target = audio.currentTime + action.offset / 1e6;
          if (typeof seekToPosition === 'function') seekToPosition(Math.max(0, target));
          else if (typeof seekBy === 'function') seekBy(action.offset / 1e6);
          else {
            try { audio.currentTime = Math.max(0, target); } catch (_) {}
          }
        }
        break;
      case 'set-position':
        if (audio && typeof action.position === 'number' && typeof seekToPosition === 'function') {
          seekToPosition(action.position / 1e6);
        }
        break;
      case 'volume':
        if (typeof action.volume === 'number') {
          if (typeof setPlaybackVolume === 'function') setPlaybackVolume(action.volume);
          else if (audio) { try { audio.volume = Math.max(0, Math.min(1, action.volume)); } catch (_) {} }
        }
        break;
      default:
        break;
    }
    // 指令执行后稍作延迟再同步（等渲染更新）
    setTimeout(push, 80);
  }

  function enable() {
    if (coils.enabled || !window.desktopWindow) return;
    if (typeof window.desktopWindow.onMprisAction !== 'function') return;
    coils.enabled = true;
    coils._unsubscribe = window.desktopWindow.onMprisAction(handleAction);
    // 把 onPlayStateChange 从占位替换为真正的状态上报
    coils.onPlayStateChange = function (_playing) {
      setTimeout(push, 60);
    };
    // 猴子补丁：在 playQueueAt（切歌/重新播放）后也同步元数据与位置
    if (typeof window.playQueueAt === 'function' && !window.playQueueAt.__mprisPatched) {
      var origPlayQueueAt = window.playQueueAt;
      window.playQueueAt = function (idx, opts) {
        var ret = origPlayQueueAt.apply(this, arguments);
        if (ret && typeof ret.then === 'function') {
          ret.then(function () { setTimeout(push, 120); }).catch(function () {});
        } else {
          setTimeout(push, 120);
        }
        return ret;
      };
      window.playQueueAt.__mprisPatched = true;
    }
    window.desktopWindow.getMprisStatus && window.desktopWindow.getMprisStatus();
    setTimeout(push, 200);
  }

  // 兜底：即便状态机没在播放变更时调用 push，也周期性轻同步一次
  function startHeartbeat() {
    if (coils.timer) return;
    coils.timer = setInterval(function () {
      if (coils.enabled) push();
    }, 1500);
  }

  function onWindowEvent() {
    setTimeout(push, 120);
  }

  // 状态变更时的轻量同步（时间线跳转等）
  window.addEventListener('timeupdate', function () {
    if (coils.enabled && Date.now() - coils.lastPush > 800) push();
  });

  coils.enable = enable;
  coils.start = startHeartbeat;
  coils.onWindowEvent = onWindowEvent     // hooks 由状态机调用

  // ---- MediaSession API：让 Chromium 内置 MPRIS（系统媒体键默认通道）也响应切歌/暂停 ----
  // 系统 DE（GNOME/KDE/waybar/键盘媒体键）优先控制 Chromium 注册的
  // org.mpris.MediaPlayer2.chromium.instance*，而非我们的自定义服务；
  // 不注册 action handler 时该通道只支持 play/pause，next/previous 静默丢弃。
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    var ms = navigator.mediaSession;
    var bind = function (action, fn) {
      try { ms.setActionHandler(action, fn); } catch (_) { /* 不支持的 action 忽略 */ }
    };
    bind('play', function () {
      if ((!playQueue || !playQueue.length || currentIdx < 0) && typeof resumeHomeDashboardPlayback === 'function') {
        resumeHomeDashboardPlayback();
      } else if (typeof togglePlay === 'function') togglePlay(true);
    });
    bind('pause', function () { if (typeof togglePlay === 'function') togglePlay(false); });
    bind('previoustrack', function () { if (typeof prevTrack === 'function') prevTrack(true); });
    bind('nexttrack', function () { if (typeof nextTrack === 'function') nextTrack(true); });
    bind('seekbackward', function () { if (audio) { try { audio.currentTime = Math.max(0, audio.currentTime - 10); } catch (_) {} } });
    bind('seekforward', function () { if (audio) { try { audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 10); } catch (_) {} } });
    try { ms.playbackState = 'none'; } catch (_) {}
  }

  // 同步 MediaSession 元数据（曲名/歌手/封面）+ 播放状态，系统媒体面板由此取数
  function syncMediaSessionMetadata() {
    if (!('mediaSession' in navigator)) return;
    var s = song();
    var meta = {};
    if (s && s.name) {
      meta.title = String(s.name || s.title || '');
      if (s.artist) meta.artist = String(s.artist || '');
      if (s.album) meta.album = String(s.album || '');
      var cover = coverFor(s);
      if (cover) meta.artwork = [{ src: cover, sizes: '512x512', type: 'image/jpeg' }];
    }
    try {
      navigator.mediaSession.metadata = meta.title ? new MediaMetadata(meta) : null;
      navigator.mediaSession.playbackState = playing ? 'playing' : (meta.title ? 'paused' : 'none');
    } catch (_) {}
  }

  // push 时顺带同步 MediaSession
  var origPush = push;
  push = function (extra) {
    origPush(extra);
    syncMediaSessionMetadata();
  };

  // 桌面窗口（有 preload）就绪后自动启用 MPRIS，并启动心跳兜底
  function autoEnable() {
    setupMediaSession();
    syncMediaSessionMetadata();
    if (window.desktopWindow) {
      coils.enable();
      coils.start();
    }
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(autoEnable, 300);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(autoEnable, 300);
    });
  }
  window.addEventListener('load', function () {
    setTimeout(autoEnable, 400);
  });
})(window);