# Ubuntu Work：Qwen 与 Codex 两条线路

适用：Ubuntu 的独立 Work 服务，以 `liuzhe` 用户操作；实际 release 以根目录生产记录和 `systemctl --user show mona-hosted-work -p WorkingDirectory` 为准。Qwen/免费 API 对所有已登录账号免费、不设个人白名单；Codex 使用平台专用登录，目标为从网站与客户端共用的 Mona 余额扣费，不另建 Work 钱包或价格表。

2026-11-06：模型与计费管理后端 v23、前端 v24 已发布。真实管理员已验收免费 API 保存与运行配置同步、共用价格展示、版本冲突拒绝，以及原后台侧栏到新页面的实际跳转；普通账号和匿名读写均拒绝。Codex 收费仍未开通。

官网入口的 `hosted_work.public_origin` 必须为 `https://mona-ai.cn`，不加 Ubuntu 的 17175 端口。该端口只用于内部连接；写成 `https://mona-ai.cn:17175` 会导致官网 Host/Origin 校验失败。监听地址与端口仍保留原值。

当前 CLI 接入与共用余额的预扣、结算、退款桥仍未完成，`billing.ready=false`。可以保存免费 API 配置、准备 Codex 登录与计价映射，不能声明 Codex 收费已开放。原充值入口和支付流程继续沿用。

## 1. Qwen3.7 Plus

运营配置：`/home/liuzhe/mona-hosted-work/config/operator-accounts-v2.json`。

优先通过下方管理页面保存；下面仅示意当前运营配置的字段，不用片段覆盖整个文件：

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

上下文容量由应用共用模型目录解析，不再给所有网页模型套用 32K 默认值。无需为当前 Qwen 手填窗口；若保留旧 `context_window_tokens`，它会作为额外输入预算 cap，而不是供应商容量声明。运行与设置页共用同一解析结果，来源和真实单次占用峰值记录在任务诊断中。

在 Ubuntu 本机编辑 `/home/liuzhe/mona-hosted-work/config/platform.env`，写入下列环境变量，等号后填写实际套餐 Key；不要将 Key 放进聊天、命令行参数或 Git：

```text
MONA_WORK_MODEL_QWEN_KEY=在本机填写真实Key
```

保证该文件权限为 600。新增或更换环境变量后，先在 Work 空闲时由运维加载到服务进程，再从管理页面保存；页面不会接收 Key。检查用户服务是否加载它，下面只显示文件路径：

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

## 2. 工作台模型与计费页面

先在原 `https://mona-ai.cn/admin/` 登录管理员，点击侧栏“工作台模型与计费”，或访问 `https://mona-ai.cn/work/admin/`。模型配置和共用价格读取均支持真实管理员会话。普通注册账号返回 403，页面不接收或回显密钥、认证文件和设备登录码。

### 免费 API 模型

选择已有线路或点“新增免费 API 模型”，填写后点“保存免费 API 配置”：

| 页面字段 | 含义 |
| --- | --- |
| 平台模型标识 | `id`，1–64 位小写字母、数字、短横线或下划线 |
| API 显示名称 | `label`，用户模型列表中的名称 |
| 供应商模型 ID | `model`，上游实际支持的模型 ID |
| API Base URL | `api_base`，供应商公网 HTTPS 兼容接口地址 |
| API Key 环境变量名称 | `api_key_env`，如 `MONA_WORK_MODEL_QWEN_KEY`；只填引用，不填 Key |
| 输入预算上限（可选） | `context_window_tokens`，留空沿用目录；不改变真实模型窗口 |
| 最大输出 token | `max_output_tokens`，单次输出上限 |
| 推理强度（可选） | `reasoning_effort`，按供应商支持填写，不使用时留空 |

此入口只保存 `source=mona` 的免费 API 线路，不能覆盖其他来源。页面显示当前服务是否已加载凭据、配置是否同步。缺凭据时请运维先在受限环境预载，再刷新状态重试；任务忙碌时等任务结束再保存；版本变化时刷新并核对。失败会保留草稿。API 和 Codex 使用同一配置版本，但互不覆盖未保存草稿。

### Codex 连接草稿

1. 填写 Ubuntu 上**已经安装**的 Codex 程序绝对路径、显示名称和认证方式，保存配置。
2. 展开“Ubuntu 登录说明”，在 Ubuntu 的真实终端以 `liuzhe` 执行页面生成的命令。ChatGPT 使用设备授权；API Key 方式仅在本机通过 CLI 标准输入提供 Key。不要发送到聊天或放入命令参数。
3. 返回页面检查连接，从实际原生缓存模型列表选择模型并保存，再次检查。仅探测成功不代表真实模型任务或扣费验收已通过。
4. 填写“账务模型 ID”，对应现有管理后台的模型价格标识；这里只保存映射草稿。连接验证和计费就绪分开，当前仍显示未开放。

连接草稿保存在 `operator-accounts-v2.json` 的 `hosted_work.codex`，字段为 `cli_path`、`model`、`billing_model`、`label`、`auth_mode`。保存不重启服务，按版本校验防止覆盖其他管理员的新修改，仅更新该字段；原配置备份和新配置权限均为 600。它不是公开 `models` 的一项，未计费 Codex 不会被加入公开模型列表，服务端同时拒绝执行。

CLI 使用固定的 Work 专用 `CODEX_HOME=/home/liuzhe/mona-hosted-work/config/development/native/codex` 和独立空登录目录；不读取个人桌面配置。程序未配置、未认证、认证方式不符、协议或隔离校验不通过、所选模型不在原生缓存及账户模型列表中，均不能显示连接已验证。检查连接不创建模型任务，不调用余额和支付接口。

Qwen 对其他账号免费，不关联此 Codex 草稿，不新增收费、白名单或限流设置。现有平台安全与隔离配置保留。

### 共用余额与模型价格

价格卡直接读取现有 `/admin/credits/model-prices`，按填写的账务模型 ID 选择已启用、按 token 计费的最高价格版本，展示输入、缓存输入和输出的人民币/百万 token 单价及版本。未匹配到价格时会明确提示。

点“打开模型服务 → 模型计价”进入原 `/admin`，在“模型服务 → 模型计价”编辑。网站与应用共用钱包、共用价表，改价会同时影响两端；此页不另建价格表。价格已配置、Codex 已登录或连接检测通过，都不代表余额扣费桥已接通。

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

## 5. 新凭据加载与联调

管理页保存免费 API 配置会在空闲时同步服务，不需要每次手动重启。只有新增环境变量或手工变更配置需要重新加载时，确认没有运行中、取消中或待核对任务，再由运维只重启本 Work 服务：

```bash
systemctl --user daemon-reload
systemctl --user restart mona-hosted-work.service
systemctl --user show mona-hosted-work.service -p ActiveState -p SubState -p MainPID
curl -fsS -H 'Host: mona-ai.cn' -H 'Origin: https://mona-ai.cn' http://172.31.3.176:17175/healthz
```

健康结果只证明入口和配置已加载，不能代替真实模型调用、工具封锁、文件隔离与浏览器验收。Qwen 可以先单独配置并验证；Codex 需完成登录、模型信息和共用余额计费适配后再开放。官网反代由 VPS 侧完成，不重启 Docker 或恢复暂停的 Worker。

## 6. 以后更换或增加 API 模型

模型连接不写死在代码或官网中。优先在“免费 API 模型”选择原线路并保存，或新增独立标识；对应 `operator-accounts-v2.json` 的 `hosted_work.models`：

- `api_base`：供应商提供的 OpenAI Chat Completions 兼容 Base URL，例如该供应商要求的 `/v1` 地址；这不是完整的 `/chat/completions` URL。
- `model`：该供应商实际支持的模型 ID。
- `label`：网站模型下拉框显示的名称。
- `api_key_env`：`platform.env` 中对应的 Key 变量名，必须以 `MONA_WORK_MODEL_` 开头；新供应商可使用新的变量名，不把 Key 放进 JSON。

只换供应商时可保留现有模型项的 ID，避免已有记录指向不存在的配置；原任务不会因此重新执行。增加线路则在 `models` 中新增一个只含小写字母、数字、横线或下划线的不同 ID。历史任务仍保留原记录，不因改配置自动重算或切换运行中的模型。

管理页保存后以服务同步、凭据状态为准；新增 Key 引用须先完成上方环境预载。手工改文件时先备份，并在空闲时重新加载本 Work 服务。还应验证真实模型响应、工具任务及下载，不能仅凭模型名称出现或接口 200 判断可用。官网模型列表来自 Work 服务，不需要重建官网。免费 API 由配置方承担上游费用，不扣用户余额；Codex 收费仍待 CLI 与余额桥完成及真实结算验收。
