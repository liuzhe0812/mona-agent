# Pro 设备与个人云工作空间验收

本指南承接 `docs/plans/2026-10-13-pro-cloud-handoff.md`。功能范围以 `docs/architecture/pro-cloud-services.md` 为准。下面的本地测试和只读环境核查不代表已发布。

## 源码归属

桌面源码仍在 Mona 主仓库。`mona-auth/` 已按用户确认建立独立本地 Git 仓库，保留服务、测试、部署模板和完整迁移链；主仓库继续忽略此目录。Auth 没有配置远端，重新克隆 Mona 主仓库仍不会获得 Auth 源码。需单独备份或克隆 Auth 仓库。

Auth 基线提交：`e2b82c1`。凭据、`keys/`、环境、数据库及运行产物均不入库。配置模板 `.env.example` 只作为字段模板；不得填入真实凭据后提交。

## 可重复的本地检查

在 Mona 根目录使用现有环境执行：

```powershell
.\mona-auth\.venv\Scripts\python.exe -B -X utf8 mona-auth/scripts/verify_pro_cloud.py --report output/pro-cloud/auth-verification.json
.\.venv\Scripts\python.exe -m pytest tests/cloud -q --disable-warnings
```

报告必须使用新文件名。Auth 入口在临时工作目录清除继承的 Auth 配置，使用临时 SQLite、随机密钥及合成账户，关闭连接后清理临时文件。测试使用真实 Auth 路由、协调器和加密逻辑，替代原生凭据库及对象存储。新增迁移检查执行四个真实 revision，并验证既有账户、订阅、旧设备和桌面设备会话保留。SQLite 回退只用于该临时数据库。

前端按交接文档第 6 节的测试文件清单运行，保留 `--maxWorkers 2 --minWorkers 1` 和 `.tmp-verify/**` 排除项。生产类型检查使用 `tsconfig.build.json`。原生测试在新复制的测试程序中加入 Windows Common Controls v6 清单，再运行 `license::`、`notes::`、`settings::`；不修改生产二进制或跳过断言。

## 2026-10-13 的只读环境核查

- VPS：`47.117.69.105`。Auth 由 PM2 管理，当前工作目录为 `/opt/mona-auth-releases/20260909T092437Z-payment-sync-return`，Python 环境为 `/opt/mona-auth/venv`。不按本地 `mona-auth.service` 模板猜测线上启动方式。
- 数据库：MariaDB `10.11.13`，正式库 `mona_auth`，当前 revision 为 `promotion_singleton`，未发现桌面设备会话或云同步表。默认事务隔离为 `REPEATABLE-READ`。
- 线上 Auth 源码没有新的设备/云协议。既有 49 个 Python 源码中 42 个与本地相同，既有 `app/models.py` 一致；另外 7 个变化涉及认证、配置、依赖、路由组装及 Alembic 环境。新增文件及这些差异需随服务端发布核对。
- 七牛已有发布配置对应 `mona-releases`，访问权限实测为公开，区域 `z0`。未找到 Mona 专用私有云空间。公开安装包空间不能改为私有或复用为个人云数据空间。

以上是当日快照。修改服务前重新核对进程、数据库 revision 和源码版本，不将本次结果长期视为当前状态。

## MariaDB 隔离演练

入口：`mona-auth/scripts/verify_pro_cloud_mariadb.py`。它只接受 `mona_auth_pro_cloud_test_DATE_ID` 格式的新空库和本地连接；从没有 `.env` 的临时目录运行，通过进程内的 `MONA_PRO_CLOUD_TEST_DATABASE_URL` 提供连接，不在命令参数或文件中保存凭据。

演练包含真实四步迁移、既有合成账户/订阅/设备保留、免费 1 台与 Pro 3 台并发登录、100 字节配额下的两次 64 字节并发预留、同版本竞争提交及同身份幂等提交。并发线程先执行认证阶段的读取，再竞争账户锁，覆盖 MariaDB 一致性快照与行锁的组合。七牛存储仍为隔离边界，不能将此结果算作真实七牛验收。

本次获用户明确授权的精确目标为 `mona_auth_pro_cloud_test_20261013_9cf250a1` 和 `/tmp/mona-pro-cloud-20261013-9cf250a1`。已完成演练并回收这两个目标。生产库、线上进程、套餐和真实账户数据不属于演练范围；失败记录保留在本地报告中，修复后才重置同一临时库复验。

### MariaDB 实测结果与修复

首轮发现 Alembic 配置不能直接接受连接 URL 中的 `%` 转义，修复为按 ConfigParser 要求转义后再传入配置，并增加实际执行迁移入口的回归测试。随后迁移升级/回退通过，但并发时免费账号放入 2 台、Pro 放入 4 台，配额两次预留都成功，条件版本与同身份重放发生唯一约束错误。这些失败不能由此前 SQLite 通过结果覆盖。

根因是认证前置读取在 `REPEATABLE READ` 下建立旧快照，等待账户行锁后普通查询仍读旧状态。Auth 的 MySQL/MariaDB 连接改为 `READ COMMITTED`，保留原账户行锁；没有修改数据库服务器的全局隔离级别。验收入口改为使用真实 Auth engine 配置，并复用既有余额与支付并发检查，覆盖共享连接策略的影响。

最终 13 项真实 MariaDB 检查通过：6 项迁移/同步检查，以及 7 项余额、全局容量、重复请求、支付回调、人工调整、遗留请求回收和账目核对。均使用合成账户与本地逻辑，没有请求真实模型、支付或七牛服务。本地 Auth 路由、协调器和 SQLite 迁移组合最终 85 项通过，相关 Ruff 检查通过。此次只修改 Auth Python 源码，不重复运行未变的前端或 Rust 测试。

Auth 修复提交为 `402d5a1245764eb47b136f3dad3a70c5ed0f5f4d`。实测的 68 个运行源码文件与该提交逐一按 LF 归一化核对一致。修复已入独立本地仓库，未部署到正式 Auth。

回收后核对：临时库和目录均不存在；线上进程 PID、发布目录及源码指纹保持一致；正式库仍为 `promotion_singleton`，未新增云表，原账户/订阅/设备行数保持一致，数据库全局隔离仍为 `REPEATABLE-READ`。证据为 `mariadb-initial-report.json`、`mariadb-migration-fixed-report.json`、`mariadb-final-report.json`、`mariadb-cleanup-report.json` 和 `auth-final-mariadb-fix-report.json`。

## 七牛与到期规则的剩余缺口

当前下载接口签发短期 URL；客户端校验本次下载的内容大小和完整性。服务端尚无真实下载字节账本或账单接入，客户端也未持久记录失败传输字节。不能将 URL 签发次数或成功文件大小称为严格月下载配额。

七牛 CDN 日志包含响应字节和 URL，但约延迟 6 小时，需依据云空间路径归属核算重复请求和 Range，再与计费用量核对；延迟日志本身不能保证实时硬限额。参见七牛官方[CDN 日志说明](https://developer.qiniu.com/fusion/3847/cdn-log-fusion)。如果选用直接源站下载，需要另行确认其日志和账单来源，不能混用 CDN 与源站口径。

用户已确认 Pro 到期后提供 30 天下载期。Auth 已按订阅周期结束时间实施下载截止校验，并将签名 URL 的有效期限制在该截止之前；续订恢复下载，不自动删除数据。历史/回收站的元数据和明确管理仍允许；超过下载期的回收站名称显示类型和“下载期已结束”，内容下载失败明确提示续订。服务端字段为 `MONA_AUTH_CLOUD_DOWNLOAD_GRACE_DAYS`，默认 30。该期限与默认 30 天历史保留分别处理。

用户已授权创建华东私有测试空间 `mona-pro-cloud-test-20261013-9cf250a1` 和累计不超过 10MB 的合成资料传输及清理。空间已创建并核实为私有。临时测试域名未通过证书校验后，按用户“不增加额外配置工作”的要求改用该空间自带的 HTTPS S3 入口；没有配置新域名、降低 TLS 校验或回退 HTTP。三台物理验收设备均已确认为 Windows。

### 真实七牛联调与对象清理

下载源为 `https://mona-pro-cloud-test-20261013-9cf250a1.s3.cn-east-1.qiniucs.com`，通过七牛兼容的 AWS Signature V2 签发 GET URL，保持原对象键及绝对过期时间。参考七牛官方[服务域名](https://developer.qiniu.com/kodo/4088/s3-access-domainname)和[签名认证](https://developer.qiniu.com/kodo/4093/s3-authentication)。上传、stat 和删除仍使用现有 Kodo 适配器。

`verify_pro_cloud_qiniu.py` 使用真实 Auth 路由、加密和七牛，认证目录在临时 SQLite 中用合成账户和设备构造。实测 9 项通过：上传/stat/配额结算与复用、同 URL 重复下载并解密、Range、中断后明确重试、过期授权拒绝、未签名拒绝、有效上传授权保护、保护窗口到期后的共享引用保护、真实删除确认后释放配额。使用真实时间等待授权与保护窗口到期；最后的引用退役属于临时数据库夹具准备，不冒称完整回收站 UI 操作或物理多机验收。

两轮传输的保守合成数据上限共 360,832 字节，低于授权的 10MB。已通过实际 stat 和完整对象列举核对测试对象为 0。七牛当日空间统计接口已返回上传 84,416 字节、下载 241,229 字节；这是空间用量，不是金额账单，也不能直接替代每账号月下载限额。中断下载客户端只读到 4,096 字节，服务端可能已发送更多，因此分别保留客户端记录与服务端用量。证据为 `qiniu-native-https-probe.json`、`qiniu-live-acceptance-report.json`、`qiniu-final-cleanup-report.json`、`qiniu-usage-metrics-final.json`。

新增源站签名相关 Auth 定点测试 30 项通过；下载期的 Auth 组合检查 87 项通过，最后按订阅周期结束时间收窄后的下载接口定点 13 项通过；桌面错误提示及回收站定点 27 项通过。数字分别对应报告，不累计成一次全量结果。

真实存储验收需要独立私有测试空间、HTTPS 上传和下载入口、限定凭据及小量存储/流量费用授权。用合成资料验证上传、stat、完整性、过期、暂停恢复、重复/Range 下载、对象回收和共享引用。公网域名、私有桶权限、证书及账单设置均按精确目标单独确认。

## 多机、安装包与受控上线

用户已确认拥有第二、第三台设备。待确定其系统并生成同份冻结桌面源码对应的安装包后，记录设备、版本与每项实际结果：恢复密钥、完整 Work 历史和按需附件、增量编辑、离线冲突、笔记与附件、个人日程/待办、四项偏好、回收站、切账户、撤销、免费/Pro 名额和第 4 个登录的拒绝或明确替换。同机模拟身份不能填作物理多机通过。

安装包验收须覆盖系统凭据库、原生桥接、Gateway/Services 路由和资源完整性。其他任务尚未提交的源码不混入本次发布输入；测试安装包也不能直接更新公开下载渠道。正式双端发版按 `mona-release` 技能执行。

已从桌面提交 `e25151e36408fcb8f85650e8a0b06d562a5951eb` 在独立工作树构建 Windows x64 NSIS 验收候选包，沿用仓库产品版本 1.7.1，不更新线上下载或清单。Gateway 重新打包，其 `--help`、`--version` 通过；正常前端预构建、主界面及 Office 构建通过；Office manifest/sidecar 校验与最终 Ed25519 验签通过。构建覆盖仅用于隔离 Vite 缓存和使用现有发布入口，逐文件指纹写入报告；Tauri 构建后的三个跟踪文件只有换行变化，按 LF 归一化与原 Git blob 逐一核对一致。

候选包位于 `output/pro-cloud/local-continuation-20261013/windows-candidate/Mona_1.7.1_x64-setup.exe`，200,269,641 字节，SHA-256 为 `d27e8625a477300da5a3ba742aec582b835b7454c76b06d449195394685acba8`，同名 `.exe.sig` 已验证。构建依赖仅在独立工作树补入项目要求的两个固定 SDK 版本，未修改主工作区依赖。此包未安装、未完成系统凭据库或三台物理设备验收，也不算公开正式发布；生产 Auth 仍为旧版本，当前候选包不能据此宣称线上云同步已可用。

生产顺序为：冻结 Auth 与桌面输入、确认备份和恢复方案、迁移与部署 Auth、核验设备/云就绪、物理多机和正式包验收、发布客户端。服务端发布需适配当前 PM2 启动方式。生产回退保留新增表、云数据、游标和请求身份，不执行本指南演练中的破坏性 downgrade。

本次结果与源码指纹保存在 `output/pro-cloud/local-continuation-20261013/`。交付时分别报告已编码、已提交、本地验证、真实环境验收和已上线状态。
