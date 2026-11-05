# Ubuntu Work：Qwen 与 Codex 两条线路

适用：Ubuntu 的独立 Work 服务，以 `liuzhe` 用户操作；实际 release 以根目录生产记录和 `systemctl --user show mona-hosted-work -p WorkingDirectory` 为准。Qwen 对所有账号免费、不设个人白名单；Codex 使用平台专用登录，目标为按对应模型官方 Token 价格从网站与客户端共用的 Mona 余额扣费，不另建 Work 钱包。

官网入口的 `hosted_work.public_origin` 必须为 `https://mona-ai.cn`，不加 Ubuntu 的 17175 端口。该端口只用于内部连接；写成 `https://mona-ai.cn:17175` 会导致官网 Host/Origin 校验失败。监听地址与端口仍保留原值。

当前已发布 Work 还没有接入共用余额的预扣、结算与退款。下面可先准备 Qwen 连接及 Codex 登录；Codex 收费适配发布前，不把 Codex 加入现网 `models`，避免向所有已登录用户免费放开。原充值入口和支付流程继续沿用，前面的独立收款选择不适用。

## 1. Qwen3.7 Plus

运营配置：`/home/liuzhe/mona-hosted-work/config/operator-accounts-v2.json`。

先备份文件，再在其现有 `hosted_work.models` 中增加下面这一项。不要用片段覆盖整个配置：

```json
"qwen": {
  "label": "Qwen3.7 Plus",
  "source": "mona",
  "api_base": "https://coding.dashscope.aliyuncs.com/v1",
  "api_key_env": "MONA_WORK_MODEL_QWEN_KEY",
  "model": "qwen3.7-plus"
}
```

`source=mona` 是此版本通用 API 适配器的配置值。这里不使用原账号服务的模型钱包或 `/v1` 网关。

在 Ubuntu 本机编辑 `/home/liuzhe/mona-hosted-work/config/platform.env`，写入下列环境变量，等号后填写实际套餐 Key；不要将 Key 放进聊天、命令行参数或 Git：

```text
MONA_WORK_MODEL_QWEN_KEY=在本机填写真实Key
```

保证该文件权限为 600。检查用户服务是否加载它，下面只显示文件路径：

```bash
chmod 600 /home/liuzhe/mona-hosted-work/config/platform.env
systemctl --user show mona-hosted-work.service -p EnvironmentFiles
```

如果输出未包含该文件，运行 `systemctl --user edit mona-hosted-work.service`，添加：

```ini
[Service]
EnvironmentFile=/home/liuzhe/mona-hosted-work/config/platform.env
```

上游限制：这个域名属于阿里云 Coding Plan，Key 与百炼通用按量 Key 不互通。阿里云说明限制其用于编程工具交互，并限制自定义应用后端及多人共享。以上保留运营者明确指定的端点，连接配置不表示已取得多人网站用途的供应商授权；该限制不通过改 label 或隐藏 Key 消失。[阿里云 Coding Plan](https://help.aliyun.com/zh/model-studio/coding-plan)

## 2. 管理员配置入口

访问 `https://mona-ai.cn/work/admin/`；使用现有管理后台或官网的管理员账号登录。页面使用原 Auth 的管理员身份校验，普通注册账号返回 403。网站不接收和回显 Codex 密钥、认证文件或设备登录码。

1. 填写 Ubuntu 上**已经安装**的 Codex 程序绝对路径、显示名称和认证方式，保存配置。
2. 展开“Ubuntu 登录命令”，在 Ubuntu 的真实终端以 `liuzhe` 执行页面生成的命令。ChatGPT 使用设备授权；API Key 方式仅在本机通过 CLI 标准输入提供 Key。不要发送到聊天或放入命令参数。
3. 返回页面检查连接，从实际原生缓存模型列表选择模型并保存，再次检查。仅探测成功不代表真实模型任务或扣费验收已通过。
4. 计价模型 ID 应对应现有管理后台“模型服务 → 模型计价”；当前只保存映射草稿，不另设价格表。共享余额计费桥尚未完成，页面明确显示未开放，不提供假启用开关。

连接草稿保存在 `operator-accounts-v2.json` 的 `hosted_work.codex`，字段为 `cli_path`、`model`、`billing_model`、`label`、`auth_mode`。保存不重启服务，按版本校验防止覆盖其他管理员的新修改，仅更新该字段；原配置备份和新配置权限均为 600。它不是公开 `models` 的一项，未计费 Codex 不会被加入公开模型列表，服务端同时拒绝执行。

CLI 使用固定的 Work 专用 `CODEX_HOME=/home/liuzhe/mona-hosted-work/config/development/native/codex` 和独立空登录目录；不读取个人桌面配置。程序未配置、未认证、认证方式不符、协议或隔离校验不通过、所选模型不在原生缓存及账户模型列表中，均不能显示连接已验证。检查连接不创建模型任务，不调用余额和支付接口。

Qwen 对其他账号免费，不关联此 Codex 草稿，不新增收费、白名单或限流设置。现有平台安全与隔离配置保留。

## 3. 历史命令行准备方式（旧脚本，不用于新管理入口）

本项目 `deploy/hosted-work/codex-login.sh` 已于 2026-11-03 放到 Ubuntu 的 `/home/liuzhe/mona-hosted-work/ops-20261103/codex-login.sh`。该脚本只使用已安装的 Codex，不安装程序，不重启服务，不读取或输出认证文件。它调用当前发布包的目录初始化逻辑，避免先直接登录导致目录缺少受管标记。本次初始化未检测到现有原生程序，所以下述登录步骤仍待程序就绪后执行，不能据此认为 Codex 已接通。

在 Ubuntu 的真实交互终端逐项执行：

```bash
bash /home/liuzhe/mona-hosted-work/ops-20261103/codex-login.sh --init-config
bash /home/liuzhe/mona-hosted-work/ops-20261103/codex-login.sh login --device-auth
bash /home/liuzhe/mona-hosted-work/ops-20261103/codex-login.sh login status
```

在你自己的浏览器完成设备授权，不把登录码或认证文件贴到聊天。官方支持在无浏览器设备上使用 `codex login --device-auth`；凭据位置随 `CODEX_HOME` 与系统凭据存储设置而变。[OpenAI 登录文档](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)

专用配置文件为 `/home/liuzhe/mona-hosted-work/config/codex-provider.json`，它是 Mona JSON，不是 Codex config.toml。脚本首次创建后，其中会记录实际发现的原生程序路径；若文件已存在，脚本会沿用其中的 `development.codex_path`，且不会覆盖已有配置。未启用 Codex、没有填写程序路径、配置格式有误或指定程序不存在时，需先在本机修正该文件。对应 CODEX_HOME 固定为：

```text
/home/liuzhe/mona-hosted-work/config/development/native/codex
```

然后只打开一次交互 CLI，等待模型列表加载，使用 `/model` 查看并选择账号支持的模型，正常退出；无需发送任务：

```bash
bash /home/liuzhe/mona-hosted-work/ops-20261103/codex-login.sh
bash /home/liuzhe/mona-hosted-work/ops-20261103/codex-login.sh --list-cached-models
```

当前 Work 要求原生 CLI 提供真实 `models_cache.json`。仅登录不能保证该文件已经生成；最后一步失败时保留错误信息和 CLI 版本，不能自行编造模型缓存。缓存列出模型也不证明账号可以实际调用每个模型，需要后续真实任务验证。

## 4. 记录 Codex 模型，等待计费适配

CLI 登录及缓存检查成功后，记录选定的真实模型 ID。下面是连接结构草案；共用余额计费适配和真实结算验收通过前，不加入现网运行配置：

```json
"codex": {
  "label": "Codex",
  "source": "codex",
  "native_config_path": "/home/liuzhe/mona-hosted-work/config/codex-provider.json",
  "model": "替换成账号实际使用的Codex模型ID"
}
```

当前 schema 不支持在连接项里随意添加 `price`、`free` 或 `allowed_account_ids`。计费应由服务端完成：运行前校验并预扣共用余额，按真实输入/缓存输入/输出 Token 结算；取消与失败按已确认用量处理，未知结果不得自动退款。连接标签本身不能实现收费。

Codex 的程序化使用方式和账号授权范围以官方说明为准；本连接适配未新增公共环境使用授权。[OpenAI 鉴权与自动化说明](https://learn.chatgpt.com/docs/auth#sign-in-with-an-api-key)

## 5. 加载运行模型配置并联调

确认没有运行中、取消中或待核对的任务后，只重启本 Work 服务：

```bash
systemctl --user daemon-reload
systemctl --user restart mona-hosted-work.service
systemctl --user show mona-hosted-work.service -p ActiveState -p SubState -p MainPID
curl -fsS -H 'Host: mona-ai.cn' -H 'Origin: https://mona-ai.cn' http://172.31.3.176:17175/healthz
```

健康结果只证明入口和配置已加载，不能代替真实模型调用、工具封锁、文件隔离与浏览器验收。Qwen 可以先单独配置并验证；Codex 需完成登录、模型信息和共用余额计费适配后再开放。官网反代由 VPS 侧完成，不重启 Docker 或恢复暂停的 Worker。

## 6. 以后更换或增加 API 模型

模型连接是运营配置，不写死在代码或官网中。修改同一个 `operator-accounts-v2.json` 的 `hosted_work.models`：

- `api_base`：供应商提供的 OpenAI Chat Completions 兼容 Base URL，例如该供应商要求的 `/v1` 地址；这不是完整的 `/chat/completions` URL。
- `model`：该供应商实际支持的模型 ID。
- `label`：网站模型下拉框显示的名称。
- `api_key_env`：`platform.env` 中对应的 Key 变量名，必须以 `MONA_WORK_MODEL_` 开头；新供应商可使用新的变量名，不把 Key 放进 JSON。

只换供应商时可保留现有模型项的 ID，避免已有记录指向不存在的配置；原任务不会因此重新执行。增加线路则在 `models` 中新增一个只含小写字母、数字、横线或下划线的不同 ID。历史任务仍保留原记录，不因改配置自动重算或切换运行中的模型。

配置当前在服务启动时加载：确认 Work 没有运行、取消中或待核对任务，备份配置并更新相关字段，然后只重启 `mona-hosted-work.service`。先验证真实模型响应、工具任务及下载，再开放该线路；不能仅凭模型名称出现就认为可用。官网模型列表来自 Work 服务，不需要重建官网。通用 API 线路当前由平台承担费用；在计费适配完成前，不能把改标签当作已接入共享余额。
