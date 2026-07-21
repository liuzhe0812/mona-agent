---
name: agnes-setup
description: >
  One-click setup wizard for Agnes AI: registers a new Agnes account via the
  browser, retrieves an API key, and configures LLM / text-to-image /
  text-to-video models in Mona. Use when user asks to "一键配置 Agnes",
  "配置 Agnes", "setup Agnes", or mentions "agnes-setup".
metadata:
  mona:
    emoji: "⚡"
    always: false
---

# Agnes AI 一键配置

通过浏览器自动化在 https://agnes-ai.com 注册新账号、获取 API key，并自动配置 Mona 的三个模型（LLM、文生图、文生视频），让新用户免去手动配置。

## 触发条件

用户说以下任何一句时启动本 skill：
- "一键配置 Agnes"
- "帮我配置 Agnes"
- "setup Agnes"
- "配置 Agnes"

## 核心契约

1. **全程可见**：浏览器以可见窗口打开（不要 headless），让用户能随时看到进度。
2. **不替用户决策**：碰到图片/滑块验证码、协议确认、付费选项时，立即截图并请用户手动完成，等用户说"继续"再往下走。
3. **不泄露 key**：拿到 API key 后立即调用 `config_set_provider`，**绝不**在回复里完整复述 key，只在日志/工具调用中传递。
4. **三模型全配**：流程结束时必须配置好 LLM、文生图、文生视频三类，不只是 LLM。
5. **告知重启**：流程结束的最后一句话必须是"请重启 Mona（或点击右上角重启按钮）让配置生效"。

## Agnes 平台关键信息

- 主站：https://agnes-ai.com/
- 平台/控制台：https://platform.agnes-ai.com/
- API Base URL：`https://apihub.agnes-ai.com/v1`（OpenAI 兼容）
- 文本模型 ID：`agnes-2.0-flash`
- 图像模型 ID：`agnes-image-2.1-flash`（registry 默认）
- 视频模型 ID：`agnes-video-v2.0`

## 流程

### Step 1: 收集邮箱和密码

向用户索取：
1. 注册用邮箱（必填）
2. 注册用密码（必填，提醒用户妥善保管；建议由用户自己输入，agent 不替用户生成）

格式参考：
> 我将打开 Agnes 注册页帮你完成注册。请提供：
> 1. 注册邮箱：
> 2. 注册密码：
>
> 密码请直接发给我，我会在浏览器表单里填入。注册完成后请尽快去 Agnes 平台改密码。

**等用户回复**，不要在用户没给邮箱前就打开浏览器。

### Step 2: 打开注册页

调用 `browser_open` 打开 `https://platform.agnes-ai.com/`。Agnes 平台通常会自动显示登录/注册入口；如果默认是登录页，找"注册"或"Sign Up"链接点击进入。

调用 `browser_snapshot` 获取页面结构，定位：
- 邮箱输入框
- 密码输入框
- "发送验证码" / "获取验证码" 按钮
- 提交按钮

### Step 3: 填入邮箱和密码

调用 `browser_type` 在邮箱框输入用户提供的邮箱，在密码框输入密码。

**不要**点击提交按钮。

### Step 4: 触发验证码发送

调用 `browser_click` 点击"发送验证码"按钮。

然后告诉用户：
> 验证码已发送到你的邮箱 {email}，请查收并把 6 位验证码告诉我。

**等用户回复验证码**。在用户没给验证码前，不要继续。

### Step 5: 填入验证码并提交

调用 `browser_type` 在验证码输入框填入用户提供的验证码。

调用 `browser_click` 点击注册/提交按钮。

调用 `browser_snapshot` 检查是否注册成功：
- 如果页面跳转到控制台首页 → 成功，进入 Step 6
- 如果出现"验证码错误"/"邮箱已注册"等错误 → 截图给用户，告知错误，停止流程
- 如果出现图片/滑块验证码 → 截图给用户，请用户在浏览器窗口里手动完成，等用户说"继续"再 snapshot 一次

### Step 6: 导航到 API Key 页面

注册成功后，调用 `browser_navigate` 打开 `https://platform.agnes-ai.com/apiKey`（或从控制台导航菜单找"API Keys"/"密钥管理"进入）。

调用 `browser_snapshot` 找到"创建 API Key"/"Create Key"按钮。

调用 `browser_click` 点击创建按钮。如果弹窗要求填写名称，填"Mona"或留默认。

### Step 7: 抓取 API Key

调用 `browser_snapshot` 获取新生成的 API Key 文本。Agnes 通常会显示一个 `sk-...` 开头的字符串。

如果 snapshot 抓不到完整 key（被遮罩），调用 `browser_read` 读取 key 输入框或复制按钮的 value。

**拿到 key 后立即在内存中保留，不要在回复文本里输出完整 key。**

### Step 8: 关闭浏览器

调用 `browser_close` 关闭浏览器窗口（避免 key 泄露到浏览器历史）。

### Step 9: 配置三个模型

调用 `config_set_provider` 一次性写入所有配置：

```
config_set_provider(
  provider="agnes",
  api_key="<抓到的 key>",
  set_as_default=true,
  default_model="agnes-2.0-flash",
  image_model="agnes-image-2.1-flash",
  video_model="agnes-video-v2.0"
)
```

### Step 10: 收尾

向用户报告：
1. ✅ Agnes 账号已注册（邮箱：xxx）
2. ✅ API key 已写入 ~/.mona/config.json
3. ✅ 默认 LLM 模型：agnes-2.0-flash
4. ✅ 文生图模型：agnes-image-2.1-flash（已启用）
5. ✅ 文生视频模型：agnes-video-v2.0（已启用）
6. ⚠️ **请重启 Mona 让配置生效**（或点击右上角"重启"按钮）
7. ⚠️ 建议尽快去 Agnes 平台修改密码（如果密码是 agent 替你填的）

## 失败处理

| 失败点 | 处理 |
|--------|------|
| 邮箱已注册 | 截图告知用户，询问"是否改为登录已有账号？" 如果是，让用户提供已有账号的邮箱密码，跳到 Step 6 |
| 验证码连续 3 次错误 | 停止流程，请用户稍后重试或检查邮箱 |
| 图片验证码用户拒绝手动 | 停止流程，告知用户"当前 Agnes 需要人工验证，请稍后再试或手动在 https://platform.agnes-ai.com 注册后回来配置 key" |
| API Key 创建按钮找不到 | 截图给用户，请用户手动创建 key 后告诉 agent，agent 跳到 Step 9 |
| config_set_provider 返回错误 | 把错误原样告知用户，让用户去设置页 BYOK 区域手动填入 |

## 隐私与安全

- API key 在工具调用日志中会被自动脱敏（仅显示末 4 位）
- 不要在回复正文里复述完整 API key
- 不要在对话里复述用户的密码
- 浏览器关闭后，配置流程结束，没有残留凭据在浏览器中
