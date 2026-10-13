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

本次申请的精确目标为 `mona_auth_pro_cloud_test_20261013_9cf250a1` 和 `/tmp/mona-pro-cloud-20261013-9cf250a1`。只有用户确认后才能创建、上传、执行和回收。生产库、线上进程、套餐和真实账户数据不属于演练范围。需要继续修复时保留该次失败证据，不用重建数据库掩盖失败。

## 七牛与到期规则的剩余缺口

当前下载接口签发短期 URL；客户端校验本次下载的内容大小和完整性。服务端尚无真实下载字节账本或账单接入，客户端也未持久记录失败传输字节。不能将 URL 签发次数或成功文件大小称为严格月下载配额。

七牛 CDN 日志包含响应字节和 URL，但约延迟 6 小时，需依据云空间路径归属核算重复请求和 Range，再与计费用量核对；延迟日志本身不能保证实时硬限额。参见七牛官方[CDN 日志说明](https://developer.qiniu.com/fusion/3847/cdn-log-fusion)。如果选用直接源站下载，需要另行确认其日志和账单来源，不能混用 CDN 与源站口径。

当前 Pro 到期后禁止新写入，保留最早有效设备的已有内容读取与显式管理；没有实现限时下载截止日。默认 30 天历史保留是版本清理策略，不能当成订阅到期后的下载期。上线前需明确到期下载期限及流量产品约定，并同步服务端行为和对外说明。

真实存储验收需要独立私有测试空间、HTTPS 上传和下载入口、限定凭据及小量存储/流量费用授权。用合成资料验证上传、stat、完整性、过期、暂停恢复、重复/Range 下载、对象回收和共享引用。公网域名、私有桶权限、证书及账单设置均按精确目标单独确认。

## 多机、安装包与受控上线

用户已确认拥有第二、第三台设备。待确定其系统并生成同份冻结桌面源码对应的安装包后，记录设备、版本与每项实际结果：恢复密钥、完整 Work 历史和按需附件、增量编辑、离线冲突、笔记与附件、个人日程/待办、四项偏好、回收站、切账户、撤销、免费/Pro 名额和第 4 个登录的拒绝或明确替换。同机模拟身份不能填作物理多机通过。

安装包验收须覆盖系统凭据库、原生桥接、Gateway/Services 路由和资源完整性。其他任务尚未提交的源码不混入本次发布输入；测试安装包也不能直接更新公开下载渠道。正式双端发版按 `mona-release` 技能执行。

生产顺序为：冻结 Auth 与桌面输入、确认备份和恢复方案、迁移与部署 Auth、核验设备/云就绪、物理多机和正式包验收、发布客户端。服务端发布需适配当前 PM2 启动方式。生产回退保留新增表、云数据、游标和请求身份，不执行本指南演练中的破坏性 downgrade。

本次结果与源码指纹保存在 `output/pro-cloud/local-continuation-20261013/`。交付时分别报告已编码、已提交、本地验证、真实环境验收和已上线状态。
