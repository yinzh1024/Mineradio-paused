# 汽水音乐 VIP 曲目只播 30 秒试听（Linux 端）

## 现象

账号是汽水 VIP，但 `fee=1`（VIP 专享）曲目只能播一段就停；`fee=0` 曲目正常整曲。
播放器没有任何"试听"提示，看起来像"播放了一部分"。

## 根因（2026-11-23 实测）

Linux 上没有汽水客户端，因此拿不到 `bdms.node`，`qishui-bdms-signer` 不可用 →
`/luna/pc/track_v2` 走**未签名**通道。服务端对这种请求只回 30/60 秒试听流，
并且把回包里的 `track.duration` 也裁成试听长度，导致旧的试听判定
（`流时长 + 5 < track.duration`）永远不成立 → 不显示试听提示。

实测对照（同一首 fee=1、曲目 375s）：

| 通道 | 返回时长 | 大小 |
| --- | --- | --- |
| 未签名 | 30s | 487 KB |
| 签名（VM 上的 libmssdk） | 376s | 6.2 MB |

## 修复一：签名后端（VM + SSH 隧道）

签名服务跑在 Windows VM 上（`libmssdk`，用它自己装的汽水客户端里的 `bdms.node`），
本机通过 SSH 隧道访问，Mineradio 只连 `127.0.0.1:8899`。

**VM（10.160.42.120）**

```powershell
# 目录
C:\Users\yinzh\mineradio-signer\
  libmssdk\           # 签名服务
  node\node.exe       # Windows 版 Node（v22）
  serve.cmd           # 设置 LIBMSSDK_* 并启动 serve

# 计划任务：登录时自启
schtasks /create /f /tn MineradioSigner /tr "C:\Users\yinzh\mineradio-signer\serve.cmd" /sc onlogon /rl highest
```

`serve.cmd` 关键变量：

```bat
set "LIBMSSDK_CLIENT_DIR=D:\AppData\Local\Programs\Soda Music\3.7.0"
set "LIBMSSDK_TOKEN=<token，见本机 ~/tools/mineradio-signer/signer-token.txt>"
```

> 汽水客户端目录是 `%LOCALAPPDATA%\Programs\Soda Music` 的 junction，指向 `D:\...`；
> 直接给 `LIBMSSDK_CLIENT_DIR` 用 D 盘真实路径，避免 "untrusted mount point"。

**本机（Omarchy）**

```bash
# 隧道常驻（systemd user）：本地 8899 → VM 127.0.0.1:8899
~/.config/systemd/user/mineradio-signer-tunnel.service
systemctl --user enable --now mineradio-signer-tunnel.service

# 签名配置（被 ~/.local/bin/mineradio 启动脚本 source）
~/.config/mineradio.env
export MINERADIO_QISHUI_SIGNER_URL=http://127.0.0.1:8899
export MINERADIO_QISHUI_SIGNER_TOKEN=<token>
```

> **必须写 `export`**：启动脚本用 `source` 读文件，不带 `export` 的变量只是 shell 变量，
> 不会进入 Electron 主进程环境。

## 修复二：试听识别与自动换源

即使签名不可用或曲目确实只有试听授权，也不能静默播 30 秒：

- 前端（`public/js/modules/05-playback/13-playback-start-audio.js`）：
  取流结果时长明显短于曲目元数据时长（`song.duration`）时标 `data.trial = true`，
  并记录 `trialDuration`
- 后端（`qishui-api.js`）：从 `track.audition_info.duration_ms` 兜底识别试听档，
  配合 `label_info.only_vip_playable` 判断（服务端把 `track.duration` 裁短时仍能识别）
- 命中试听后：优先自动换到其它已登录平台（网易云 / QQ / 酷狗，走既有
  `tryAutoPlaybackFallback`）；换不到再播试听并弹出"仅播放试听片段（30 秒）"提示

## 验证

```bash
# 签名服务是否就绪
curl -s http://127.0.0.1:8899/livez

# 直接验证某首 fee=1 曲目拿到的时长（需带 QISHUI_QR_CONFIG_FILE，签名通道要用设备号）
cd <repo> && QISHUI_QR_CONFIG_FILE=$HOME/.config/Mineradio/.qishui-qr-login.json \
  MINERADIO_QISHUI_SIGNER_URL=http://127.0.0.1:8899 \
  MINERADIO_QISHUI_SIGNER_TOKEN=<token> \
  node -e "const q=require('./qishui-api.js');const fs=require('fs');q.handleQishuiSongUrl({id:'<trackId>'},fs.readFileSync(process.env.HOME+'/.config/Mineradio/.qishui-cookie','utf8')).then(r=>console.log(r.duration,r.trial))"
```

VM 侧 `serve-out.log` 出现 `"event":"sign"` 且 `path` 为 `track_v2` 即说明应用走了签名通道。

## 注意

- 签名服务等于把你账号的出口 IP/设备画像押上去，**只走本机 SSH 隧道，不要对公网开放**；
  VM 端保持只监听 `127.0.0.1:8899` + Token 鉴权
- VM 重启后需要用户登录，计划任务才会拉起签名服务；隧道服务会自动重连
