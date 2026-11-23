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

## 修复一：签名后端（本机 Docker，首选）

签名服务在本机 Docker 里跑（`libmssdk` 官方 deploy：Wine + Windows Node 20 加载
汽水客户端自带的 `bdms.node`），Mineradio 只连 `127.0.0.1:8899`，**不依赖 VM / SSH**。

**一次性准备（Omarchy）**

```bash
# 1) docker 开机自启（需要 sudo）
sudo systemctl enable --now docker

# 2) 从自己的 Windows 汽水客户端拷两个文件（也可经 SSH 从 VM 拷）：
#    <汽水客户端>\resources\app.asar.unpacked\bdms.node
#    <汽水客户端>\resources\app.asar.unpacked\metasecml.dll
#    本机存放：
#    ~/tools/mineradio-signer/soda-client/3.7.0/resources/app.asar.unpacked/

# 3) deploy/.env（token 与 ~/.config/mineradio.env 保持一致）
#    LIBMSSDK_TOKEN=<token>
#    LIBMSSDK_BIND=127.0.0.1
#    LIBMSSDK_CLIENT_DIR=/home/yinzh/tools/mineradio-signer/soda-client/3.7.0
#    LIBMSSDK_DATA_PATH=~/tools/mineradio-signer/data
#    LIBMSSDK_WINE_PATH=~/tools/mineradio-signer/wine

# 4) 构建并启动（首次构建要拉 WineHQ/Node，约 5–10 分钟；Wine prefix 首启约 1.5GB）
cd ~/tools/mineradio-signer/libmssdk/deploy
sudo docker compose up -d --build
```

容器 `restart: unless-stopped` + docker 服务开机自启 → 重启后自动恢复。

**签名配置（被 `~/.local/bin/mineradio` 启动脚本 source）**

```bash
~/.config/mineradio.env
export MINERADIO_QISHUI_SIGNER_URL=http://127.0.0.1:8899
export MINERADIO_QISHUI_SIGNER_TOKEN=<token>
```

> **必须写 `export`**：启动脚本用 `source` 读文件，不带 `export` 的变量只是 shell 变量，
> 不会进入 Electron 主进程环境。

**备选：VM + SSH 隧道（VM 有 Node/bdms 时的老方案，保留作回退）**

VM `C:\Users\yinzh\mineradio-signer\`（计划任务 `MineradioSigner`）+
本机 `~/.config/systemd/user/mineradio-signer-tunnel.service`。
两者指向同一个 `127.0.0.1:8899`，**同一时间只启用一个**，否则端口冲突。

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
