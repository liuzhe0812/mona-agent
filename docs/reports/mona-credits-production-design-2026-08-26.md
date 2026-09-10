# Mona 积分付费最小生产方案设计

> **已被替代：** 2026-08-27 起用户侧改为[人民币余额计费](mona-balance-production-design-2026-08-27.md)。本文件仅保留此前积分方案和内部 `credit_*` 技术结构的历史依据。

> 设计日期：2026-08-26  
> 版本：1.1  
> 当前状态：核心代码已完成候选；生产 feature flags 默认关闭，尚未通过生产门禁  
> 依据：[Mona 积分与托管模型服务可行性分析报告](mona-credits-feasibility-report-2026-08-25.md)  
> 目标：在现有 Mona Auth、One API 和 MySQL 基础上形成可控的小规模付费闭环

## 1. 结论与上线边界

采用一套权威账本、一个服务端模型入口、一个内部 One API 路由层：

```text
Mona Desktop
    │ 账号令牌 / 短期模型令牌
    ▼
Nginx → Mona Auth
           ├─ 账号、订单、积分、消费流水
           └─ /v1 流式模型代理
                    │ 内部 One API Token
                    ▼
                One API
                    │ 渠道 Key 与模型路由
                    ▼
              合法的上游模型 API

Mona Auth ─────── MariaDB（mona_auth）
One API  ──────── MariaDB（one_api）
```

首发采用以下最小生产范围。当前实现已提供候选代码，但默认不开启：

- DeepSeek 正式按量 API 作为唯一托管模型渠道；
- 一次性购买 Mona 积分，按真实 Token usage 扣费；
- 只开放文本对话和 Agent 当前能稳定取得权威 usage 的模型；
- 每个用户同时最多一个生成任务，单机全局并发先设为 20，压测通过后才调整；
- BYOK 继续保留，用户自有 Key 不扣 Mona 积分；
- Mona Auth 的 MySQL 是余额、支付入账、消费和退款的唯一事实源；
- One API 只负责上游 Key、协议兼容和渠道路由。

默认配置为 `model_access_enabled=false`、`credits_payment_enabled=false`；积分商品和模型价格记录默认 `enabled=false`。只有完成本文第 11 节门禁、配置真实渠道并进行人工复核后，才逐项开启。

**当前设计是可实现的生产基线，不表示当前服务器已经可以直接上线。** 当前审计显示服务器内存为 1.6 GiB、One API 未运行，且存在数据库公网暴露、备份未演练等阻塞；完成本文第 11 节门禁后才允许受控上线。

## 2. 商业规则

### 2.1 产品

Mona 积分是 Mona 服务内的消费单位，不是 Token、API Key 或可交易资产：

- 仅用于 Mona 托管模型调用；
- 不转让、不提现、不交易；
- 不承诺“1 积分 = 1 Token”；
- 不设置自动过期；
- 余额、订单和消费流水可查询；
- 退款按公示规则处理，退款必须产生反向账本流水。

现有 Mona Pro 订阅继续代表软件功能权益，不与积分余额混为一个字段。首版不做订阅赠送积分，避免过期、重置和退款口径复杂化。

### 2.2 渠道边界

| 资源 | 首发处理 |
|---|---|
| DeepSeek 正式 API | 可作为托管渠道，Key 只放在 One API/VPS |
| 百炼 Coding Plan | 仅用于开发者本人，不进入用户流量 |
| 硅基流动个人 Key | 未取得书面商业授权前不进入托管渠道 |
| 用户自己的 API Key | BYOK，供应商费用由用户承担，不扣 Mona 积分 |

不得通过批量 API Key、账号池或静默换渠道规避上游限流。不同 Key 是否提供独立容量以供应商的账号、项目或组织配额为准。

### 2.3 价格

模型售价只由服务端 `model_prices` 提供，并按版本记录。价格以整数最小单位存储，输入、缓存输入和输出分别计价；客户端不保存价格常量，不能决定扣费金额。

一个 Agent 回合可能包含工具调用、重试和子 Agent 请求。计费单位是每次上游请求的真实 usage；客户端可以自行汇总展示，但服务端账务只按 `model_requests.request_id` 结算，不按“用户发一条消息”固定收费。

## 3. 职责边界

### Mona Auth

- 认证用户并签发短期、作用域受限的模型访问令牌；
- 创建和查询积分充值订单；
- 验证支付回调并为订单入账；
- 维护积分钱包和不可变流水；
- 在调用上游前预留积分，在结束后按 usage 结算；
- 提供用户级并发/频率限制；
- 提供对账、人工调整和紧急停用能力。

### One API

- 保存上游渠道和 API Key；
- 统一上游 OpenAI 兼容协议；
- 选择健康可用的渠道；
- 返回或记录上游 usage；
- 提供渠道级故障切换。

One API 不承担人民币订单、Mona 积分余额或退款事实源；不为每个 Mona 用户创建 One API 用户和余额。

后续增加合法上游 Key 时，只在 One API 增加或启停渠道并配置优先级/权重；Mona Auth 继续使用同一个内部 One API Token，不需要改客户端或重新部署账本服务。多个 Key 是否真的叠加 RPM/并发，仍以供应商的账号、项目或组织级配额为准，不能假定“多一个 Key 就多一份容量”。

### Mona Desktop

- 展示余额、商品、订单状态和消费流水；
- 使用短期模型令牌调用 Mona 的 `/v1`；
- 保留 BYOK 设置；
- 对 `402 insufficient_credits`、排队和服务暂不可用给出明确提示。

客户端提交的 Token usage 只能用于展示，不能作为扣费依据。

### UI 交互参考 Cindy 的最小取舍

Mona 复用 Cindy `BillingPage` 的信息骨架而不是完整订阅系统：余额卡与充值动作同组；余额、商品、流水和订单独立加载，单个补充接口失败不拖垮整页；只在存在订单时展示最近 10 笔，并允许继续待支付订单；支付完成后刷新余额、流水和订单。订单号截断展示但保留完整 `title`，金额始终使用服务端字符串，积分字符串不经 JavaScript 浮点转换。

首版不复制 Cindy 的订阅额度池、赠送池、自定义金额、多币种、多支付供应商和复杂分页。支付页面只能通过 Tauri 固定命令打开，并限制为支付宝生产/沙箱 HTTPS 网关，React 不能传任意外部 URL 给系统 shell。

## 4. MySQL 数据模型

新增表放入现有 `mona_auth` 数据库；One API 继续使用自己的数据库表，不与 Mona Auth 共用业务表。所有新表使用 InnoDB。

### 4.1 `credit_wallets`

每个用户一行余额投影：

| 字段 | 规则 |
|---|---|
| `user_id` | 主键，关联 `users.id` |
| `available_units` | `BIGINT`，可用积分，不能小于 0 |
| `reserved_units` | `BIGINT`，请求预留积分，不能小于 0 |
| `active_requests` | 当前用户活动模型请求数，钱包行锁内原子增减 |
| `version` | 乐观版本号，更新时递增 |
| `created_at` / `updated_at` | 时间戳 |

钱包不是完整历史；历史以 `credit_ledger` 为准。

### 4.2 `credit_ledger`

只追加、不更新历史记录：

| 字段 | 规则 |
|---|---|
| `id` | `BIGINT` 主键 |
| `user_id` | 关联用户并建立索引 |
| `event_type` | `topup`、`usage`、`refund`、`adjustment` |
| `delta_units` | 有符号 `BIGINT`，入账为正，消费/退款冲销按业务方向记录 |
| `reference_id` | 业务幂等键 |
| `balance_after` | 本次事务后的钱包总额（可用积分 + 预留积分） |
| `metadata` | 仅放必要的非敏感业务信息 |
| `created_at` | 创建时间 |

建立 `UNIQUE(event_type, reference_id)`，确保同一支付或模型请求不会重复产生同类流水。

### 4.3 `credit_products`

积分充值商品目录：`code`、`name`、`price`、`credit_units`、`enabled`、`sort_order`、时间戳。`price` 使用 `DECIMAL(12,2)`，禁止使用浮点数。展示积分与内部账务单位的换算固定为 **1 Mona 积分 = 1,000,000 个 internal units**；用户购买的数量由服务端商品记录决定。

### 4.4 `model_prices`

模型价格快照：`model`、`version`、`input_rate`、`cached_input_rate`、`output_rate`、`effective_at`、`enabled`。费率以每百万 Token 对应的 internal units 表示，所有计算使用整数并向上取整；启用价格前必须完成成本和利润复核。

### 4.5 `model_requests`

上游请求及其账务状态：

| 字段 | 规则 |
|---|---|
| `request_id` | 客户端/服务端生成的 UUID，主键 |
| `user_id` | 用户归属 |
| `model` / `price_version` | 请求模型和价格快照 |
| `status` | `reserved`、`running`、`settled`、`released`、`uncertain` |
| `reserved_units` / `actual_units` | 预留和实际扣费 |
| `prompt_tokens` / `completion_tokens` / `cached_tokens` | 权威 usage |
| `upstream_request_id` | One API/供应商请求标识 |
| `error_code` | 脱敏后的故障代码 |
| `created_at` / `settled_at` | 时间戳 |

`request_id` 唯一。相同 `request_id` 重试返回冲突及当前状态，不能再次预留或调用上游；首版不保存完整模型响应，因此不承诺重放原响应正文。

### 4.6 `model_gateway_locks`

单行全局门闩，保存 `active_requests`。每次预留先锁用户钱包，再锁门闩，检查并同时增加用户级/全局活动计数；结算、释放或转入 `uncertain` 时在同一事务内同时递减。不能用 `REPEATABLE READ` 下的普通 `COUNT(*)` 代替该计数，真实 MariaDB 并发已证明旧快照会造成超额准入。

### 4.7 现有 `payments` 扩展

保留现有订阅支付记录，增加 `product_type`、`product_code`、`credit_units`、`fulfillment_status`、`refund_status`、`refunded_units`、`refunded_at` 等字段区分订阅、积分充值和退款状态。现有金额字段从 `FLOAT` 迁移到 `DECIMAL(12,2)`，迁移前核对历史数据。

## 5. 支付与积分入账

### 5.1 创建订单

```text
客户端读取启用商品
→ 服务端按商品 code 查询金额和积分
→ 创建 pending 支付订单
→ 向支付宝发起订单
→ 返回支付地址和本地订单号
```

客户端不能提交任意金额或任意积分数。

### 5.2 支付回调

支付服务端必须依次完成：

1. 验证支付宝签名；
2. 核对应用身份、商户身份、订单号和本地金额；
3. 核对支付状态为成功；
4. 在同一个 MySQL 事务中锁定支付订单行；
5. 若订单已入账，直接返回成功，不重复处理；
6. 标记订单已支付；
7. 锁定用户钱包；
8. 写唯一 `topup` 流水并增加可用积分；
9. 标记 `fulfillment_status=succeeded`；
10. 提交事务。

客户端轮询只读订单状态，不能触发入账。回调丢失时由服务端主动查询补偿，仍必须复用同一幂等事务。

软件授权付款和积分充值共用上述资金通知校验。一次性付款、首期付款和周期扣款均核对 seller ID 与金额；纯签约/解约通知不发生资金交易，只校验 RSA2 签名和 app ID，避免把交易字段错误强加到协议状态通知。

## 6. 模型请求与扣费

### 6.1 预留

```text
验证短期模型令牌和模型权限
→ 读取价格快照
→ 用请求 UTF-8 字节数作为保守输入上限，并结合 max_tokens 计算本次上限
→ 锁定钱包行
→ available_units 减少，reserved_units 增加
→ 插入唯一 model_requests
→ 调用 One API
```

预留不足直接返回 `402 insufficient_credits`；MySQL不可用时拒绝请求且不调用 One API。

预留提交后、真正发送 HTTP 请求前先把状态改为 `running`。只有明确的 DNS/TCP/TLS 连接失败可以释放预留；读超时、写入中断、客户端取消或其他“请求可能已经送达上游”的异常必须进入 `uncertain`，避免把已经发生的上游成本当成免费调用。

### 6.2 流式代理

Mona Auth 作为客户端与 One API 之间的服务端代理：

- 客户端只携带 Mona 模型令牌；
- Mona Auth 使用内部 One API Token；
- Mona 的 `request_id` 透传为内部请求标识；
- 使用 SSE 透传，不在数据库逐 Token 写入；
- 日志不记录 Authorization、Key、提示词或完整响应；
- 已经向客户端输出内容后，不自动切换模型重试。

### 6.3 结算

请求完成后，读取 One API/上游返回的权威 usage，按价格快照计算实际费用：

```text
actual_units =
  ceil(uncached_input_tokens × input_rate ÷ 1,000,000)
  + ceil(cached_tokens × cached_input_rate ÷ 1,000,000)
  + ceil(output_tokens × output_rate ÷ 1,000,000)
```

在一个事务中锁定 `model_requests` 和钱包：

- 从 `reserved_units` 移出实际费用；
- 剩余预留退回 `available_units`；
- 写唯一负数 `usage` 流水；
- 标记请求为 `settled`。

若实际 usage 大于预留、usage 缺失或状态无法确认，标记 `uncertain`，保留预留并进入恢复/人工对账，不自动免费放行，也不盲目扣费。

## 7. 最小 API

接口由现有 Mona Auth 提供，具体字段以实现时的 Pydantic schema 为准：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/credits/products` | 返回启用的充值商品 |
| `GET` | `/credits/balance` | 返回可用、预留和更新时间 |
| `GET` | `/credits/ledger` | 返回当前用户分页流水 |
| `GET` | `/credits/usage` | 返回当前用户近 30 天已结算 Token、积分、模型和最近请求统计 |
| `POST` | `/credits/orders` | 按商品 code 创建充值订单 |
| `GET` | `/credits/orders` | 返回最近充值订单和是否存在更早记录 |
| `GET` | `/credits/orders/{order_id}` | 查询充值订单状态 |
| `POST` | `/model-access/token` | 签发短期、模型作用域令牌 |
| `POST` | `/v1/chat/completions` | OpenAI 兼容文本模型入口，支持流式 |
| `GET` | `/v1/models` | 返回当前可用的托管模型 |

管理员能力挂在现有 Mona Auth 的 `/admin/credits` 路由下，不建设独立完整运营后台。已覆盖商品启停/编辑、模型价格版本、模型停用、人工调账、`uncertain` 请求处理、对账和已支付未消费积分的全额退款；所有调账必须填写原因并产生 `adjustment` 流水。

当前管理接口范围：`/admin/credits/products`、`/admin/credits/model-prices`、`/admin/credits/models/{model}/disable`、`/admin/credits/users/{user_id}/adjustments`、`/admin/credits/uncertain-requests`、`/admin/credits/requests/{request_id}/resolve`、`/admin/credits/reconciliation`、`/admin/credits/payments/{payment_id}/refund`。

生产运营入口统一使用 `https://www.mona-ai.cn/admin/`。该后台同时提供积分商品、模型计价、对账、异常请求和模型渠道维护；模型渠道操作由 Mona Auth 使用内部管理员令牌转发给本机 One API，完整上游 Key 不返回浏览器。详细边界见[管理后台计费与渠道设计](../design/mona-admin-billing-gateway-design-2026-08-27.md)。

人工调账必须提交稳定的 `idempotency_key` 和原因；网络重试复用同一个 key，不能重新生成，以免重复调账。

创建充值订单同样要求客户端 checkout `idempotency_key`。同一次网络重试复用该 key，服务端映射到确定性本地订单号并返回同一待支付订单；只有明确失败或用户主动开始新的购买尝试才生成新 key。

## 8. 可靠性与安全

### 8.1 幂等与不变量

必须始终满足：

```text
available_units >= 0
reserved_units >= 0
同一支付订单只入账一次
同一 request_id 只预留/结算一次
钱包投影 = 账本汇总
```

所有余额变化使用 InnoDB 事务和 `SELECT ... FOR UPDATE`。不要用“先读余额、应用层判断、再写入”的非原子流程。

### 8.2 限流与容量

首发限制：

- 每用户同时 1 个生成任务；
- 全局文本生成并发 20；
- 单请求输入、输出和总执行时间有服务端上限；
- 超出并发明确返回繁忙，不在首版引入队列；
- 用户级活动计数保存在已锁定的钱包行，全局活动计数保存在 `model_gateway_locks`；两者与请求状态在同一事务内变化；
- 不使用 Redis、多实例或消息队列。

2 核 4 GiB 是当前单机最小生产起点；现有 1.6 GiB 只适合测试。20 并发、平均每个上游请求 20 秒时理论吞吐为 60 请求/分钟；如果一个 Agent 回合平均 5 次上游调用且每用户 5 分钟发起一次回合，数学推演约为 60 个峰值活跃用户，不是 SLA 或压测承诺。注册用户数不能直接换算容量。

### 8.3 网络与密钥

- Nginx 对外提供 HTTPS；
- One API 只监听本机或私有网络；
- MySQL 只允许明确的内网来源，禁止公网任意访问；
- 上游 Key 和 One API 内部 Token 不进入桌面客户端；
- 模型访问令牌短期、作用域受限，过期后重新签发；
- 已通过聊天暴露的运维凭据必须轮换；
- 数据库和配置每日备份并做恢复演练。

### 8.4 日志与告警

保留完成对账所需的请求 ID、模型、Token usage、金额、状态和时间，不记录提示词和完整响应。至少告警：重复入账、负余额、钱包对账差异、长时间 `reserved/running/uncertain`、One API 401/402/429/5xx、数据库故障、内存/磁盘不足。

## 9. 部署形态

生产业务域名统一为 `https://mona-ai.cn`。客户端、支付宝回调、上传地址和托管模型入口均以根域名为主；`https://www.mona-ai.cn` 只作为同证书下的连接失败兼容入口，旧业务域名 `mona.lzfun.vip` 不再参与新客户端 API 路由。`dl.mona.lzfun.vip` 仍是独立下载/CDN 域名，不属于本次业务域名迁移范围。

```text
Nginx :443
├─ /auth、/credits、/payment、/health → Mona Auth :8901
└─ /v1 → Mona Auth :8901（流式代理）

Mona Auth → One API 内网端口
Mona Auth / One API → 各自 MariaDB 数据库
```

初期只保留一个 Mona Auth 进程组、一个 One API 实例和一个 MySQL 实例；Mona Auth 使用单 worker，避免 APScheduler 重复执行。单 worker scheduler 负责 stale request recovery、pending payment query 和 daily wallet reconciliation；用 systemd 自动重启。增加第二个模型代理实例前不引入 Redis，避免多实例限流状态不一致。

`/health` 仅作为进程存活检查；仅限本机访问的 `/ready` 额外检查积分表、数据库连接、启用状态下的支付宝配置和 One API `/api/status`。部署脚本必须以 `/ready` 通过作为发布成功条件。

上线前要完成：One API 空 SQLite 备份、MariaDB 初始化、合法 DeepSeek 渠道配置、systemd 自启动、管理入口收口、证书续期修复和备份恢复演练。

## 10. 明确不做

- 不使用百炼 Coding Plan承接用户流量；
- 未获书面商业授权不使用硅基流动个人 Key承接用户流量；
- 不给最终用户发 One API Token或上游 Key；
- 不把客户端 usage 当作账单事实；
- 不使用 One API 的用户余额作为 Mona 账本；
- 不建设 Redis、微服务、消息队列、多活和多区域；
- 不做积分转账、提现、交易、过期和订阅赠送池；
- 不做“无限量”套餐和跨供应商静默换模型；
- 不在首版开放图片、视频、音频等不同计费口径的能力；
- 不建设完整 BI、优惠券、分销和组织账户。

## 11. 上线门禁

以下条件全部通过，才允许白名单用户受控上线。当前状态是“代码完成候选”，不是“生产已完成”：

### 资金一致性

- 相同支付宝回调重复 100 次只产生一条入账流水；
- 支付订单金额、应用和商户身份校验全部通过；
- 并发请求不能产生负余额或负预留；
- 相同 `request_id` 重试不重复调用、不重复扣费；
- 钱包与账本对账结果为零差异；
- 退款和人工调整均有可追溯流水。

### 故障恢复

- 预留后调用上游前崩溃可释放；
- 上游已接受但客户端断开可查询并结算；
- 输出中断和结算前崩溃不造成永久冻结或重复扣费；
- One API、上游、MySQL故障均有明确 fail-closed 行为；
- 备份可以恢复到隔离环境。

### 安全与运行

- One API、MySQL管理端口无非必要公网暴露；
- 运维账号已轮换并使用 SSH Key；
- 认证、模型令牌、上游 Key 不出现在日志；
- 5、10、20 并发阶梯压测无 OOM、无不变量破坏；
- 监控和 P0/P1 告警可收到；
- 上游商业授权、隐私政策、退款规则和生成内容合规事项已确认；
- MariaDB 真实并发事务、真实 DeepSeek usage、支付沙箱和部署安全验证均已通过。

## 12. 回滚原则

回滚优先保证钱和积分不丢：

1. 关闭托管模型入口和新积分订单创建；
2. 保留已支付订单和全部账本，不删除数据；
3. 让已开始的请求完成结算或进入 `uncertain`；
4. 应用回滚到上一个已验证版本；
5. 数据库迁移只执行已验证的 down migration 或前向兼容修复，不直接删除生产表；
6. 对账确认后再恢复流量。

如果只是模型渠道故障，停用对应 One API 渠道即可，不回滚积分账本；如果账务不一致，暂停所有托管调用，人工核对后再处理调整流水。

## 13. 仍需确认的外部事项

- 供应商当前套餐和 API 服务是否允许面向终端用户商业集成；
- 中国境内公众服务所需的备案、内容标识、实名、隐私和税务要求；
- 支付宝当前签约产品对积分充值、退款和对账的具体约束；
- 实际 DeepSeek 模型在 One API 当前版本下的流式 usage 完整性；
- 当前 VPS 升级后的真实并发、内存和网络容量。

这些事项未完成前，方案仍是 Conditional Go；当前实现不得开放生产支付或托管模型流量，不得以代码存在或文档替代实际验证。
