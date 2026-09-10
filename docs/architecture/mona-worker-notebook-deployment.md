# Mona Worker 笔记本部署架构记录

> 状态：基础环境、三个模型容器与 `mona-worker-api` 已部署并验收；VPS 任务队列已接通  
> 最后更新：2026-09-08  
> 范围：运营方内网计算节点上的 `mona-worker` Docker Compose 项目
>
> 本文是笔记本运行环境的项目记录；运行服务或模型版本变更时必须同步更新。

## 1. 节点职责

该节点只承担 ASR、OCR、附件处理和后续文档解析等计算与存储任务。用户、登录、支付、余额、模型账本、笔记正文、日程主数据和云端聊天历史仍由 VPS 持有。

节点不运行 Qdrant、MariaDB、Redis、消息中间件、One API 或公网入口。现有 OEClaw Qdrant 属于其他服务，不属于 Mona Worker，禁止复用、修改或删除。

## 2. 当前环境

| 项目 | 配置 |
|---|---|
| 主机角色 | 运营方内网 Mona Worker 节点 |
| 内网地址 | `172.31.3.176` |
| 操作系统 | Ubuntu 24.04 LTS |
| CPU | AMD Ryzen 7 4800H，8 核 16 线程 |
| 内存 | 32 GB |
| GPU | NVIDIA RTX 2060，6 GB 显存 |
| 主磁盘 | NVMe ext4，部署时约 283 GB 可用 |
| 已有运行环境 | Docker Snap、Python 3.12、Node.js 22、FFmpeg |
| Worker 系统用户 | `mona-worker`，UID 995，GID 984 |

GPU 在 2026-09-08 重启后恢复正常。该主机的 Snap Docker 使用 NVIDIA Runtime 时必须指定 `runtime: nvidia` 或 `--runtime=nvidia`；`--gpus all` 会失败。RTX 2060 使用 FP16 或 FP32，不使用 BF16。

## 3. 持久目录与 Snap Docker 挂载约束

```text
/opt/mona-worker/
  compose.yaml
  app/
  config/
  docker/
    bin/docker-compose
  state/
  logs/
  backups/
  ENVIRONMENT.md

/home/mona-worker/mona-worker/
  models/
    asr/
    ocr/
  data/
    uploads/
    outputs/
    temporary/
```

项目配置、备份和运维记录保留在 `/opt/mona-worker`。此主机的 Docker 来自 Snap，daemon 无法将 `/opt` 绑定到容器；模型和数据卷必须位于 `/home/mona-worker/mona-worker`，由 `mona-worker` 用户持有，权限为 `0750`。当前 ASR 服务使用 `/home/mona-worker/mona-worker/models/asr:/models`，OCR 服务使用 `/home/mona-worker/mona-worker/models/ocr:/models`；两者共享 `/home/mona-worker/mona-worker/data/temporary:/data/temporary`。

`models`、`data` 和 `state` 是迁移和备份所需的持久数据。`temporary` 与日志不作为恢复输入。模型不打入镜像，必须固定来源、revision、大小、SHA、入口和许可证。

## 4. Docker Compose

Snap Docker 自带的 `docker compose` 无法读取 `/opt/mona-worker`。项目使用经过 SHA-256 校验的独立 Compose 客户端：

```sh
DOCKER_HOST=unix:///var/run/docker.sock \
  /opt/mona-worker/docker/bin/docker-compose \
  -f /opt/mona-worker/compose.yaml config
```

Compose 项目名固定为 `mona-worker`。计划中的服务如下：

| 容器 | 资源 | 职责 | 状态 |
|---|---|---|---|
| `mona-worker-api` | CPU；当前单任务领取 | HTTPS 主动领取、租约心跳与内部模型调度 | 已部署 |
| `mona-asr` | GPU，并发 1 | SenseVoiceSmall、VAD、标点和匿名说话人聚类 | 已部署 |
| `mona-ocr` | CPU；当前进程串行，队列目标并发 2 | PP-OCRv5 普通图片与 PDF 页面识别 | 已部署 |
| `mona-structure-ocr` | CPU；当前单线程 | PP-StructureV3 表格和复杂版面识别 | 已部署；公式识别暂停 |

只有 `mona-worker-api` 可以绑定 `127.0.0.1`。其他容器不映射宿主机端口，只通过 Compose 网络访问。容器不得挂载 Docker Socket，均以非 root 用户运行。

## 5. 长期运行策略

为保证笔记本作为 Worker 长期在线，已配置：

```text
/etc/systemd/logind.conf.d/90-mona-worker.conf
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
IdleAction=ignore
```

以下 systemd 目标已 masked：

```text
sleep.target
suspend.target
hibernate.target
hybrid-sleep.target
```

恢复默认休眠策略时，先停止 Worker，再 unmask 上述目标并删除该 logind 配置文件，随后重启 `systemd-logind`。

## 6. 基础验证

```sh
nvidia-smi

docker run --rm --runtime=nvidia \
  nvidia/cuda:12.8.1-base-ubuntu24.04 \
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader

DOCKER_HOST=unix:///var/run/docker.sock \
  /opt/mona-worker/docker/bin/docker-compose \
  -f /opt/mona-worker/compose.yaml config --quiet
```

基础环境完成不等于 ASR 或 OCR 已可用。每个模型容器必须独立完成模型加载、真实样本、资源占用、取消、重启恢复和无残留进程验证后，才能接入 VPS 任务队列。

### 6.1 `mona-asr` 验收记录（2026-09-08）

| 项目 | 结果 |
|---|---|
| 容器 | `mona-asr` 运行中；以 `mona-worker` 用户、`nvidia` runtime 运行；没有宿主机端口 |
| 镜像 | `sha256:a79b61b5dfe9c587bb970c935866e919745a7cccd5d4472d90d516ab1dfaaa3b` |
| 包版本 | FunASR 1.4.14；torch 2.5.1+cu121；torchaudio 2.5.1+cu121 |
| 健康检查 | `/health` 返回 `{"ok":true}`；`/ready` 返回 `{"ready":true}` |
| GPU | RTX 2060 上已加载约 2197 MiB；33.6 秒英语样本的服务端推理约 0.6 秒 |
| 真实转写 | `quick_asr` 与 `meeting_diarize` 均返回 HTTP 200；会议模式的每个分段包含文本、起止时间和匿名 `speaker_1` 标签 |

首次模型加载会下载并初始化 SenseVoiceSmall、FSMN-VAD、CT-Punc 和 CAM++ 权重，调用方必须允许冷启动延迟。模型缓存位于 ASR 数据卷，不在镜像或仓库内。当前镜像只供内部 Compose 网络使用；在 API/队列容器部署并完成跨进程验证前，不接入 VPS 任务队列。

### 6.2 `mona-ocr` 验收记录（2026-09-08）

| 项目 | 结果 |
|---|---|
| 容器 | `mona-ocr` 运行中；以 `mona-worker` 用户运行；没有宿主机端口 |
| 镜像 | `sha256:8d4b2c3a9deff5acc15405a49e91353a447ad1ebf8f58d0bb84b26e64385ae3a` |
| 包版本 | PaddleOCR 3.7.0；PaddlePaddle 3.2.0；PaddleX 3.7.2 |
| 模型 | PP-OCRv5 mobile 检测与识别；CPU、4 线程、关闭 MKL-DNN |
| 健康检查 | `/health` 返回 `{"ok":true}`；`/ready` 返回 `{"ready":true}`；`paddle.utils.run_check()` 通过 |
| 真实识别 | 官方图片返回 HTTP 200、32 条非空文本行、逐行置信度与坐标，并识别出 `BOARDING PASS` |
| 模型缓存 | 首次请求后约 21 MiB，位于 OCR 数据卷 |
| 权重校验 | 检测 `inference.pdiparams`：`afa1820cb16c1fd0dad589d0f8b389139061c1ef6d68019685fd07be997dda5b`；识别 `inference.pdiparams`：`2460da90875937c94db97eba74ae3d9e5d4c4c57c42f1f41531c09a26bcc771a` |

权重来自 PaddleX 固定 `paddle3.0.0` 路径下的 `PP-OCRv5_mobile_det_infer.tar` 与 `PP-OCRv5_mobile_rec_infer.tar`；更新前必须重新验收并更新上述校验值。OCR 仅处理普通图片及已渲染的 PDF 页面。PP-StructureV3 的表格和复杂版面能力必须使用独立容器、独立资源限制和真实表格/多栏文档验收，不能由本记录替代。

### 6.3 `mona-structure-ocr` 验收记录（2026-09-08）

| 项目 | 结果 |
|---|---|
| 容器 | `mona-structure-ocr` 运行中；以 `mona-worker` 用户运行；没有宿主机端口 |
| 镜像 | `sha256:e27ad2edaa2c56437b7928379c870d3d1dfecafe0b01bca014d6a22fead3c16d` |
| 包版本 | PaddleOCR 3.7.0；PaddlePaddle 3.2.0；PaddleX 3.7.2 |
| 启用能力 | 版面区域检测、复杂阅读顺序与表格结构；CPU 单线程、MKL-DNN 已启用 |
| 健康检查 | `/health` 返回 `{"ok":true}`；`/ready` 返回 `{"ready":true}`；`paddle.utils.run_check()` 通过 |
| 真实解析 | 官方复杂版面图片返回 HTTP 200，`parsing_res_list` 有 31 个块，覆盖文档标题、段落标题、正文、图片和图题；官方表格图片返回 HTTP 200，并识别为 `table` 块 |
| 模型缓存 | 首次请求后约 1.7 GiB，位于结构化 OCR 数据卷 |
| 权重校验 | 42 个模型文件的 SHA-256 清单为 `928b1bd52aee7199096f97d86339f11bfa11b2ede6fd9541eb2d275b275f275b`；清单保存在节点 `/opt/mona-worker/state/mona-structure-ocr-models.sha256` |

公式识别在本节点的 Paddle CPU 原生路径中触发过段错误，当前明确关闭。表格与版面解析已通过验收；公式能力需要在隔离的兼容性修复后再启用并重新验收。

### 6.4 `mona-worker-api` 与 VPS 队列验收记录（2026-09-08）

`mona-worker-api` 仅通过 HTTPS 主动连接 VPS；没有宿主机端口。它使用独立 Worker 凭据领取任务、在模型推理期间续租、按任务租约下载私有附件，并将结果回传 VPS。

一笔隔离 OCR 任务已经完成端到端验证：VPS 私有附件被笔记本领取，普通 OCR 结果含 32 条文本行并以 `completed` 状态回传。该测试任务、附件和笔记本临时副本已删除。任务接口与安全边界见 [`worker-queue-integration.md`](worker-queue-integration.md)。

## 7. 安全与运维边界

- SSH 凭据只保存在安全凭据通道或 SSH Key 中，不写入本文档、命令历史、Compose 文件或镜像。
- 不执行 Docker 全局清理命令，不迁移 Snap Docker daemon，不影响现有 OEClaw、Qdrant、Nginx 或 ToDesk。
- Worker 不直接连接或修改 VPS 的账本数据库；后续通过受保护的任务接口领取和回报工作。
- 新服务不得对局域网或公网暴露端口。
- 迁移前停止 Compose，备份 `compose.yaml`、`config`、`models`、`data`、`state` 和镜像 digest 记录；新机器还需具备兼容的 NVIDIA 驱动和 Container Runtime。















