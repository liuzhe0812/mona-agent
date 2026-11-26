# Mona Interaction

这是独立运行的 Mona 交互模块。已实现本机 Mona 渠道连接、正文与表演字段分离、请求去重和结果恢复。默认启动不生成模拟回复；未配置连接时显示等待连接。接口协议和 Mona 接入设计见 [Mona 独立交互模块](../docs/architecture/mona-interaction.md)，开发顺序见 [实施与验收](../docs/plans/mona-interaction-development.md)。

办公室连接 Mona 后会自动请求麦克风，按浏览器提示允许即可。以后打开同一桌面入口、授权仍有效时，直接说“Hey Mona”。唤醒与语音识别在本机运行，Mona 的完整回复通过本地语音模型播放。点“静音”会释放麦克风并记住选择；也可以展开“对话文字”输入。没有配置办公室场景时，基础文字页仍提供系统中文朗读。

完整产品以 [连续交互技术方案](../docs/design/mona-realtime-interaction.md) 为目标：实时参数化角色、语义表演编排和可打断的全双工语音。

## 办公室环境

用户已确认黑红游戏工位的场景方向。环境渲染使用独立背景、坐姿原画、前景遮挡和实体墙钟；墙钟直接读取运行设备的本地时间，秒针连续走动，页面恢复后立即校时。可选的夜景图按设备本地时间渐变；配置独立云层时，白天云会在窗内缓慢移动，夜晚楼灯低幅变化。降低动态偏好会关闭环境动画并保留每秒校时。

场景可配置休息、工作、对话三套姿态和对应的可选待机帧。待机帧从实际模型导出，当前仅用于技术预览，并非实时可控模型；播放失败、隐藏页面或降低动态偏好时使用静态备用图。姿态依据已观察到的会话与语音状态切换，不代表任务成功，也不会自动重发输入。

场景由本机清单显式指定；未指定时保留原入口。资源只读取清单列出的 PNG，并校验真实路径、画布尺寸和图层坐标。Windows 可传入 `-SceneFile`，Ubuntu 可传入 `--scene-file`：

```powershell
.\interaction\scripts\start-windows.ps1 -SceneFile "design-assets/11-fullscreen-office/production/scene.json"
```

```bash
bash interaction/scripts/start-ubuntu.sh --scene-file 'design-assets/11-fullscreen-office/production/scene.json'
```

办公室入口支持显式配置休息、工作和对话三套实时模型。休息态以安静停留为主，胸廓与颈部独立转动，扶手、前臂及椅背固定。结束工作后目光短暂停在桌面，结束对话后保留对用户的注视；较长的独处期间偶尔看向桌面或窗侧。模型无法加载时，休息态使用安静眨眼的备用帧。对话态转回用户，进入时轻点头，播放期间依据实际声音强弱开合嘴部。开启“减少动态效果”时使用静帧。场景和模型需随正式素材包交付。

## 本地可动角色

角色渲染在浏览器本机完成，不消耗模型 Token。构建阶段使用已安装的 Node.js 和 npm，安装的是前端构建依赖与固定版本的官方 Framework 源码；不包含 Cubism Core 或角色模型。

```powershell
npm --prefix interaction/renderer ci --ignore-scripts --no-audit --no-fund
npm --prefix interaction/renderer run build
```

将已合法取得的 Cubism Core 与可动模型放到同一显式素材根目录，在该目录复制 `interaction/character.example.json` 并调整文件名。模型所引用的纹理、物理和姿态文件必须位于该目录内；服务仅开放具体引用文件。清单只读取本地文件，不会获取 Core 或模型。模型准备后运行：

```powershell
.\interaction\scripts\start-windows.ps1 -ConnectionFile "<连接文件>" -CharacterFile "<角色清单>"
```

Ubuntu 使用相同构建命令，然后传入 `bash interaction/scripts/start-ubuntu.sh --connection-file '<连接文件>' --character-file '<角色清单>'`。

办公室可为休息、工作和对话分别指定角色清单；未指定的姿态继续使用场景备用图。每份清单都按上述方式指定本机素材根目录、模型和 Cubism Core，三份清单引用的 Core 内容须一致。

```powershell
.\interaction\scripts\start-windows.ps1 -SceneFile "<场景清单>" `
  -RestCharacterFile "<休息角色清单>" -WorkCharacterFile "<工作角色清单>" `
  -DialogueCharacterFile "<对话角色清单>"
```

```bash
bash interaction/scripts/start-ubuntu.sh --scene-file '<场景清单>' \
  --rest-character-file '<休息角色清单>' --work-character-file '<工作角色清单>' \
  --dialogue-character-file '<对话角色清单>'
```

默认映射包括头部 XYZ、身体转动、双眼开合、眼球、眉毛、嘴型、笑意与呼吸。`bindings` 可按模型参数名覆盖缩放及偏移，也可将 `armWave` 绑定到专属手臂参数；数值最终限制在模型实际范围内。耳发尾的次级运动由模型的 `physics3.json` 决定。缺少的参数通过 `mona:character-ready` 事件报告，不创建不存在的参数。恢复历史只恢复表情，不重新播放历史手势。

框架固定到官方 Cubism Web Framework `5-r.5` 的提交 `198a3769c26ca3d7b600e932590433badd392edd`；构建同时保留官方许可证。构建结果写到 `mona_interaction/web/vendor/`，源码与锁文件进入版本管理，生成文件不进入 Git。构建可在 Windows 或 Ubuntu 完成，发布 wheel 前也需完成此步骤。

当前已验证构建、参数映射、资源范围和连续控制逻辑。Mona 的可动美术审核稿位于 `design-assets/10-live2d/04-review/review-v01/`，含 20 层、20 参数的模型与源工程；制作工具已验证原生参数采样和 CPU 渲染。独立交互端尚未装入 Core 与该模型，WebGL 与 Ubuntu 验收仍待完成，当前先等待用户美术审核。`SpeechTimeline.begin()` 返回代次令牌，音频播放器以该令牌及真实播放位置采样嘴型；旧话语令牌失效后不会恢复。该时间线尚未连接语音提供商，不能视为口型成品。

## 连接 Mona

在运行 Mona 的配置中启用 `channels.interaction.enabled`。该可选渠道默认关闭，配置由 `mona/config/schema.py` 显式声明。Mona 重启加载后，会在当前实例用户数据目录的 `channels/interaction/connection.json` 写入本机连接资料。该文件包含设备凭据，不要放进仓库或日志，也不要将其内容贴到聊天。

使用启动脚本准备环境并传入连接文件：

```powershell
.\interaction\scripts\start-windows.ps1 -ConnectionFile "<Mona 用户数据目录>\channels\interaction\connection.json"
```

连接文件只由独立服务读取，不交给网页。当前真实接入支持同机 loopback，Ubuntu 与 Windows 跨机器的加密配对仍待实现。未完成任务在渠道重启后标为结果需要核对，不会重新执行；用户通过“核对上次结果”确认实际结果后，可以继续发送新内容。

最终模型回复遵循 `text + performance` 契约，一次正常模型调用同时生成正文和表演字段。字段包含语气、笑意、凝视目标和手势强度；无效字段不驱动角色。模型工具调度与授权沿用 Mona，渠道只收集回复并等待明确的整轮结束回执。

Windows 和 Ubuntu 原有开发入口需要 Python 3.11 或更新版本，并且 Python 的 `venv` 和 `pip` 可用；它们使用 `interaction/.venv` 和 `pip install -e`，安装依赖可能需要网络。Ubuntu 正式入口改用已经准备好的统一运行时，不创建项目环境或联网安装依赖。

以下命令均从仓库根目录执行。界面地址为 <http://127.0.0.1:17880/>，健康检查地址为 <http://127.0.0.1:17880/health>。当前只支持本机访问，不要将服务暴露到公网。

## Windows 手动运行

在 PowerShell 中执行：

```powershell
.\interaction\scripts\start-windows.ps1
```

打开界面后保持终端运行；按 `Ctrl+C` 停止。脚本优先使用 Python Launcher，也可在首次创建环境前指定已安装的解释器：

```powershell
$env:MONA_INTERACTION_PYTHON = 'C:\Path To Python\python.exe'
.\interaction\scripts\start-windows.ps1
```

## Ubuntu 开发预览

```bash
bash interaction/scripts/start-ubuntu.sh
```

打开界面后保持终端运行；按 `Ctrl+C` 停止。如果默认 `python3` 低于 3.11，可在首次创建环境前指定已经安装的版本：

```bash
MONA_INTERACTION_PYTHON=python3.11 bash interaction/scripts/start-ubuntu.sh
```

环境已经创建后，指定解释器不会替换现有环境。Ubuntu 的 Python 安装还需要提供可用的 `venv` 模块。

只有开发验证需要模拟内容时，显式运行 `python -m mona_interaction serve --demo`。生产连接不可自动降级为模拟回复。

## Ubuntu 受管环境手动运行

先由统一运行时准备 `interaction-voice` Python 环境及其本地依赖，并准备真实 Mona 连接文件、场景清单、三种姿态清单、唤醒模型清单和语音识别模型清单。将下面的路径替换为本机实际文件；连接文件由 Mona 在启用交互渠道后生成，不要在聊天、仓库或日志中粘贴其内容。

```bash
export MONA_INTERACTION_MANAGED_PYTHON="$HOME/.mona/runtimes/python/interaction-voice-envs/<环境代次>/bin/python"
# 如果 Mona 使用其他受管运行时目录，还需设置 MONA_INTERACTION_RUNTIME_ROOT。
interaction_args=(
  --connection-file "$HOME/.mona/channels/interaction/connection.json"
  --scene-file '<场景清单绝对路径>'
  --rest-character-file '<休息角色清单绝对路径>'
  --work-character-file '<工作角色清单绝对路径>'
  --dialogue-character-file '<对话角色清单绝对路径>'
  --wake-model-file '<唤醒模型清单绝对路径>'
  --asr-model-file '<语音识别模型清单绝对路径>'
)
bash interaction/scripts/start-ubuntu.sh "${interaction_args[@]}"
```

脚本只接受受管运行时内已有的 Python，启动前会检查清单、素材位置、渲染资源和本地语音依赖；用户给出的资源路径须解析到用户主目录、交互项目目录或受管运行时目录内。受管入口不下载依赖和模型，不会在配置不完整时切换到模拟会话。仅在手动开发预览时可显式传入 `--demo`。

## Ubuntu 用户服务

需要可用的用户级 systemd 会话，并先按上文准备受管 Python 与全部真实清单。在同一终端设置好 `MONA_INTERACTION_MANAGED_PYTHON` 和 `interaction_args` 后执行：

```bash
bash interaction/scripts/install-ubuntu-service.sh "${interaction_args[@]}"
```

脚本检查本机资源，生成只含文件路径而不含连接凭据内容的服务配置，启用并尝试立即启动当前用户的 `mona-interaction.service`。服务不接受 `--demo`，不会覆盖由其他方式创建的同名服务。可通过下面的 `status` 命令确认启动情况；不要同时运行前台实例和用户服务，以免端口冲突。服务后续在用户服务管理器启动时自动运行，通常这是用户登录时；若需无人登录时开机启动，需要先为该用户启用 systemd linger，是否允许由系统管理策略决定：

```bash
loginctl enable-linger "$USER"
```

常用操作：

```bash
systemctl --user status mona-interaction.service
journalctl --user -u mona-interaction.service -e
systemctl --user restart mona-interaction.service
systemctl --user disable --now mona-interaction.service
```

移动项目、更新受管 Python 环境或改变配置路径后，重新设置参数并执行安装脚本；服务已运行时再执行上述 `restart` 命令，使新配置生效。服务固定使用安装时选择的环境代次，如果该代次被清理，服务会报错，不会自动换用其他解释器。服务只启动本地 HTTP/WS 接口，不直接启动图形程序。

### Ubuntu 桌面入口

安装受管用户服务后，可登记桌面应用和登录启动项。需要系统中已安装 Google Chrome 或 Microsoft Edge：

```bash
python3 interaction/scripts/ubuntu-desktop.py install
```

首次启动时按系统提示允许麦克风，授权保存在 Mona 专用浏览器资料中。之后登录桌面会自动打开 Mona，也可从应用菜单打开；已有窗口会被切换到前台。关闭窗口后再从菜单打开即可重新进入。桌面入口等待本机服务就绪，不启动另一份服务或使用模拟会话。需要取消登录自动启动时，可在系统的启动应用设置中关闭 Mona。
