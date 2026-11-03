# Mona Interaction

这是独立运行的 Mona 交互模块。已实现本机 Mona 渠道连接、正文与表演字段分离、请求去重和结果恢复。默认启动不生成模拟回复；未配置连接时显示等待连接。接口协议和 Mona 接入设计见 [Mona 独立交互模块](../docs/architecture/mona-interaction.md)，开发顺序见 [实施与验收](../docs/plans/mona-interaction-development.md)。

网页显示正式原画，并消费模型返回的表演字段。独立数值控制器生成凝视、笑意、呼吸和手势参数，通过 `mona:performance-frame` 事件交给后续角色渲染器。正式 Cubism 模型尚未加载，当前原画不代表精细动画已完成。“朗读回复”使用操作系统中文语音；Pipecat、麦克风输入与最终语音提供商仍待接入。

完整产品以 [连续交互技术方案](../docs/design/mona-realtime-interaction.md) 为目标：实时参数化角色、语义表演编排和可打断的全双工语音。

## 连接 Mona

在运行 Mona 的配置中启用 `channels.interaction.enabled`。该可选渠道默认关闭，配置由 `mona/config/schema.py` 显式声明。Mona 重启加载后，会在当前实例用户数据目录的 `channels/interaction/connection.json` 写入本机连接资料。该文件包含设备凭据，不要放进仓库或日志，也不要将其内容贴到聊天。

使用启动脚本准备环境并传入连接文件：

```powershell
.\interaction\scripts\start-windows.ps1 -ConnectionFile "<Mona 用户数据目录>\channels\interaction\connection.json"
```

连接文件只由独立服务读取，不交给网页。当前真实接入支持同机 loopback，Ubuntu 与 Windows 跨机器的加密配对仍待实现。未完成任务在渠道重启后标为结果需要核对，不会重新执行；用户通过“核对上次结果”确认实际结果后，可以继续发送新内容。

最终模型回复遵循 `text + performance` 契约，一次正常模型调用同时生成正文和表演字段。字段包含语气、笑意、凝视目标和手势强度；无效字段不驱动角色。模型工具调度与授权沿用 Mona，渠道只收集回复并等待明确的整轮结束回执。

需要本机已安装 Python 3.11 或更新版本，并且 Python 的 `venv` 和 `pip` 可用。脚本在 `interaction/.venv` 创建项目专用环境，通过 `pip install -e` 安装当前项目及其 Python 依赖；安装依赖可能需要网络。脚本不会下载或安装 Python、模型或浏览器。

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

## Ubuntu 手动运行

```bash
bash interaction/scripts/start-ubuntu.sh
```

打开界面后保持终端运行；按 `Ctrl+C` 停止。如果默认 `python3` 低于 3.11，可在首次创建环境前指定已经安装的版本：

```bash
MONA_INTERACTION_PYTHON=python3.11 bash interaction/scripts/start-ubuntu.sh
```

环境已经创建后，指定解释器不会替换现有环境。Ubuntu 的 Python 安装还需要提供可用的 `venv` 模块。

只有开发验证需要模拟内容时，显式运行 `python -m mona_interaction serve --demo`。生产连接不可自动降级为模拟回复。

## Ubuntu 用户服务

需要可用的用户级 systemd 会话。不要同时运行前台实例和用户服务，以免端口冲突。执行：

```bash
bash interaction/scripts/install-ubuntu-service.sh
```

脚本准备项目环境，启用并尝试立即启动当前用户的 `mona-interaction.service`；可通过下面的 `status` 命令确认启动情况。如果需要选择解释器，可在命令前设置 `MONA_INTERACTION_PYTHON`，与手动运行相同。服务后续在用户服务管理器启动时自动运行，通常这是用户登录时；若需无人登录时开机启动，需要先为该用户启用 systemd linger，是否允许由系统管理策略决定：

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

更改依赖或移动项目后，重新执行安装脚本；服务已运行时再执行上述 `restart` 命令，使新配置生效。服务只启动本地 HTTP/WS 接口，不直接启动图形程序。

### 可选：登录桌面后打开浏览器

在支持 XDG autostart 的图形桌面中，可单独创建以下启动项，并先按上文启用用户服务。此操作使用已安装的 `xdg-open` 和默认浏览器：

```bash
autostart_dir="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
mkdir -p "$autostart_dir"
cat > "$autostart_dir/mona-interaction.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Mona Interaction
Exec=xdg-open http://127.0.0.1:17880/
Terminal=false
EOF
```

桌面和服务可能同时启动；如果浏览器打开时服务尚未就绪，稍后刷新页面。关闭该启动项可在桌面的启动应用设置中操作，或删除上面创建的 `.desktop` 文件。
