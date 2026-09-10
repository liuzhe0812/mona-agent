# Mona 积分付费开发计划

> **商业口径更新：** 2026-08-27 已确认改为人民币余额计费。内部 `credit_*` 账本结构继续复用，用户、管理员和文档以[人民币余额方案](../reports/mona-balance-production-design-2026-08-27.md)为准。

> 计划日期：2026-08-26  
> 版本：1.2  
> 当前状态：核心代码已完成候选；生产 feature flags 默认关闭，生产门禁未完成  
> 目标：按 [最小生产方案设计](../reports/mona-credits-production-design-2026-08-26.md) 落地积分充值、服务端扣费和受控上线  
> 原则：复用现有 Mona Auth、支付宝、MySQL、One API；只增加资金闭环必需的代码

## 1. 交付目标

完成后用户可以：

```text
登录
→ 查看积分商品
→ 支付宝购买积分
→ 服务端验签并入账
→ 通过 Mona /v1 使用托管文本模型
→ 按权威 usage 扣费
→ 查看余额与流水
```

生产首发约束：DeepSeek 正式按量 API、文本模型、每用户一个并发、单机全局 20 并发、BYOK 保留。1 Mona 积分固定对应 1,000,000 个 internal units；当前 `model_access_enabled=false`、`credits_payment_enabled=false`，商品和模型价格默认 `enabled=false`。**代码完成候选不等于生产已完成。** 真实 DeepSeek、支付沙箱和部署安全门禁未通过前，不能生产开放。

2026-08-26 本地验收快照：Mona Auth 为 94 passed / 4 个 MariaDB 用例按环境门槛 skipped，Ruff 全绿；积分/支付相关 WebUI 为 11 passed，托管 Provider 为 2 passed，新增 Rust 安全/参数用例为 5 passed；积分相关生产文件定向 TypeScript 校验和 `cargo check` 通过。整站 Web 构建曾在积分改动后通过，但当前共享工作区被另一个未跟踪的 `SeriesStyleEditor.tsx` 类型错误阻断；完整 WebUI/Cargo 测试也存在与积分无关的既有失败，因此这里只声明积分范围回归通过，不把整仓状态描述为全绿。

2026-08-27 已完成[生产后端基础发布](../reports/mona-credits-production-base-deployment-2026-08-27.md)：生产 revision 已升级为 `credits_billing`，`mona-ai.cn` 的积分与用量接口返回 JSON，Mona Auth 使用 PM2 单 worker；积分支付与托管模型仍关闭，充值商品和模型价格为空，未创建任何新支付订单。

同日 VPS 隔离库 `mona_auth_credits_test` 已完成真实 MariaDB 验收：`alipay_sub → credits_billing → alipay_sub → credits_billing` 升降级通过；10 路余额竞争、全局容量、20 路相同请求 ID、20 路重复支付回调、20 路重复调账、stale recovery、钱包和活动计数对账全部通过。测试过程发现并修复了 `REPEATABLE READ` 旧快照导致的全局超额准入和幂等查询失效问题。生产库仍为 `alipay_sub`、无积分表、11 条支付记录和 `FLOAT` 金额字段，确认未被测试修改。

## 2. 实施分工

复杂且涉及资金一致性的部分由主开发者负责：数据库迁移、钱包服务、支付回调幂等、模型代理、结算恢复和上线决策。

可独立验证的简单任务交给 Luna：只读代码/部署清单、接口字段核对、测试数据生成、前端显示层接线、Markdown/静态检查和压测结果整理。Luna 不直接修改生产数据库、不管理上游 Key、不独立决定账务规则；涉及资金逻辑的变更必须由主开发者复核。

## 3. 文件范围

### 3.1 后端已落地候选/仍需验证

| 文件 | 变更 |
|---|---|
| `mona-auth/app/models.py` | 已增加钱包、流水、商品、模型价格、模型请求模型；已扩展支付模型 |
| `mona-auth/app/schemas.py` | 已增加积分、订单、模型令牌和管理员 schema |
| `mona-auth/app/config.py` | 已增加模型代理、限流和账务配置；默认值关闭/安全 |
| `mona-auth/app/auth.py`、`mona-auth/app/deps.py` | 已签发/校验模型作用域令牌，保留账号令牌 |
| `mona-auth/app/credits.py` | 已实现钱包预留、结算、释放、入账、退款、调账和恢复事务 |
| `mona-auth/app/model_billing.py` | 已实现 internal units 的预留/实际费用计算 |
| `mona-auth/app/routers/credits_router.py` | 已提供商品、余额、流水和积分订单接口 |
| `mona-auth/app/routers/model_access_router.py` | 已提供 `/v1/models`、`/v1/chat/completions` 和流式 usage 处理 |
| `mona-auth/app/routers/admin_credits_router.py` | 已提供商品/价格、调账、uncertain、对账和退款管理接口 |
| `mona-auth/app/routers/subscribe_router.py` | 已接入积分支付回调、幂等入账和 pending payment query；需继续完成真实验证 |
| `mona-auth/app/main.py` | 已注册积分、模型访问和管理员路由 |
| `mona-auth/app/scheduler.py` | 已提供单 worker 的 stale recovery、pending payment query 和 daily reconciliation |
| `mona-auth/alembic/env.py` | 已导入新增模型 |
| `mona-auth/alembic/versions/2026_08_26_add_credits_billing.py` | 已新增表、索引、约束、定点金额和支付字段迁移 |
| `mona-auth/.env.example` | 已补充非敏感配置说明；生产值仍只在服务器安全配置中 |

当前实现已提供候选代码；后续只在验证发现缺口时修改这些文件，不再新增重复 service 或抽象层。

### 3.5 当前接口合同

客户端实际使用的接口为：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/credits/products` | 启用商品目录 |
| `GET` | `/credits/balance` | 当前用户余额和预留 |
| `GET` | `/credits/ledger` | 当前用户积分流水 |
| `GET` | `/credits/usage` | 当前用户近 30 天已结算 Token、积分、模型和最近请求统计 |
| `POST` | `/credits/orders` | 按商品 code 创建支付宝订单 |
| `GET` | `/credits/orders` | 最近 10 笔充值订单，可恢复待支付订单 |
| `GET` | `/credits/orders/{order_id}` | 查询积分订单及入账状态 |
| `POST` | `/model-access/token` | 签发短期模型访问令牌 |
| `GET` | `/v1/models` | 当前启用的托管模型 |
| `POST` | `/v1/chat/completions` | OpenAI 兼容模型调用 |

管理员接口挂在现有 `/admin/credits` 下，不建设独立完整后台；支持商品/模型价格版本、启停、调账、`uncertain` 处理、对账和未消费积分全额退款。

### 3.2 后端测试

| 文件 | 变更 |
|---|---|
| `mona-auth/tests/test_credits.py` | 已覆盖商品、余额、流水、预留/结算/释放、退款和恢复；MariaDB 主链并发已由隔离验收脚本验证 |
| `mona-auth/tests/test_model_gateway.py` | 已覆盖令牌、usage、字段隔离、上游错误、Mock 断流、余额不足和重复请求；真实客户端断开/DeepSeek 仍需集成验证 |
| `mona-auth/tests/test_model_billing.py` | 已覆盖输入/缓存/输出分项计价、整数向上取整、零费率和预留下限 |
| `mona-auth/tests/integration/test_credits_mysql.py` | MariaDB pytest 用例入口；无测试库时安全跳过 |
| `mona-auth/tests/integration/run_mysql_acceptance.py` | 已在 VPS 隔离库执行的无 pytest 依赖验收脚本 |
| `mona-auth/tests/integration/run_payment_smoke.py` | 已上传但尚未执行；复用生产支付宝配置，在测试库生成但不打开/支付 0.01 元订单，并验证幂等与域名 |
| `mona-auth/tests/test_payment.py` | 现有订阅流程回归测试 |
| `mona-auth/tests/conftest.py` | 测试依赖覆盖和数据初始化；不得写真实凭据 |

### 3.3 客户端已落地候选/仍需验证

| 文件 | 变更 |
|---|---|
| `src-tauri/src/license.rs` | 已增加积分/模型令牌桥接；认证令牌改由凭据存储读取 |
| `src-tauri/src/terminal/credential_store.rs` | 已提供 Windows DPAPI 凭据保护 |
| `src-tauri/src/lib.rs` | 已注册积分和模型访问 Tauri commands |
| `webui/src/components/CreditsView.tsx` | 参考 Cindy 的最小计费骨架，提供余额+充值动作、独立加载、固定商品、最近订单/继续支付、流水和支付后刷新 |
| `webui/src/components/settings/AccountSettings.tsx` | 嵌入通用设置的账号、软件权益和模型余额摘要内容 |
| `webui/src/components/settings/UsageSettings.tsx` | 参考 Cindy 的近 30 天概览、每日柱状图、模型拆分和最近调用页 |
| `webui/src/components/settings/SettingsView.tsx` | 通用设置首项合并账号内容，并保留余额与充值、用量统计独立分区 |
| `webui/src/components/PaymentDialog.tsx` | 已复用二维码、轮询和失败状态，支持积分订单参数 |
| `webui/src/components/LoginDialog.tsx` | 已接入积分视图入口 |
| `webui/src/components/CreditsView.test.tsx` | 已覆盖余额、商品和支付入口；本地定向测试与生产构建已通过，仍需桌面实机回归 |
| `mona/providers/registry.py`、`mona/providers/factory.py` | 已注册 Mona 托管 provider，关闭自动 fallback |
| `mona/providers/mona_managed_provider.py` | 已实现短期令牌刷新、Mona `/v1` 调用和错误提示 |

UI 明确不复制 Cindy 的订阅额度池、赠送池、自定义金额、多币种、多支付渠道和复杂分页。充值 checkout 使用稳定幂等键；Tauri 只允许打开支付宝生产/沙箱 HTTPS 网关，不再通过 `cmd /c start` 接受任意 URL。

### 3.4 部署文件

| 文件 | 变更 |
|---|---|
| `mona-auth/deploy/mona-auth.service` | 已切为单 worker、自动重启和受限进程；需在 VPS 验证 |
| `mona-auth/deploy/nginx.conf` | 模板已加入 `/v1`、`/credits`、`/model-access` 和 SSE 配置；需部署到实际域名验证 |
| `mona-auth/deploy/deploy.sh` | 已加入备份确认门、占位域名拒绝、干净 Git release、Alembic upgrade、Nginx 校验和健康检查；真实备份恢复与回滚仍需 staging 验证 |

`.gitignore` 仅增加 Mona Auth 源码、积分文档和测试的精确追踪例外；环境文件、密钥目录、私钥和本地虚拟环境继续忽略。不得把真实 VPS 配置、密码、API Key 或支付宝私钥写入仓库。

## 4. 分阶段计划

### 阶段 0：基线和生产前置（未完成）

2026-08-26 已完成一次只读迁移前检查：生产库 `alembic_version=alipay_sub`，现有 11 条支付记录没有超过两位小数的金额，`alipay_trade_no` 无重复，新积分表尚不存在；候选迁移可从当前 revision 前进。该快照只证明当时数据可迁移，正式执行前仍需重新检查并先做备份。

同日只读配置检查确认支付宝 app 与密钥路径已配置，但生产 `.env` 中 `MONA_AUTH_ALIPAY_SELLER_ID` 缺失。用户随后已提供 seller ID；该值不硬编码、不提交仓库，只在获得部署授权后注入生产环境。候选版本在 production 模式会拒绝带着空 seller ID 启动。

生产历史只读核对显示现有软件授权链路已有 2 笔支付宝 `PAID` 订单、2 个支付宝交易号和 2 个活动订阅，说明积分可以继续复用同一 `payments`、支付宝回调、主动查询和 `PaymentDialog`，无需另建支付系统。剩余支付门禁是补齐 seller ID，并用现有商户的隔离/小额流程验证加固后的金额、商户身份、重复回调和退款。

同一轮只读调用现有 `AlipayService.query_trade` 查询一笔已支付订单，支付宝接口启用、返回码、交易成功状态和本地金额四项均匹配；该操作没有创建订单或退款。查询响应不包含 seller ID，因此部署时使用用户从支付宝商户配置确认的 PID。

**任务**

- 确认 Mona Auth 当前数据库、Alembic 版本和支付历史数据；
- 确认 One API 当前版本、数据库、端口、渠道和启动方式；
- 轮换已暴露的运维凭据，收口 MySQL/One API 管理入口；
- 将 VPS 上 Mona Auth 部署与当前 Git commit 对齐；
- 确认 MySQL 备份覆盖并做隔离恢复演练；
- 将 One API 的 Coding Plan 渠道排除出用户流量。

**产出**

- 一份无秘密的只读检查结果；
- 可回滚的应用版本；
- 可验证的数据库备份。

**门禁**

- MySQL 不再任意公网开放；
- One API 可停止/启动且配置可追溯；
- 备份能在隔离环境恢复；
- 外部供应商授权边界已记录。

### 阶段 1：数据迁移和账本核心（MariaDB 隔离验收已通过）

**任务**

- 新增五类积分表及索引；
- 将支付金额迁移为定点金额表示；
- 扩展积分商品字段；
- 实现钱包初始化、行锁、流水唯一约束；
- 实现预留、结算、释放和人工调整；
- 固定价格版本并记录到模型请求。
- 固定 1 积分 = 1,000,000 internal units；
- 使用钱包 `active_requests` 与 `model_gateway_locks.active_requests` 保护用户级/全局并发准入。

**验证**

- 空余额、足额、不足额、重复 request_id；
- 事务失败自动回滚；
- 并发预留不透支；
- 钱包投影与账本汇总一致。

**门禁**

- 关键事务测试通过；
- 不变量在异常路径仍成立；
- Alembic upgrade 可执行，回滚路径经过检查；
- 不改写历史流水。

当前状态：真实 MariaDB 的行锁、唯一约束、并发预留、请求/支付/调账幂等、迁移升降级和 stale recovery 已在隔离库通过。生产迁移仍需在发布前重新备份、预检并保持 feature flags 关闭。

### 阶段 2：支付充值闭环（代码完成候选，支付沙箱未验收）

**任务**

- 新增积分商品读取和积分订单创建；
- 复用现有支付宝支付界面/轮询；
- 回调验签后核对 app、seller、订单号、金额和成功状态；
- 支付订单行锁 + 唯一入账流水；
- 增加主动查询补偿和人工对账入口；
- 保持原订阅支付流程兼容。
- 已支持管理员对已支付且未消费的积分订单发起全额退款；退款前必须确认支付宝实际退款成功。

**验收**

```text
同一支付回调重复 100 次
→ 订单只 paid 一次
→ 只有一条 topup 流水
→ 钱包只增加一次
```

**门禁**

- 支付沙箱或隔离环境测试通过；
- 订单金额不可由客户端修改；
- 支付异常不发积分；
- 支付历史数据迁移前后金额可对账。

当前状态：订单、验签、入账和查询代码已完成候选；必须通过支付宝沙箱/隔离商户的真实回调、重复回调和退款验证。

### 阶段 3：服务端模型代理和扣费（代码完成候选，真实渠道未验收）

**任务**

- 增加短期 `model-access` token；
- 增加 Mona Auth `/v1` 入口；
- 请求进入前读取价格、估算上限并预留积分；
- 使用内部 One API Token 调用上游；
- 支持 SSE 透传与最终 usage；
- 按 request_id 幂等结算；
- 映射余额不足、429、401、402、5xx 和超时；
- 明确中断、崩溃和 usage 缺失状态。
- 全局并发准入使用 `model_gateway_locks`，首发上限为 20；不引入 Redis 或队列。

**验收**

- DeepSeek 正式 API 流式和非流式请求均可取得权威 usage；
- 工具调用和多次 Agent 请求分别产生 request_id；
- 完成/失败/断流都不会重复扣费；
- MySQL不可用时请求不会到达 One API；
- One API故障时预留可释放或进入可恢复状态。

**门禁**

- 真实渠道 usage 对账一致；
- 上游 Key、内部 Token和用户内容不进客户端/日志；
- 20 并发压测前先通过单请求和故障注入测试。

当前状态：`model_access_router.py`、`model_billing.py` 和 `mona_managed_provider.py` 已完成候选；必须用真实 DeepSeek + One API 验证流式 usage、模型映射、429/5xx、断流和实际扣费。

### 阶段 4：客户端余额和托管模型（代码完成候选，客户端回归未验收）

**任务**

- 增加余额、商品、流水和充值状态展示；
- 复用 `PaymentDialog`，区分订阅订单和积分订单；
- 增加 Mona 托管模型选项；
- 遇到 `insufficient_credits` 显示充值入口；
- 展示单回合/请求消费结果；
- 保证 BYOK 不走积分账本；
- 认证令牌使用现有凭据存储；Windows 使用 DPAPI。

**门禁**

- 充值成功后余额刷新；
- 取消、超时、失败和重复打开支付窗口状态正确；
- BYOK 流程回归通过；
- 未登录、令牌过期和余额不足均 fail closed。

当前状态：`CreditsView.tsx`、Tauri 桥接和 Mona 托管 provider 已完成候选；需完成前端构建、Windows 凭据存储和真实服务端回归。

### 阶段 5：对账、监控和恢复（代码完成候选，部署未验收）

**任务**

- 单 worker scheduler 已执行 stale request recovery、pending payment query 和 daily wallet reconciliation；
- 已提供 `uncertain` 请求的管理员 release/settle 处理；
- 已提供全局 feature flags、商品/模型价格启停和单模型停用；
- 监控告警需接入现有 VPS 运维渠道，不新增监控平台；
- 完成应用、数据库和 One API 的备份说明；
- 完成预留后各崩溃点恢复演练。

**门禁**

- 对账差异能被发现并定位；
- 无法确认的 usage 不会被自动免费释放；
- 恢复任务幂等且不会重复扣费；
- 运维可以在不删除账本的情况下停服/恢复。

当前状态：恢复、调度和对账代码已完成候选；必须验证 scheduler 只运行一个 worker、任务幂等、MariaDB 重启/断开恢复和真实部署配置。

### 阶段 6：压测和受控上线

**任务**

- 逐级执行 5、10、20 并发文本压测；
- 使用接近真实的 Agent 工具循环和上下文长度；
- 记录首字节延迟、总时长、内存、CPU、数据库延迟、429、账本差异；
- 白名单用户上线，限制每日消费和全局并发；
- 观察稳定性后再决定是否扩大流量。

**容量口径**

```text
理论上游请求/分钟 = 并发数 × 60 ÷ 平均请求秒数
Agent 回合/分钟 = 上游请求/分钟 ÷ 每回合上游调用数
```

20 并发不是 1000 个同时生成用户的承诺；1000 个注册用户能否共存取决于活跃率、每回合调用次数和上游限额。没有实测数据前不写对外 SLA。

**上线门禁**

- 所有阶段 P0 门禁通过；
- 20 并发持续测试无 OOM、无负余额、无重复扣费；
- 备份恢复演练成功；
- 供应商、支付、隐私、退款和生成内容合规事项已确认（当前未视为完成）；
- 有明确的停服和回滚负责人。

## 5. 统一验收清单

### 资金

- [ ] 订单金额为定点表示，客户端不能改价；
- [ ] 支付回调签名、应用、商户、订单号、金额和状态全部核验；
- [ ] 重复回调只入账一次；
- [ ] 余额不能为负；
- [ ] 钱包、流水、订单可按 reference_id 追溯；
- [ ] 退款/调整不删除原流水；
- [ ] 每日对账差异为零。

### 模型

- [ ] 只使用授权的正式 API 渠道；
- [ ] One API 不对公网开放管理/调用入口；
- [ ] 客户端不含上游 Key；
- [ ] 每次上游调用有唯一 request_id；
- [ ] 流式 usage 可核验；
- [ ] 多次 Agent 调用按请求分别结算；
- [ ] usage 缺失进入 uncertain，不盲扣、不免费；
- [ ] 上游 429/5xx/断流行为已验证。

### 安全与运维

- [ ] MySQL只允许必要网络来源；
- [ ] 生产 secrets 只在服务器安全配置中；
- [ ] 日志不含认证头、Key、提示词和完整响应；
- [ ] 备份可恢复；
- [ ] systemd 自动重启、Nginx HTTPS 和 SSE 透传验证通过；
- [ ] 监控可收到 P0/P1 告警；
- [ ] 可一键停用托管模型和单渠道。

## 6. 回滚和发布策略

生产业务 API 的规范域名为 `https://mona-ai.cn`；发布时同步核对根域名证书、支付宝回调、上传地址和 Nginx 路由。`www.mona-ai.cn` 仅保留兼容回退，下载/CDN 域名不随业务 API 一并迁移。

### 发布前

1. 建立发布 tag 和数据库备份；
2. 在隔离环境执行 Alembic upgrade；
3. 运行后端、前端和故障注入测试；
4. 记录当前 One API/Mona Auth 配置摘要，不记录密钥；
5. 先发布代码和迁移，再开启托管渠道。

### 发现问题时

```text
停止新模型请求和新充值订单
→ 保留已支付订单与账本
→ 等待/恢复已开始请求
→ 回滚应用版本或停用问题渠道
→ 对账并记录人工调整
→ 通过小流量验证后恢复
```

不直接删除新表、不清空钱包、不用 `git reset --hard` 覆盖用户数据。数据库只做前向兼容修复或经过验证的迁移回退。

## 7. 发布后观察

首发期间每日查看：支付成功率、未到账订单、余额对账、uncertain 请求、上游成本、429/5xx、平均响应时间、内存/磁盘和异常消费。先限制流量和金额，再依据真实数据调整并发、价格或新增合法渠道。

## 8. 明确不做

- 不先做 Redis、微服务、多实例、多区域或消息队列；
- 不先做组织余额、转账、提现、赠送池、积分过期和自动续费积分；
- 不把百炼 Coding Plan 或未授权的个人 Key 放进托管池；
- 不做图片/视频/音频的混合计费；
- 不做跨供应商静默换模型和无限量套餐；
- 不建设独立复杂计费后台、优惠券、分销或 BI。

只有单机、单渠道的资金和模型闭环稳定后，才根据实测瓶颈增加能力。

## 9. 计划完成定义

本计划完成不是“页面能显示余额”或“代码已合并”，而是以下事实同时成立：支付成功可幂等入账、MariaDB 并发事务不透支、真实 DeepSeek usage 可结算、支付沙箱回调和退款通过、异常请求可恢复、账本每日可对账、上游 Key 不暴露、部署安全门禁通过、服务器可停服和回滚，并且 20 并发阶梯压测通过。满足后才进入受控生产。
