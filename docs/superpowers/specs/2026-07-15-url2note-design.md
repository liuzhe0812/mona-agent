# URL 转 Markdown 笔记设计

## 目标

用户在浏览器中点击“生成 Markdown 笔记”，或在对话中明确要求“将此 URL 整理成笔记”时，Mona 提取公开可访问的网页或视频内容，生成 Markdown，并将笔记直接写入笔记库根目录。

## 范围与边界

- 新 Agent 工具名固定为 `url2note`；模型仅在用户明确要求生成、整理或保存笔记时调用它，单独发送链接不触发。
- 浏览器入口和 Agent 工具复用同一个 URL 内容提取器及同一份组件缓存。
- 支持公开、当前可访问的内容；不导出 Cookie，不绕过登录、付费或 DRM 限制。
- 文章使用现有 `WebFetchTool` 的可读内容提取；不新增 WebView 页面脚本或跨页面 IPC。
- 视频先读取人工字幕与自动字幕；只有没有可用字幕时才下载音频并调用现有转写提供商。OCR 不在本期范围。

## 数据流

```text
浏览器菜单 / Agent 明确请求
  -> Url2NoteExtractor.extract(url)
  -> 文章：WebFetchTool
     视频：yt-dlp 字幕 -> 音频 -> ffmpeg 压缩 -> 转写
  -> 内容文本
  -> 浏览器：现有 /v1/chat/completions 生成 Markdown -> notes_create_from_chat
     Agent：url2note 返回内容 -> Agent 生成 Markdown -> notes_create
  -> 笔记库根目录
```

`notes_create_from_chat` 在未传 `notebookId` 时已写入笔记库根目录，浏览器与 Agent 均不传该字段。

## 组件与目录

`VideoRuntime` 改为将其受管组件存放在 `%LOCALAPPDATA%\\Mona\\resources`（非安装目录、非 `runtime` 目录）：

- `resources\\yt-dlp\\yt-dlp.exe`
- `resources\\ffmpeg\\...\\ffmpeg.exe`

已有系统安装的 FFmpeg 可以复用；没有时按用户触发的操作下载。Node.js 和 Chrome 不参与 `url2note`。

## 接口

- `POST /api/url2note/extract`：接收 `{ "url": "https://..." }`，返回 `{ title, url, kind, text }`。失败返回可展示的 `error`。
- `url2note(url)`：同一提取器的 Agent 工具包装。返回标记为不可信的提取文本，并要求 Agent 使用 `notes_create` 保存其整理后的 Markdown。
- 前端只增加一个 `extractUrl2Note` API 包装和浏览器菜单动作；生成完成后调用已有 `createNoteFromChat(title, markdown)`。

## 资源与错误处理

- URL 先经现有 SSRF 校验；所有子进程均使用参数数组，绝不使用 shell。
- 每次视频处理创建临时目录，并在成功、失败或取消后删除。
- 字幕不存在时才走音频；音频转为单声道 16 kHz、32 kbps MP3，再交给现有转写逻辑。过大音频由既有上传大小限制拒绝并提示用户。
- 没有配置笔记库、模型或转写提供商时，不写入空笔记，直接返回可操作错误。

## 验收

1. 受管组件默认路径包含 `Mona/resources`，已存在的二进制不重复下载。
2. 字幕解析会去除编号与重复空白，并保留时间点；无字幕的视频走音频转写。
3. `url2note` 被工具加载器发现，并将来源内容交给 Agent；Agent 可用 `notes_create` 在根目录写入最终笔记。
4. 浏览器菜单对 URL 调用同一接口，最终以空笔记本参数保存。
5. 相关 Python 测试、前端单测、前端构建及 Rust 检查通过。
