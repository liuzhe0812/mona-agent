# 工作台独立计费服务

本目录是从现行生产 Auth 源码构建独立计费进程的增量。它复用同一 `CreditWallet` 和 `CreditLedger`，不替换原 Auth 进程、设备认证、应用模型价表或定时任务。

`hosted_work_billing_app.py` 只加载专用路由，监听 VPS 回环地址；服务密钥由服务器受限环境文件提供。预扣同时校验服务密钥与网站会话，并向原 Auth 的回环身份接口核实实时登录状态；结算只由受信服务按已绑定的计费 ID 完成。价格快照来自工作台配置，实际用量和扣款分别记录；重复请求不重复扣费，缺失用量或余额不足以补扣时保留待核对状态。

生产原 Auth 的 `alembic_version` 保持 `wallet_overdraft`。本服务使用独立的 `hosted_work_schema_version=hosted_billing_v1` 记录新增计费表；不要在生产盲目执行原 Auth 的 `alembic upgrade` 来重复创建该表。现有 `/credits/usage` 只统计原应用模型请求，工作台扣款体现在共用余额和现有账单流水中。

图片计费扩展复用同一计费表，但使用独立图片操作 ID 和管理员逐图价格快照。打包时必须将本目录的 `hosted_work_image_billing.py` 安装为 `app/hosted_work_image_billing.py`，并将仓库中的 `mona/hosted_work/image_pricing.py` 原样安装为 `app/hosted_work_image_pricing.py`；路由启动时即导入二者，缺失时不能启动服务。只有一张已校验并持久保存的图片及其 SHA256 回执才能结算；缺少回执时保留待核对，不伪造 Token 用量。

上线前必须核对源码基线、数据库版本、服务密钥、回退路径和真实用量回执；不能将接口健康检查或目录列表视为完成扣费验收。独立 SQLite 测试、隔离 MariaDB 并发验证和生产验收记录见对应生产部署文档。
