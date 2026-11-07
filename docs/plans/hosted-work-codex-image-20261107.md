# 线上工作台 Codex 生图验收（2026-11-07）

## 交付

复用桌面 `image-generation` Skill、`generate_image` 和 Codex 图片供应商；Hosted 负责按账号隔离临时文件和工作区、服务端受限认证、逐图价格、持久回执与对话展示。管理员只需在 Codex CLI 区域启用并设置每张价格，明确的 0 表示免费；当前设置为 ¥0.10／张。Codex 图片请求只读工作台专用登录文件，不复制或独立刷新凭据。当前供应商仅支持 1K 方图，参考图请求在扣费前拒绝。

每张图片使用 owner/run/operation 绑定的身份和不可变价格；服务端预留同额余额，确认供应商完成后先校验并持久保存图片、摘要和隐藏历史，再幂等结算。只有已结算或明确免费结果能读取及展示；断线、进程异常或账务不确定时保留待核对，不自动重派。上游尚未开始且有明确证据时释放预留。用户工作区和图片预览按账号隔离；平台 Codex 原生会话目录仍共用，不能据此宣称全链路隔离。

## 生产与验证

- Ubuntu 后端 v40：`/home/liuzhe/mona-hosted-work/releases/20261107-codex-image-v40/content`，清单 SHA `258ba0dc79c08618654278cfd9a624fb16785e7b3d337091c52da4d9e83e0095`；备份 `/home/liuzhe/mona-hosted-work/backups/20261107-codex-image-v40`。
- VPS 页面 v39：`/var/www/mona/work-releases/20261107-codex-image-ui-v39/content`，清单 SHA `3402e6345d0608f1a66056e9850c6274c19a3abe5a3bde555dbb54c379706738`；备份 `/var/www/mona/backups/codex-image-20261107-v39`。
- 独立计费侧车 v2：`/opt/mona-auth-releases/20261107-hosted-image-billing-v2/content`，清单 SHA `60acb91f0440b187659c9385a1a75e4449ddbc9ab41906d0eb10ebfa52527a53`；备份 `/opt/mona-auth/backups/hosted-image-billing-20261107-v2`。未更改原 Auth 进程、数据库结构、支付或桌面设备逻辑。
- Ubuntu 专用 Codex 账号真实生成一张 PNG，1,119,811 字节、SHA256 `8f1cc632c31c6ce61d1125a1327c41b6675a80933cc645ae3d6b7178134c77ac`；这是仅上游探测，未扣 Mona 钱包。网页登录设置、管理员权限和价格保存状态已只读核验。
- 定向本地联调使用模拟图片上游和测试钱包，验证逐图预留/结算、会话内显示、跨账号拒绝、重复请求、未知结果及恢复；Ubuntu 候选代码和 VPS 隔离 SQLite 计费验证通过。生产 `liuzhe` 可用余额在检查时低于 ¥0.10，故**真实网页逐图扣费及图片展示尚未验收**。
- Docker、原暂停 Worker、原 Work 隧道及其他业务进程未重启；切换时原会话/任务/文件记录保留。首次 Ubuntu 候选测试因测试假设可选桌面 OAuth 库存在而失败，已改为禁止访问桩并复测通过；这不是生产模型错误。

## 外部边界

当前 Codex 生图复用桌面已有非公开上游接口。[OpenAI app-server 文档](https://learn.chatgpt.com/docs/app-server#auth-endpoints)限制其内置认证的托管使用，[ChatGPT 登录预览文档](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)也不支持生图；真实请求成功不代表此托管线路获得官方授权。
