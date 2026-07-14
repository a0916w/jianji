# jianji 剪辑服务(Telegram 驱动 + 服务端渲染) — 设计方案

日期:2026-07-08
状态:已与用户确认,待写实现计划

## 一、目标

把 jianji(当前纯前端 `index.html` 智能剪辑工具)升级为一个**由 Telegram 驱动、服务端 ffmpeg 后台渲染**的剪辑服务:

1. Telegram 群里发一个**相册**(多个视频 + 多张图)+ 说明文字 → 系统下载存盘、入库。
2. **manual 模式**:生成剪辑链接发回群;人点进 jianji 页面(相册媒体已预加载)手动排列/选段/调参 → 提交 → 服务端 ffmpeg 后台渲染 → 成品发回群。
3. **auto 模式**:下载后直接套 jianji 现有智能选段默认参数生成剪辑方案 → 渲染 → 发回群,全程无人。
4. 模式由 `EDIT_MODE` 环境变量切换。

复用刚落地的 fengmiantu(手动选封面)那套 Telegram 集成 / 入口链接签名 / 下载 / 回传 / 安全加固代码。

## 二、非目标(YAGNI)

- 不做标题/文字烧录进画面(用户明确不要)。
- 不做用户账号 / 多租户 / 权限。
- 不做转码格式选择、画质档位等高级选项(先用固定合理默认)。
- 不做 web 后台管理界面(任务状态先靠 DB + 日志 + Telegram 消息)。

## 三、架构

- **技术栈**:Node(零 npm 依赖,沿用 fengmiantu 风格)+ 本机 ffmpeg/ffprobe + SQLite(单文件库)。
- **部署**:AWS「自动剪辑测试」机(18.163.100.253),与 fengmiantu 同机不同端口(如 3001)。非 root 用户运行,systemd 托管。
- **进程**:单进程内含
  - HTTP 服务:剪辑页 `/edit`、提交接口 `/api/submit`、静态资源。
  - Telegram 轮询/接收:收相册 → 下载 → 建任务(可复用现有 telegram 集成或 bot getUpdates)。
  - 后台 worker:轮询 DB 取"渲染中"任务 → ffmpeg 渲染 → 回传 → 标记完成。串行或小并发(ffmpeg 吃 CPU)。

### 单元边界

| 单元 | 职责 | 依赖 |
|---|---|---|
| `db.js` | SQLite 建表 + jobs 增删改查 | sqlite |
| `telegram.js` | 收相册(media_group 聚合)、下载媒体、发消息/成品 | Telegram Bot API |
| `caption.js` | 解析 caption → {title, description, tags[]} | 无 |
| `render.js` | 按 edit_spec 用 ffmpeg 合成视频 | ffmpeg |
| `smartcut.js` | 复刻 jianji 智能选段:视频挑运动量最大的 segLen 段 | ffmpeg(抽帧) |
| `server.js` | HTTP:剪辑页 + 提交接口 + 静态,装配以上 | http |
| `worker.js` | 后台取任务 → render → 回传 | db/render/telegram |
| `index.html` | jianji 剪辑页(改造:从任务预加载媒体 + 提交 spec 而非本地 MediaRecorder) | 无 |

## 四、数据模型(SQLite `jobs`)

```
id            INTEGER PK
tg_chat_id    TEXT      -- 来源群
tg_message_id TEXT      -- 相册首条消息 id(回传时引用)
media_group   TEXT      -- Telegram media_group_id(配对键)
media_json    TEXT      -- JSON: [{type:'video'|'image', path, tg_file_id}]
title         TEXT
description    TEXT
tags_json     TEXT      -- JSON 字符串数组
mode          TEXT      -- 'manual' | 'auto'
edit_spec     TEXT      -- JSON: {aspect, segLen, fade, clips:[{index,start,end,order}]}
status        TEXT      -- downloading | editing | rendering | done | failed
result_path   TEXT      -- 成品文件路径
error         TEXT
created_at    TEXT
updated_at    TEXT
```

状态机:`downloading → editing(仅manual,等提交) / rendering(auto直接) → rendering → done | failed`

## 五、流程

### manual 模式
1. 收到相册(同 media_group_id 的多条媒体聚合成一批)+ caption。
2. 下载所有媒体到本地任务目录;`caption.js` 拆出 title/desc/tags;建 job(status=editing)。
3. 生成签名剪辑链接 `EDIT_URL/edit?job=<id>&sign=<hmac>` 发回群。
4. 人打开 → 页面拉 `/api/job?job=&sign=` 拿到媒体列表 → 预加载进 jianji → 手动排序/选段/调比例转场。
5. 点"生成" → POST `/api/submit`{job,sign,edit_spec} → job.status=rendering,edit_spec 入库。
6. worker 取 rendering 任务 → `render.js` 按 spec ffmpeg 合成 → 成品存盘。
7. 成品发回群(引用原消息,带 title/desc/tags)→ job.status=done。

### auto 模式
- 1-2 同上,但建 job 后直接:`smartcut.js` 对每个视频算默认段(segLen=5) + 图片默认 3 秒 → 组装默认 edit_spec → status=rendering。
- 之后同 manual 的 6-7。

## 六、渲染引擎(复刻 jianji 现有行为)

jianji 现有默认(已从代码确认):
- 图片:静帧 3 秒。
- 视频:每段 5 秒;若视频 ≤ 5.3 秒用全片;否则抽 10~30 帧算相邻帧像素差(运动量),滑窗选运动量总和最大的 5 秒段。
- 转场:段间 0.35 秒淡入淡出。
- 比例:`auto` = 跟随第一个视频的横/竖屏;或用户在页面选 16:9 / 9:16 / 1:1。

ffmpeg 实现要点:
- 每个 clip 归一化到目标分辨率(scale + pad 保持比例),统一帧率/SAR。
- 图片 clip:`-loop 1 -t 3` 生成静帧视频段。
- 视频 clip:`-ss start -to end` 截取选中段。
- 段间 `xfade`(时长 0.35)拼接;或先各段导出再 concat + crossfade。
- 音频:视频段保留音轨,图片段配静音;`acrossfade` 或简单 concat。
- 输出:H.264 mp4,合理码率(对齐原 6Mbps 量级),兼容 Telegram 播放。

`smartcut.js` 服务端复刻选段:用 ffmpeg 抽帧(如 `select` 均匀采样或 fps=2)→ 逐帧算差 → 选最大窗口。也可用 ffmpeg `scdet`/`scene` 辅助,但优先忠实复刻现有像素差算法,保证 auto 与人在页面上按 jianji 默认得到一致结果。

## 七、安全(复用 fengmiantu)

- 剪辑链接 HMAC 签名(external/job id + sign),提交接口校验签名 + 一次性/时效。
- 回传/外呼(如有 webhook)SSRF 白名单;Telegram Bot API 走官方域名。
- 服务非 root 运行;秘钥(BOT_TOKEN 等)走 600 的 EnvironmentFile。
- 上传/下载体积上限;媒体类型校验。

## 八、环境变量

- `EDIT_MODE` = manual | auto
- `PORT`(默认 3001)
- `EDIT_URL`(对外可访问的本服务基址,拼剪辑链接)
- `TELEGRAM_BOT_TOKEN`
- `TG_SOURCE_CHAT` / `TG_RESULT_CHAT`(收料群 / 发成品群,可同一个)
- `WORK_DIR`(媒体+成品存放)
- `DB_PATH`(SQLite 文件)
- 渲染默认可调:`DEFAULT_SEG_LEN=5` `DEFAULT_IMAGE_DUR=3` `DEFAULT_FADE=0.35` `DEFAULT_ASPECT=auto`

## 九、分期

- **Phase 1(先做)**:manual 全链路 —— Telegram 收相册 + 下载 + DB + caption 解析 + 剪辑链接 + jianji 改造(预加载+提交 spec)+ ffmpeg 渲染 worker + 成品回传。
- **Phase 2**:auto 模式 —— 复刻智能选段自动生成 edit_spec,跳过人工环节直接渲染回传。

## 十、已定 / 实现时细节

- **Telegram 接收:独立 bot**(用户 2026-07-08 定)。到 @BotFather 建新 bot,token 填 `TELEGRAM_BOT_TOKEN`,bot 拉进群并开读消息权限;走 getUpdates 长轮询(或 webhook,按部署便利选)。
- **Worker 并发度:默认串行(=1)**。成片短、渲染快,AWS 配置不高;任务堆积再调大(留 env `RENDER_CONCURRENCY`)。
- **成品超 Telegram 50MB**:默认短视频远不到;超限则回退为"发下载链接进群"而非直接发视频。
