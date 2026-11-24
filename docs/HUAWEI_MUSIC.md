# 华为音乐接入（Mineradio provider）

协议参考开源项目 [talongao/tinglan](https://github.com/talongao/tinglan) 的
`native/internal/huawei/*.go`（Muyu 等第三方客户端的华为实现同源）。本仓库实现为
纯 JS provider，无原生依赖。

## 登录（两段式）

1. **华为账号 OAuth 2.0 + PKCE**（`huawei-api.js` `createHuaweiOAuthAttempt`）
   - `client_id=101444301`，`redirect_uri=hms://redirect_uri`，`scope=openid`，
     `access_type=offline`，`code_challenge_method=S256`，`countryCode=cn`
   - 在应用内 `BrowserWindow`（partition `persist:mineradio-huawei-login`）打开
     `https://oauth-login.platform.hicloud.com/oauth2/v3/authorize`
   - 自定义 scheme 回调用 `session.webRequest.onBeforeRequest({urls:['hms://*']})`
     拦截（`will-redirect`/`will-navigate` 兜底），校验 `state` 后取 `code`
2. **换音乐会话**：`access_token` → `POST /music-odpapp-service/v5/service/userinfo/loginex`
   → `{token, snsUserID, expireTime}`，存 `MINERADIO_HUAWEI_SESSION_FILE`
   （`~/.config/Mineradio/.huawei-session.json`，0600）

登录窗口允许域：`oauth-login.platform.hicloud.com`、`oauth-login.cloud.huawei.com`、
`id1.cloud.huawei.com`、`account.huawei.com`、`consumer.huawei.com`、
`oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback`。

## 请求头与响应

```
Authorization: Digest username=app-music-baseline, nonce=<随机>, created=<ISO8601>[, token=<会话>]
```

响应信封 `{result:{resultCode:"000000"}}`，非 `000000` 视为失败；`token expired` 类
消息会清空本地会话并要求重登。

## 端点

| 功能 | 端点 |
| --- | --- |
| 搜索 | `POST /music-search-service/v10/service/fuzzysearch`（免 token） |
| 取流 | `POST /music-play-service/v3/service/file/bycontentcode`（`qualityType` 1=标准，3=无损） |
| 歌词地址 | 取流响应 `songInfo.lyrics` 里的 `lineByLineLyric`（LRC）与 `wordByWordLyric`（HMRC） |
| 用户歌单 | `POST /music-userbehavior-service/v3/service/favorite/simple/all`（4=收藏、5=自己、7=榜单） |
| 歌单曲目（自己） | `GET /music-userbehavior-service/v1/service/playlist/detail/all?playListID=…` |
| 歌单曲目（收藏/榜单） | `POST /music-operation-service/v2/service/musiclist/detail/bymusiclistid` |
| 喜欢状态 | `GET /music-userbehavior-service/v1/service/favorite/simple/exist?contentType=1&contentID=…` |
| 喜欢/取消 | `POST /music-userbehavior-service/v1/service/favorite/create|delete`（`{contentType:"1", contentID}`） |
| 新建歌单 | `POST /music-userbehavior-service/v1/service/playlist/create`（`{createTime, playListName, songCodes, shareFlag:"0"}`） |
| 歌单加歌 | `POST /music-userbehavior-service/v1/service/playlist/song/create`（`{playListID, songCodes:[…]}`） |
| 歌单删歌 | `POST /music-userbehavior-service/v1/service/playlist/song/delete` |

## 试听识别

- 未登录时服务端给 30 秒预览：URL 不一定带 `/preview/`，但回包有 `auditionEnd`
  → 未登录 + `auditionEnd > 0` 判为试听
- 兜底：媒体 `loadedmetadata` 的真实时长明显短于曲目元数据（`song.duration`）时，
  标记试听并弹提示（所有 provider 通用）

## 会员状态 / 会话续期

- **会员状态**：无公开 userinfo 接口，用「无损取流能力」探测（固定 VIP+FLAC 曲目请求
  `qualityType=3`，返回 `playQuality=3` 即视为 VIP），结果缓存 12 小时；播放无损成功时也会
  顺带标记。状态写入会话文件，用户弹窗显示「华为音乐 VIP」
- **会话续期**：OAuth 时保存 `access_token` / `refresh_token`；音乐会话过期
  （`token expired`）时自动用 `refresh_token` 换新 access_token、重走 `loginex` 并重试一次。
  **注意**：该能力需要一次新的登录才会写入 `refresh_token`（旧会话文件没有该字段）

## 前端接入点

- 搜索：左上角「HW」页签（独立模式，不进聚合排序）
- 播放：`/api/huawei/song/url`，标准/无损两档，无损失败自动回落标准
- 歌词：`/api/huawei/lyric`，HMRC 逐字转换成本地 QRC 格式（`yrc` 字段），支持逐字卡拉 OK
- 账号：登录弹窗「华为音乐」节点、用户弹窗「华为音乐」页签、退出登录
- 歌单：播放列表面板新增「华为音乐歌单」分组（播放、加入队列、收藏到歌单、新建歌单）
- 喜欢：红心按钮读写（乐观更新 + 回读确认）

## 已知限制

- 会员状态是「无损取流探测」的推断，不是官方会员接口，可能因曲目下架/授权变化误判
- 刷新令牌只在新的登录后写入；老会话文件过期仍需重新登录
- 歌单重命名/删除/简介修改未接入 UI（后端已有删除/加歌/删歌能力）
- 非官方接口，可能随平台变更失效
