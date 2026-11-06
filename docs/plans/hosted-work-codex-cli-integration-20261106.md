# 线上工作台 Codex CLI 接入评估

日期：2026-11-06。本文是接入评估，不代表 Codex 收费已开通；未调用付费模型、未读取或修改认证密钥。

## 结论

复用现有 Codex app-server 通信与 Mona 会话界面，在 Hosted provider 边界补租户工具适配，并由现有 Auth 钱包承担收费。不要把 Codex CLI 的宿主命令执行入口直接公开，也不要另建余额和充值体系。Qwen 继续面向已登录账号免费。

管理员配置入口：**https://mona-ai.cn/work/admin/**，原后台侧栏“工作台模型与计费”可进入。本轮已补齐免费 API 模型配置、原共用价格表的启用版本与输入/缓存输入/输出价格展示，以及原计价后台入口；保留 Codex 程序路径、认证方式、原生模型和计价映射草稿与连接检查。真实管理员保存/同步、普通账号拒绝及侧栏跳转已验收。连接草稿与公开模型列表分离，未计费 Codex 仍不能启动任务。

## 当前真实状态与代码缺口

| 部分 | 已有能力 | 仍缺什么 |
|---|---|---|
| 管理入口 | `admin.py` 的连接草稿、版本校验、专用 home、连接探测 | 安装/配置真实程序、确认实际认证和模型调用权限 |
| 原生通信 | 应用的 `CodexExecutor`、app-server 流、工具和用量事件解析 | 网页工具与原生权限策略的适配、版本锁定与真实隔离验收 |
| Hosted provider | `providers.py` 已能构造原生 provider | 现有原生策略假设桌面 `ExecTool.sandbox`，对 Hosted 包装工具会报属性错误；且会过滤网页文件/命令工具，不能仅解除 Codex 准入拦截 |
| 共用余额 | Auth 已有 `/credits/balance`、`/credits/usage`、充值订单及钱包 ledger | Hosted 可调用且受服务身份保护的预扣、确认派发、结算、待核对接口 |
| 定价 | Auth 现行价格有输入/缓存输入/输出和 version，金额为人民币百万分之一 | 选定真实模型、核对官方费率与换算口径、冻结价格快照 |
| 网站余额/充值 | 原 Auth 钱包与订单可复用 | 网站接入余额/用量/原充值订单流程；不能原样嵌入强依赖 Tauri 的桌面 CreditsView |

Ubuntu 默认 PATH、`/usr/bin`、`/usr/local/bin` 本轮未发现 Codex，专用目录的认证文件和模型缓存也未发现；未检查系统凭据库，不能据此断言任何个人账号的登录状态。这里需要使用平台专用目录，不读个人桌面配置。

生产 Auth 的钱包事务函数 `reserve_request`、`settle_request`、`mark_request_uncertain` 是内部 Python/数据库边界，不是已有 Hosted HTTP API。网页网页登录令牌被桌面 `/model-access/token` 路由明确拒绝；现有 `/v1/chat/completions` 绑定 One API。不得为接 CLI 绕过设备鉴权或让浏览器自报用户、金额、用量。

## 建议接线

```text
网页登录账号 → Hosted 身份与会话绑定 → Auth 共用钱包预扣
                              ↓
                 受限 Codex app-server provider
                              ↓
             Mona 已授权工具 → 账号 gVisor/原有编辑器
                              ↓
       持久化真实用量 → Auth 幂等结算/待核对 → 同一个余额
```

1. **运行边界。** CLI 程序来自统一运行时仓库并锁版本；stdio/app-server 只给可信后端使用。平台认证与各用户的线程、文件、rollout 分开；所有线程映射必须绑定 owner/session/run。禁用宿主原生 shell/文件/其他未授权工具，把可用的文件、命令和编辑请求送回 Mona 的 gVisor 与编辑器。保持现有 Runner、前端事件和 Skill，不另写会话 UI 或第二个任务循环。
2. **收费边界。** 由 Auth 新增服务间接口，内部复用当前服务器钱包和 ledger；按 owner/run/原生 turn/模型请求等可靠身份幂等。先预扣、确认是否实际派发，再按真实输入、缓存和输出结算；缺失、迟到、重复和未知结果不得当零或自动全退。原充值、订阅、支付和设备逻辑不改。
3. **完整用量。** 不能只拿主 Runner 的 `result.usage` 当总账单：上下文压缩、子任务和标题还有模型调用。CLI 一个 turn 也可能包含多次内部请求；需在 provider/真实上游调用边界统一计量，或明确哪些辅助调用由平台承担。当前原生适配接收的 `max_tokens` 未下传，不能据此声称最大费用已被强制限制。必须先验证可执行的费用上限/增量预扣与取消边界。
4. **认证选择。** 对平台程序化收费路线建议使用 API Key 的按量账单来源。现有 ChatGPT 登录草稿可保留，但订阅登录、模型列表和连接成功不能代替实际调用、计费或多人商业用途授权确认。任何凭据仅留在后端受限配置/凭据库，不进入网页或用户执行环境。
5. **上线条件。** 完成离线协议和权限测试后，再验真实 CLI 推理、工具隔离、两个账号数据隔离、余额不足、取消、异常中断、重复回执及实际账单一致性。上述通过前继续保持 Codex `public_enabled=false`，Qwen 不进入收费链。

## 官方依据

- 官方鉴权文档区分 ChatGPT 订阅与 API Key 按量认证，并推荐 API Key 用于程序化 Codex CLI 工作流；不能把两者的账单来源混为一谈。[OpenAI Authentication](https://learn.chatgpt.com/docs/auth)
- 官方 app-server 为自定义客户端提供结构化线程、流式事件、工具调用及 token usage 更新；部分动态工具字段是实验特性，需要与实际已安装 CLI 版本核对。[OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)
- SDK 可程序化控制 Codex，但现有项目已有原生通信层，不需要为接入额外引入一套自动下载运行时。统一运行时仓库规则继续适用。[OpenAI Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

本轮完成接入评估及模型与计费管理入口，没有启用收费、改钱包服务、安装 CLI 或要求用户在聊天提供密钥。可执行的下一阶段为 **Hosted Codex 工具适配 + Auth 计费桥**，不是仅登录后打开模型开关。
