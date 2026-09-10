# VPS 与笔记本 Worker 任务队列架构

- 状态：Implemented
- 最后更新：2026-09-08
- 范围：Mona Auth VPS、运营方笔记本 `mona-worker` 与附件处理任务

## 1. 责任边界

Mona Auth 的 MariaDB 保存 Worker 任务、租约、附件元数据和处理结果，是任务状态的唯一事实源。笔记本只保存处理附件和派生文件，不连接钱包或账本数据库，也不向互联网开放模型容器端口。

笔记本的 `mona-worker-api` 通过 `https://mona-ai.cn` 主动轮询 VPS。VPS 不反向连接笔记本。模型容器只在 Compose 内部网络中由 `mona-worker-api` 调用。

## 2. 状态与租约

任务状态为 `queued`、`leased`、`running`、`completed`、`failed` 和 `cancelled`。领取操作生成租约令牌和到期时间；心跳续期。完成、失败和附件下载都必须携带当前租约令牌，过期或被取消的执行者不能覆盖结果。

同一用户以相同任务 ID、相同任务类型、优先级和附件引用重试创建任务时返回原任务。结果完成后不可被修改。

## 3. 接口契约

用户接口使用现有 Bearer JWT：

| 接口 | 用途 |
|---|---|
| `POST /worker/attachments` | 上传用户归属的私有附件，记录大小和 SHA-256 |
| `POST /worker/jobs` | 创建任务；只传附件 ID、处理选项、优先级和可选幂等任务 ID |
| `GET /worker/jobs/{id}` | 查询属于当前用户的任务状态和结果 |
| `POST /worker/jobs/{id}/cancel` | 取消未完成任务，并使现有租约失效 |

Worker 内部接口使用独立的 `X-Worker-Key`，不接受用户 JWT：

| 接口 | 用途 |
|---|---|
| `POST /internal/worker/jobs/claim?worker_id=...` | 领取一个可执行任务，返回租约 |
| `POST /internal/worker/jobs/heartbeat` | 更新进度并续租 |
| `POST /internal/worker/jobs/complete` | 回传不可变的处理结果 |
| `POST /internal/worker/jobs/fail` | 回传失败代码 |
| `GET /internal/worker/attachments/{id}?job_id=...` | 下载当前任务的附件；还需 `X-Worker-Lease-Token` |

任务负载递归拒绝本机路径字段，只能引用 VPS 附件 ID。附件下载按任务、用户和当前租约共同校验，VPS 不返回笔记本本地路径或公开附件 URL。

## 4. 已部署能力

VPS 已新增 MariaDB 迁移、私有附件存储、任务 API 和 HTTPS `/worker/`、`/internal/worker/` 路由。笔记本已部署 `mona-worker-api`，支持 `asr`、`ocr` 和 `structure_ocr` 三类单附件任务，并在模型推理期间持续心跳。

Worker 凭据只保存在两端受限配置中，不进入仓库、镜像、Compose 文件或日志。模型服务端口保持不对宿主机映射。

## 5. 验收记录

2026-09-08 已完成一笔隔离 OCR 任务：VPS 私有附件被笔记本领取，笔记本普通 OCR 返回 32 条文本行，结果通过租约回传 VPS，任务状态变为 `completed`。随后删除了该测试任务、附件和笔记本临时副本。

## 6. 当前限制

首版 Worker 每次处理一个附件。用户界面、任务配额、批量附件、结果文件下载和任务取消到模型进程的协同仍需在各自业务入口接入。PP-StructureV3 的公式识别因当前笔记本 CPU 兼容性问题保持关闭；版面与表格解析可用。
