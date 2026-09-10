# Mona 积分与托管模型服务可行性分析报告

> 报告日期：2026-08-25  
> 报告版本：1.0  
> 结论：**Conditional Go（方案可行，当前生产环境 No-Go）**  
> 范围：Mona Desktop、Mona Auth、One API、MariaDB、支付宝支付、DeepSeek、百炼 Coding Plan、硅基流动

## 1. 执行摘要

本项目在商业、产品和技术上均可行。Mona 已具备账号、订阅、支付宝下单、订单轮询、OpenAI 兼容模型调用和 Token usage 汇总能力；服务器已有 MariaDB 与 One API 二进制。缺口集中在积分账本、服务端模型代理、支付并发幂等、服务器安全和生产运维。

三个核心问题的直接答案：

1. **是否按最小生产版本开发即可？**  
   是。建议第一版只做 DeepSeek 正式 API、一次性积分充值、文本模型、每用户一个并发、BYOK 保留。Redis、多实例、组织共享、赠送积分池和跨厂商静默切换均不应进入首版。

2. **能否上线？**  
   能，但不能按当前服务器状态直接上线。完成本报告列出的全部 P0 门禁后，可先上线受控付费版；面向中国境内公众开放前，还需完成生成式 AI 服务、内容标识、隐私、实名和经营合规确认。

3. **能支持多少用户？**  
   当前没有经过负载测试，不能给出实测承载人数。建议将首发容量定义为 **20 个全局并发文本生成任务**，而不是注册用户数。按本报告的容量模型，在平均每次上游请求 20 秒、每个活跃用户每 5 分钟发起一次 Agent 回合的假设下：

   - 每回合 1 次上游调用：300 个峰值活跃用户；
   - 每回合 5 次上游调用：60 个峰值活跃用户；
   - 每回合 10 次上游调用：30 个峰值活跃用户。

   以上是数学推演，不是服务器压测结果。最终承诺必须以真实 Agent 工作负载压测为准。

## 2. 证据口径

本报告将数据分为三类：

- **已验证事实**：通过代码检查、数据库只读查询、服务器只读检查得到；
- **厂商官方事实**：来自阿里云百炼、DeepSeek、硅基流动、国家网信办等官方资料；
- **容量推演**：基于明确假设和计算公式，不代表实测结果。

本次未修改 VPS、One API、Nginx、MariaDB、支付配置或本地代码，也未读取、输出或持久化任何密码与 API Key。

## 3. 最终可行性矩阵

| 维度 | 结论 | 说明 |
|---|---|---|
| 商业模式 | Go | 订阅软件功能 + Mona 积分 + BYOK 可形成完整收入结构 |
| DeepSeek 正式 API | Go | 官方允许集成到面向终端用户的下游应用，Key 必须留在服务端 |
| 百炼 Coding Plan | No-Go | 仅限本人交互式编程工具，禁止应用后端、自动化调用和多人共享 |
| 硅基流动个人 Key | Conditional No-Go | 未获书面授权前不得作为公开付费转售渠道 |
| One API 渠道路由 | Conditional Go | 可复用，但当前未运行、使用 SQLite、只配置 Coding Plan |
| MariaDB 积分账本 | Go | InnoDB、事务、唯一索引和行锁可满足资金一致性 |
| 流式精确扣费 | Conditional Go | Mona 已支持 usage；需验证 One API + 实际渠道的完整流式 usage |
| 当前支付系统 | No-Go | 金额为 FLOAT，回调业务核验和并发幂等需加固 |
| 当前服务器安全 | No-Go | 3306 公网开放、UFW 未启用、One API 无 TLS/自启动、备份未验证 |
| 当前服务器容量 | 仅受控测试 | 2 核、1.6 GiB，One API 未运行，缺少真实负载数据 |
| 中国大陆公众上线 | Conditional | 需完成服务备案/评估、内容标识、隐私、实名和经营合规确认 |
| 整体项目 | Conditional Go | 完成 P0 后可上线最小生产版本 |

## 4. VPS 与现有服务审计

### 4.1 服务器资源

| 项目 | 已验证数据 |
|---|---:|
| 操作系统 | Ubuntu 24.04.3 LTS |
| CPU | 2 核 |
| 内存 | 1.6 GiB |
| 审计时可用内存 | 463 MiB |
| Swap | 2 GiB，审计时未使用 |
| 系统盘 | 40 GB |
| 可用磁盘 | 28 GB |
| 运行时间 | 31 周 |
| 系统状态 | 提示需要重启，存在待安装更新 |

当前资源适合技术验证和受控内测。由于 One API 未运行，无法测得其实际常驻内存。面向公众收费前，建议将内存提升至 4 GiB，或迁走无关 Node/游戏服务，并完成真实压测。

### 4.2 One API 现状

| 项目 | 已验证状态 |
|---|---|
| 版本 | v0.6.10 |
| 运行状态 | 未运行 |
| Nginx 目标端口 | 127.0.0.1:13000 |
| 实际端口状态 | 无监听 |
| 进程管理 | 未发现 systemd 或 PM2 启动项 |
| 实际数据库 | `/opt/one-api/one-api.db` SQLite |
| SQLite 完整性 | `ok` |
| SQLite journal | `delete` |
| 用户/渠道/令牌/日志 | 1 / 1 / 0 / 0 |
| MariaDB `one_api` 库 | 已存在但无表 |
| 本地备份 | 未发现 |

唯一渠道为 `qwen3.7-plus`，并确认使用百炼套餐专属 Key 与 Coding Plan Base URL。该渠道不能进入付费用户流量池。

由于 One API 没有用户令牌和调用记录，最小处理不是迁移旧 SQLite 数据，而是：

1. 备份并保留现有 SQLite；
2. 使用空的 `one_api` MariaDB 库重新初始化；
3. 重新添加合法的 DeepSeek 正式 API 渠道；
4. 建立 systemd 自启动与健康检查；
5. 仅允许 Mona Auth 通过内网访问。

### 4.3 网络与安全阻塞

已验证：

- MariaDB 监听 `0.0.0.0:3306`；
- 从公网实际可以连接 3306；
- UFW 未启用；
- MariaDB `require_secure_transport=OFF`；
- 存在允许任意来源登录的数据库账户；
- One API Nginx 配置是 HTTP catch-all，没有独立 HTTPS 域名；
- root 凭据曾通过聊天传递，应视为已暴露并轮换；
- 当前直接使用 root 运维，缺少专用 deploy 用户。

收口 MariaDB 前必须核对其他项目的连接来源，不能直接修改监听地址导致同机业务中断。可根据实际依赖选择本机监听、安全组白名单或防火墙白名单。

### 4.4 TLS、部署与备份

- `mona-ai.cn` 证书审计时有效至 2026-10-27；
- Nginx 配置语法检查通过；
- Certbot 定时任务当前失败，虽然失败对象是其他域名，但整体续期自动化不健康；
- 阿里云备份客户端正在运行，但无法证明 MariaDB 已纳入备份；
- 未发现 Mona Auth 或 One API 的本地数据库备份；
- `/opt/mona-auth` 不是 Git 仓库，无法定位部署 commit、确认版本或可靠回滚。

生产改造前必须建立版本化部署、数据库备份和恢复演练。

## 5. 上游模型供给

### 5.1 百炼 Coding Plan

结论：**仅限个人开发，不得作为积分供给。**

官方限制包括：仅限订阅者本人、仅限交互式编程/智能体工具、禁止自定义应用后端、禁止自动化 API 调用、禁止多人共享。违规可能暂停订阅或封禁 Key。

200 元 Coding Plan 应计入个人开发工具成本，不能当作可销售的低价模型库存。

### 5.2 DeepSeek 正式 API

结论：**作为首发唯一托管渠道。**

DeepSeek 开放平台协议允许开发者将 API 集成到面向终端用户的应用，要求 Key 留在服务端。当前官方文档显示并发按账号而不是按 Key 计算：`deepseek-v4-pro` 为 500，`deepseek-v4-flash` 为 2500。首发全局并发目标只有 20，因此上游并发不是初期瓶颈。

### 5.3 硅基流动

结论：**未获书面商业授权前只做 BYOK 或内部使用。**

当前平台协议将默认授权限定为个人或企业内部用途，并限制 API Key 转让及服务转售。若要加入 Mona 托管渠道，需要企业实名认证、书面授权和与终端用户服务场景匹配的合作协议。

### 5.4 渠道池建议

首发：

```text
mona-managed
└── DeepSeek 正式 API
```

后续：

```text
mona-managed
├── DeepSeek 主渠道
├── DeepSeek 独立合法容量
├── 百炼通用按量 API
└── 获得书面授权后的硅基流动企业渠道
```

不要通过新增同账号 API Key 规避账号级限流。

## 6. 推荐最小生产架构

```text
Mona Desktop
    │  短期 model-access token
    ▼
Mona Auth
    ├── 用户与订阅
    ├── 支付订单
    ├── 积分钱包与流水
    ├── 请求预留与结算
    ├── 用户限流
    └── /v1 流式模型代理
             │  内部 One API Token
             ▼
         One API
             ├── 上游 Key
             ├── 模型映射
             └── 渠道选择
                    ▼
               DeepSeek API

MariaDB
├── mona_auth：账号、支付、积分、模型请求
└── one_api：One API 自有配置与日志
```

职责边界：

- Mona Auth 是人民币订单、积分余额、退款和消费的唯一事实源；
- One API 只负责上游 Key、协议和渠道路由；
- One API 不向最终用户发 Token，不承担资金账本；
- 最终用户永远看不到 One API 内部 Token 和上游 Key；
- BYOK 继续由用户自行承担模型费用，不扣 Mona 积分。

第一版直接扩展现有 Mona Auth，不新增微服务。只有模型长连接开始影响登录支付稳定性后，才拆分 `/v1` 模型代理。

## 7. MySQL 积分账本

在现有 `mona_auth` 数据库新增：

| 表 | 核心职责 |
|---|---|
| `credit_wallets` | `available_units`、`reserved_units`、版本号 |
| `credit_ledger` | 不可变的充值、消费、退款和调整流水 |
| `model_requests` | 请求预留、运行、结算、释放和不确定状态 |
| `model_prices` | 版本化输入、输出、缓存售价 |
| `credit_products` | 积分充值商品 |

现有 `payments` 增加：

```text
product_type
product_code
credit_units
fulfillment_status
```

金额与积分规则：

- 人民币使用 `DECIMAL(12,2)` 或人民币分 `BIGINT`；
- 积分统一使用 `BIGINT` 最小计费单位；
- 禁止使用 FLOAT；
- `credit_ledger` 只追加，不更新历史流水；
- `UNIQUE(event_type, reference_id)` 防止重复入账和扣费；
- 钱包变更必须使用 InnoDB 事务与 `SELECT ... FOR UPDATE`。

核心不变量：

```text
available_units >= 0
reserved_units >= 0
钱包变化 = 所有 ledger 流水之和
同一支付订单只入账一次
同一 request_id 只扣费一次
```

## 8. 支付闭环

```text
创建积分订单
→ 支付宝支付
→ 服务端异步回调
→ 验签
→ 核对 app_id / seller_id / 订单号 / 金额
→ 锁定订单行
→ 标记 paid
→ 写正数 credit_ledger
→ 增加 wallet.available_units
→ 标记 fulfillment succeeded
→ COMMIT
```

客户端轮询只能读取订单状态，不能触发积分发放。

### 8.1 当前支付系统阻塞

服务器现有支付代码存在以下生产缺口：

- `payments.amount`、`pricing_plans.price`、续费金额使用 FLOAT；
- 回调已验签，但未看到对订单金额、应用身份和商户身份的显式二次核验；
- 当前 `status != PAID` 的幂等判断没有订单行锁；
- 支付状态变更与权益发放缺少唯一流水；
- 并发回调可能同时通过旧状态检查。

这些问题必须在积分上线前统一修复，不能只为积分新增旁路逻辑。

## 9. 模型请求扣费闭环

每一次上游模型调用独立处理：

```text
生成 request_id
→ 验证用户与模型权限
→ 读取并快照 price_version
→ 计算最大费用
→ wallet.available 转 reserved
→ 创建 model_requests
→ 调用 One API
→ SSE 透传
→ 获取权威 usage
→ 计算实际费用
→ reserved 扣除实际费用
→ 剩余预留退回 available
→ 写负数 credit_ledger
→ 标记 settled
```

数据库不可用时必须 fail closed：拒绝新模型请求，不调用 One API，不允许先生成后补扣。

### 9.1 流式 usage

Mona 当前已经发送 `stream_options={"include_usage": true}`，并归一化输入、输出和缓存 Token：

- [`openai_compat_provider.py`](../../mona/providers/openai_compat_provider.py)
- [`runner.py`](../../mona/agent/runner.py)

One API v0.6.10 二进制中也确认包含 `stream_options` 与 `include_usage` 支持，但仍需对 DeepSeek真实渠道逐项验证：

- 非流式对话；
- 流式对话；
- 工具调用；
- JSON输出；
- 缓存 usage；
- 客户端中断；
- 上游 401、402、429、5xx；
- 最新模型名称和模型映射。

无法稳定获得权威 usage 的模型不得按 Token售卖。

### 9.2 Agent、多智能体和后台任务

一个用户回合可能触发多个上游调用：

```text
turn_id
├── request_id 1
├── request_id 2
├── tool-loop request
├── retry request
├── subagent request
└── finalization request
```

- 每个上游请求独立预留和结算；
- UI按 `turn_id` 汇总展示；
- 子 Agent消费归属于发起用户；
- 工作流消费归属于启动用户；
- 定时任务启动前必须检查余额和任务预算；
- 房间协作需明确付费主体；
- 第一版不开放图片、视频等非 Token计费能力。

## 10. One API 使用边界

One API 只做路由，不做积分权威账本。

原因：

- 当前实例基本没有有效业务数据；
- 原生额度是倍率配额，不是人民币资金账本；
- 当前部署使用 SQLite；
- 官方仓库存在未关闭的并发额度竞态安全报告，本报告未在当前实例复现，但不应将其作为资金账本。

生产配置要求：

- 使用 MariaDB；
- 通过 systemd 启动并自动恢复；
- 只监听本机或私有网络；
- 管理后台仅通过 SSH 隧道/VPN/白名单访问；
- 只创建一个内部 Mona 服务 Token；
- 禁止公开注册 One API 用户；
- 关闭用户自助发 Token和充值能力；
- 渠道 Key只保存在 One API。

## 11. 经济可行性

DeepSeek 当前官方价格按百万 Token计费。以下只用于验证成本量级，售价仍需覆盖支付、服务器、税费、退款、风控、客服和利润。

假设一次上游请求：

```text
10,000 未缓存输入 Token
2,000 输出 Token
```

按报告编制日官方价格：

| 模型 | 输入成本 | 输出成本 | 单次总成本 |
|---|---:|---:|---:|
| DeepSeek Flash | ¥0.010 | ¥0.004 | ¥0.014 |
| DeepSeek Pro | ¥0.030 | ¥0.012 | ¥0.042 |

若一个 Agent 回合产生 10 次同规模调用：

| 模型 | 单回合模型成本 |
|---|---:|
| DeepSeek Flash | ¥0.140 |
| DeepSeek Pro | ¥0.420 |

结论：文本模型成本支持积分商业模式，但必须按真实 usage 计费，不能按“用户发一条消息”固定收费，也不能以 Coding Plan月费摊销成无限额度。

## 12. 容量与用户规模

### 12.1 先定义“用户数”

- 注册用户：只占数据库记录，不代表模型负载；
- 在线用户：打开客户端但未必调用模型；
- 峰值活跃用户：固定时间内持续发起 Agent 回合；
- 并发生成任务：真正决定网关和上游负载的指标；
- 上游请求数：一个 Agent 回合可能包含多次请求，是最终容量指标。

因此不能用“注册用户数”回答承载能力。

### 12.2 当前 VPS

当前 VPS 只有 463 MiB可用内存，且 One API没有运行。现阶段没有任何经过压测的并发承诺，当前状态不能作为公开收费容量依据。

建议：

1. 先将内存提升至 4 GiB，或迁移无关服务；
2. 启动 One API与完整模型代理；
3. 按 5、10、20 并发逐级压测；
4. 只有 20 并发测试通过后，才把 20 设为首发全局并发上限。

### 12.3 首发容量目标

定义以下容量推演假设：

```text
全局并发上限 C = 20
每用户并发上限 = 1
平均每次上游请求时长 = 20 秒
请求到达均匀
不包含图片和视频
```

吞吐公式：

```text
上游请求/分钟 = 并发数 × 60 ÷ 平均请求秒数
```

不同响应时长下：

| 平均上游请求时长 | 20 并发的理论吞吐 |
|---:|---:|
| 10 秒 | 120 请求/分钟 |
| 20 秒 | 60 请求/分钟 |
| 30 秒 | 40 请求/分钟 |
| 60 秒 | 20 请求/分钟 |

在 20 秒、60 个上游请求/分钟的假设下：

```text
Agent 回合/分钟 = 60 ÷ 每回合上游调用次数
峰值活跃用户 = Agent 回合/分钟 × 每用户平均回合间隔（分钟）
```

| 每个 Agent 回合的上游调用数 | 用户每 5 分钟 1 回合 | 用户每 2 分钟 1 回合 |
|---:|---:|---:|
| 1 | 300 个峰值活跃用户 | 120 个峰值活跃用户 |
| 5 | 60 个峰值活跃用户 | 24 个峰值活跃用户 |
| 10 | 30 个峰值活跃用户 | 12 个峰值活跃用户 |

对于包含工具调用和子 Agent的 Mona，首发规划应以每回合 5-10 次上游调用计算。因此，**20 并发的首发容量目标可对应 30-60 个低频峰值活跃用户，或 12-24 个高频峰值活跃用户**。

这不是压测结果，也不是对外 SLA。注册用户可以高于活跃用户，但在没有实际活跃率数据前不能给出可靠注册用户上限。

### 12.4 DeepSeek 上游容量

DeepSeek当前账号级并发限制显著高于首发 20 并发目标，因此首发阶段的主要容量风险是：

- VPS内存；
- Mona Auth长连接处理；
- One API与最新模型的兼容性；
- Agent单回合产生的请求倍数；
- MySQL资金事务正确性；
- 业务峰值和恶意请求。

## 13. 最小生产版本范围

### 必须做

- DeepSeek正式 API唯一托管渠道；
- 一次性积分充值；
- 余额、流水和订单状态；
- 文本模型；
- 每用户一个并发；
- 全局并发和排队；
- 服务端积分预留与结算；
- BYOK保留；
- 模型价格版本化；
- 每日支付、钱包、One API和上游账单对账；
- 全局停服、单模型停用和单渠道停用开关。

### 明确不做

- 百炼 Coding Plan用户流量；
- 未获授权的硅基流动渠道；
- 积分转让和提现；
- 积分过期；
- 订阅赠送积分池；
- 组织共享余额；
- 多实例和 Redis；
- 图片、视频和音频计费；
- 跨供应商静默换模型；
- “无限量”套餐。

这个范围已经构成功能、资金和运维闭环，不需要为了“以后可能需要”增加更多系统。

## 14. 生产前 P0 清单

### 14.1 服务器与安全

1. 轮换已暴露的 root 凭据；
2. 建立非 root deploy 用户和 SSH Key；
3. 收口公网 3306；
4. 核对远程数据库用户和依赖；
5. One API只监听内网；
6. 修复 Certbot自动续期；
7. 验证 MySQL备份覆盖；
8. 完成一次恢复演练；
9. 处理系统待重启与安全更新；
10. 将 Mona Auth纳入 Git和版本化部署。

### 14.2 支付与账本

1. `FLOAT` 金额迁移为 `DECIMAL` 或整数分；
2. 回调核对 app、seller、订单和金额；
3. 支付订单加行锁；
4. 支付入账加唯一流水；
5. 钱包扣费使用行锁和事务；
6. duplicate request_id只扣一次；
7. 退款产生独立负数流水；
8. 每日自动对账。

### 14.3 One API与模型

1. 备份 SQLite；
2. 使用 MariaDB重新初始化；
3. 禁止 Coding Plan付费流量；
4. 配置 DeepSeek正式 API；
5. 建立 systemd自启动；
6. 验证完整模型/usage测试矩阵；
7. 验证上游 401、402、429和5xx；
8. 验证客户端中断和超时恢复。

### 14.4 客户端

1. 账号令牌迁移至安全凭据存储；
2. 获取短期 model-access token；
3. 增加托管供应商；
4. 增加余额、充值和流水界面；
5. 处理 `402 insufficient_credits`；
6. 展示单回合积分消费；
7. 保留 BYOK。

## 15. 上线验收标准

必须全部通过：

- 同一支付回调重复 100 次只入账一次；
- 并发消费不产生负余额；
- 重复 `request_id` 不重复扣费；
- MySQL不可用时上游调用数为 0；
- One API失败时预留积分可释放；
- 服务在预留后、输出前、输出中、结算前崩溃均可恢复；
- 流式 usage 与 One API日志、上游账单一致；
- 每日钱包与 ledger对账零差异；
- 备份能够恢复到隔离环境；
- 5、10、20 并发阶梯压测通过；
- 20 并发持续测试期间无 OOM、无资金不变量破坏；
- 管理端、One API和MySQL无非必要公网暴露；
- 渠道商业授权和公众服务合规项完成。

## 16. 实施顺序

1. 服务器安全、备份、版本化部署；
2. One API生产化并切换 DeepSeek正式渠道；
3. 支付金额和回调幂等加固；
4. MySQL积分账本；
5. Mona Auth流式模型代理；
6. Agent、子 Agent、工作流和定时任务的计费归属；
7. Mona Desktop托管供应商与积分 UI；
8. 故障、并发和资金一致性测试；
9. 容量压测；
10. 受控付费上线；
11. 根据真实数据决定是否扩容、拆服务或增加 Redis。

## 17. 最终建议

建议按最小生产版本开发。它已经足以形成以下闭环：

```text
用户登录
→ 购买积分
→ 支付入账
→ 使用托管模型
→ 服务端预留与结算
→ 查看余额和流水
→ 渠道动态扩展
→ 每日资金与模型账单对账
```

上线策略应分为两级：

- **受控付费上线**：完成全部 P0、DeepSeek单渠道、白名单用户、20 并发目标通过压测；
- **公众开放上线**：在受控版本稳定运行并完成备案、标识、隐私、实名、退款、发票和税务确认后开放注册。

当前项目不需要再增加架构复杂度。真正决定上线的不是功能数量，而是资金一致性、安全和故障恢复是否通过验收。

## 18. 资料来源

### 官方资料

- 阿里云百炼 Coding Plan FAQ：<https://help.aliyun.com/zh/model-studio/coding-plan-faq>
- 阿里云百炼 Token Plan个人版：<https://help.aliyun.com/zh/model-studio/token-plan-personal-overview>
- DeepSeek开放平台服务协议：<https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html>
- DeepSeek限速与隔离：<https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit>
- DeepSeek模型与价格：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- 硅基流动平台使用协议：<https://api-docs.siliconflow.cn/docs/legals/terms-of-service>
- 生成式人工智能服务管理暂行办法：<https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm>
- 人工智能生成合成内容标识办法：<https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm>
- One API官方仓库：<https://github.com/songquanpeng/one-api>
- One API并发额度竞态报告：<https://github.com/songquanpeng/one-api/issues/2440>

### 本地代码证据

- [`src-tauri/src/license.rs`](../../src-tauri/src/license.rs)
- [`webui/src/components/SubscribeView.tsx`](../../webui/src/components/SubscribeView.tsx)
- [`webui/src/components/PaymentDialog.tsx`](../../webui/src/components/PaymentDialog.tsx)
- [`mona/providers/openai_compat_provider.py`](../../mona/providers/openai_compat_provider.py)
- [`mona/providers/base.py`](../../mona/providers/base.py)
- [`mona/agent/runner.py`](../../mona/agent/runner.py)
- [`mona/agent/loop.py`](../../mona/agent/loop.py)

## 19. 未验证项

- One API 启动后的实际内存和吞吐；
- DeepSeek真实 Key在 One API v0.6.10 下的完整兼容性；
- 阿里云备份客户端是否覆盖 MariaDB；
- 真实用户的平均 Agent调用次数和上下文长度；
- 中国大陆公众服务的具体备案、安全评估和经营资质要求；
- 硅基流动是否愿意授予当前主体公开商业转售授权；
- 支付宝商户当前签约产品对积分充值商品的具体支持范围。

以上未验证项不得在上线评审中被默认为已通过。
