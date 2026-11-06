# Ubuntu Work：自定义 API 与 Codex CLI

适用：Ubuntu 的独立 Work 服务，以 `liuzhe` 用户操作；实际 release 以根目录生产记录和 `systemctl --user show mona-hosted-work -p WorkingDirectory` 为准。提供者只有自定义 API 和 Codex CLI，两者使用同一模型参数与计费表单。免费或共用余额由管理员选择，工作台模型单价独立配置，账号余额继续共用，不读取或修改应用侧模型价表。

2026-11-06：工作台模型管理 v33 和 Codex 连接检测 v32 已发布。模型以列表按行管理开放和独立价格；Ubuntu 的专用 Codex 账号已通过连接检测，实际返回 8 个模型，但执行和扣费仍未接通。

官网入口的 `hosted_work.public_origin` 必须为 `https://mona-ai.cn`，不加 Ubuntu 的 17175 端口。该端口只用于内部连接；写成 `https://mona-ai.cn:17175` 会导致官网 Host/Origin 校验失败。监听地址与端口仍保留原值。

当前 CLI 执行接入与共用余额预扣/结算桥仍未完成。自定义 API 选择免费且凭据就绪时可调用；选择共用余额时保存配置但暂不开放，不能静默免费执行。Codex 无论选哪种计费方式都因执行接入未完成暂不可调用，连接、执行及计费状态分别展示。原充值入口和支付流程继续沿用。

## 1. Qwen3.7 Plus

运营配置：`/home/liuzhe/mona-hosted-work/config/operator-accounts-v2.json`。

优先通过下方管理页面保存；下面仅示意当前运营配置的字段，不用片段覆盖整个文件：

```json
"qwen": {
  "label": "Qwen3.7 Plus",
  "source": "mona",
  "api_base": "https://coding.dashscope.aliyuncs.com/v1",
  "api_key_env": "MONA_WORK_MODEL_QWEN_KEY",
  "model": "qwen3.7-plus",
  "billing_mode": "free",
  "price": null
}
```

`source=mona` 是自定义 API 的内部适配器值，不代表免费。当前 Qwen 的 `billing_mode=free` 保留用户此前指定的状态，管理员可以修改；收费选 `wallet` 并自行填写独立 `price`。新增配置缺省为 wallet，管理 API 要求明确传入计费方式。这里不把原账号服务 `/v1` 网关当上游模型接口。

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

### 同一表单选择提供者

点击“自定义 API”或“Codex CLI”。自定义 API 选择已有连接或新增连接，填写接口及环境变量引用后页面自动读取模型目录。每行可开放或进入设置；无价模型首次开放须先填写价格。Codex CLI 自动发现已安装程序，保存连接和认证方式后检查连接，再从返回的模型列表逐项设置。供应商列表不保证每项账号调用权限已验证。

| 页面字段 | 含义 |
| --- | --- |
| 平台模型标识 | 由系统生成；已有模型沿用原标识 |
| 显示名称 | `label`，用户模型列表中的名称 |
| 模型 ID | `model`，从供应商返回列表读取，不手工填写 |
| API Base URL | `api_base`，供应商公网 HTTPS 兼容接口地址 |
| API Key 环境变量名称 | `api_key_env`，如 `MONA_WORK_MODEL_QWEN_KEY`；只填引用，不填 Key |
| 输入预算上限（可选） | `context_window_tokens`，留空沿用目录；不改变真实模型窗口 |
| 最大输出 token | `max_output_tokens`，单次输出上限 |
| 计费方式 | `billing_mode`，管理员选择 free（免费）或 wallet（共用余额） |
| 输入、缓存输入、输出价格 | `price`，人民币/百万 token；三项全填或全空，零为明确价格，最多六位小数 |

自定义线路写 `source=mona`，Codex 模型写 `source=codex`，不能跨来源覆盖。新开放模型须先填写完整价格；已开放且无价格的旧 Qwen 不自动变价。页面分别显示已保存状态和未保存草稿；目录未返回的已配置模型仍可关闭。缺凭据时请运维先在受限环境预载；任务忙碌时等任务结束再保存；版本变化时刷新并核对。旧推理强度配置兼容保留，但后台不再展示或修改。

### Codex 连接草稿

1. Ubuntu 安装后，页面只读检查常见系统、npm、nvm 和固定运营目录，在内部使用发现的程序路径。选择认证方式后保存连接；页面不显示程序路径，检测文件不自动登录。
2. 如需登录，在 Ubuntu 本机使用已提供的专用登录脚本。ChatGPT 使用设备授权；API Key 只在本机通过 CLI 标准输入提供，不放入聊天或命令参数。
3. 返回页面检查连接，从 CLI 返回的模型列表逐项选择并保存。旧缓存仅作为未验证目录显示；仅探测成功不代表真实模型任务或扣费验收已通过。已保存程序失效且发现新安装程序时，页面提供显式切换并保存的操作。
4. 通过各行“设置”填写输入、缓存输入和输出单价。该价格独立保存；连接验证、执行和计费就绪分开，当前 Codex 仍不可调用。

连接草稿保存在 `operator-accounts-v2.json` 的 `hosted_work.codex`，包括 `cli_path`、`auth_mode` 和旧版草稿字段；每个 Codex 模型的开放状态与独立价格保存在 `hosted_work.models` 对应条目中。保存不重启服务，按版本校验防止覆盖其他管理员的新修改；备份和新配置权限均为 600。旧 `billing_model` 与旧版全局价格草稿仅作兼容保留，不覆盖逐模型价格。当前执行适配未完成，不因免费设置或连接成功加入公开列表。

CLI 使用固定的 Work 专用 `CODEX_HOME=/home/liuzhe/mona-hosted-work/config/development/native/codex` 和独立空登录目录；不读取个人桌面配置。程序未配置、未认证、认证方式不符、协议或隔离校验不通过、所选模型不在原生缓存及账户模型列表中，均不能显示连接已验证。检查连接不创建模型任务，不调用余额和支付接口。

`hosted_work.codex.local_proxy_url` 可选，只接受带端口的 HTTP 字面回环地址；设置后只应用于专用 CLI 登录与检测子进程。当前生产使用 Ubuntu 已运行的本机代理，代理停止会影响检测；不修改 Qwen 或工作台全局代理。

Qwen 与 Codex 的计费选择分别保存，不互相覆盖；不新增个人白名单或限流设置。现有平台安全与隔离配置保留。

### 共用余额与独立模型价格

价格直接在工作台模型表单填写，三项按人民币/百万 token 保存为非负十进制字符串；三项留空表示未配置，`0` 表示明确设为零。工作台不访问应用侧模型价表，修改工作台价格不改变应用侧价格；账户余额仍为同一钱包。价格已配置、Codex 已登录或连接检测通过，都不代表执行或扣费桥已接通。

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

仅登录不能保证 `models_cache.json` 已生成；最新管理页的主动连接检测读取 CLI 实际返回的模型列表，不以缓存文件存在为前提。缓存或返回列表均不证明账号可以实际调用每个模型，需要后续真实任务验证。

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

当前连接草稿可保存 `price` 与 `billing_mode`；`allowed_account_ids` 不是该配置的一部分。后续计费须由服务端完成：运行前冻结独立价格并预扣共用余额，按真实输入/缓存输入/输出 Token 结算；取消与失败按已确认用量处理，未知结果不得自动退款。连接标签和价格草稿本身不能实现收费。

Codex 的程序化使用方式和账号授权范围以官方说明为准；本连接适配未新增公共环境使用授权。[OpenAI 鉴权与自动化说明](https://learn.chatgpt.com/docs/auth#sign-in-with-an-api-key)

## 5. 新凭据加载与联调

管理页保存自定义 API 配置会在空闲时同步服务，不需要每次手动重启。只有新增环境变量或手工变更配置需要重新加载时，确认没有运行中、取消中或待核对任务，再由运维只重启本 Work 服务：

```bash
systemctl --user daemon-reload
systemctl --user restart mona-hosted-work.service
systemctl --user show mona-hosted-work.service -p ActiveState -p SubState -p MainPID
curl -fsS -H 'Host: mona-ai.cn' -H 'Origin: https://mona-ai.cn' http://172.31.3.176:17175/healthz
```

健康结果只证明入口和配置已加载，不能代替真实模型调用、工具封锁、文件隔离与浏览器验收。Qwen 可以先单独配置并验证；Codex 需完成登录、模型信息和共用余额计费适配后再开放。官网反代由 VPS 侧完成，不重启 Docker 或恢复暂停的 Worker。

## 6. 以后更换或增加 API 模型

模型连接不写死在代码或官网中。优先在“自定义 API”选择原线路并保存，或新增独立标识；对应 `operator-accounts-v2.json` 的 `hosted_work.models`：

- `api_base`：供应商提供的 OpenAI Chat Completions 兼容 Base URL，例如该供应商要求的 `/v1` 地址；这不是完整的 `/chat/completions` URL。
- `model`：该供应商实际支持的模型 ID。
- `label`：网站模型下拉框显示的名称。
- `api_key_env`：`platform.env` 中对应的 Key 变量名，必须以 `MONA_WORK_MODEL_` 开头；新供应商可使用新的变量名，不把 Key 放进 JSON。

只换供应商时可保留现有模型项的 ID，避免已有记录指向不存在的配置；原任务不会因此重新执行。增加线路则在 `models` 中新增一个只含小写字母、数字、横线或下划线的不同 ID。历史任务仍保留原记录，不因改配置自动重算或切换运行中的模型。

管理页保存后以服务同步、凭据状态为准；新增 Key 引用须先完成上方环境预载。手工改文件时先备份，并在空闲时重新加载本 Work 服务。还应验证真实模型响应、工具任务及下载，不能仅凭模型名称出现或接口 200 判断可用。官网模型列表来自 Work 服务，不需要重建官网。免费 API 由配置方承担上游费用，不扣用户余额；Codex 收费仍待 CLI 与余额桥完成及真实结算验收。
