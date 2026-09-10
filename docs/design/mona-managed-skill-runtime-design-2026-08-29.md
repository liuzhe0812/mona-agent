# Mona 共享 Agent 运行环境设计

> 文档版本：2.0  
> 状态：已实现，待发布验证  
> 更新日期：2026-08-30

## 1. 产品结论

Mona 只维护两类代码环境：

1. 非项目 Agent、官方专家、用户 Skill 和 AI 生成的临时代码，共用一套 Agent Python 环境和一套 Agent Node.js 环境。
2. 用户明确进入项目后，使用项目自己的 `.venv` 和 `node_modules`。

Skill 默认是说明和资源包，不负责选择解释器。AI 只运行 `python`、`pip`、`node`、`npm` 等普通命令，Mona 根据会话类型注入正确环境。系统 Python 和 Node 不作为后备。

这套方案参考 Prime Agent 的共享 Kernel venv 思路，同时保留 Mona 面向普通用户所需的基础运行时按需下载、国内镜像和项目隔离能力。

## 2. 实际目录

```text
~/.mona/runtimes/
├── components/
│   ├── python-base/versions/3.13.15/
│   ├── node-base/versions/22.23.2/
│   └── python-academic/versions/1.0.0/
├── python/official-envs/
│   ├── current.json
│   └── <generation>/
│       └── Scripts/python.exe
└── agent-env/
    ├── state.json
    ├── bin/                  # python/pip/node/npm/npx 路由脚本
    └── node/
        ├── package.json
        ├── package-lock.json
        ├── loader.mjs
        └── node_modules/

<user-project>/
├── .venv/
└── node_modules/
```

Python 的 `official-envs/current.json` 指向当前共享 Agent Python 代。新增官方能力包时生成新代并切换；AI后续安装的普通包进入当前代。Node 的共享依赖进入 `agent-env/node/node_modules`。

旧版 `skill-envs/` 和旧运行时声明继续保留读取兼容，但新任务不再创建按 Skill 依赖哈希划分的环境。

## 3. 会话路由

### 3.1 普通 Agent 或专家会话

以下命令全部进入共享 Agent 环境：

```text
python / python3 / py
pip / pip3
pytest / ruff / jupyter 等 Python 工具
node / npm / npx
pnpm / yarn / vite / vitest 等 Node 工具
```

例如学者专家执行：

```text
pip install numpy pandas matplotlib
```

实际修改的是：

```text
~/.mona/runtimes/python/official-envs/<generation>/
```

不会进入系统 Python，也不会在默认工作区创建 `.venv`。

### 3.2 项目会话

当会话绑定到 Mona 默认工作区之外的用户项目时：

- Python 优先使用项目已有 `.venv` 或 `venv`；没有则由 Mona Python 创建 `.venv`。
- Node 使用 Mona Node.js，但依赖安装到项目 `node_modules`。
- 项目依赖不进入共享 Agent 环境。

## 4. Skill 规则

### 4.1 普通 Skill

只需要：

```text
skill-name/
└── SKILL.md
```

不需要声明 Python、Node 或自定义 Mona runtime 字段。

### 4.2 Python Skill

使用标准 `pyproject.toml`：

```toml
[project]
name = "example-skill"
version = "1.0.0"
dependencies = [
  "requests>=2",
  "pandas>=2",
]
```

Mona 在 Skill 安装、启用或首次执行时把依赖同步到共享 Agent Python 环境。Skill 中存在 `src/` 时，执行期间自动加入 `PYTHONPATH`。

### 4.3 Node Skill

使用标准 `package.json`：

```json
{
  "name": "example-skill",
  "private": true,
  "dependencies": {
    "zod": "^4.0.0"
  }
}
```

依赖安装到共享 Agent `node_modules`，Node ESM loader 负责让工作区脚本和 Skill 脚本找到这些包。

### 4.4 旧 Skill

旧版 `metadata.mona.runtime`、官方专家 `runtimePacks` 和已经安装的能力包继续支持：

- 不修改 Skill、记忆、会话和授权状态。
- 原依赖同步进共享 Agent 环境。
- 不要求用户重新安装或重新批准。

## 5. 官方专家安装

1. VPS提供专家目录和版本信息。
2. 专家包与运行组件从七牛等静态源下载。
3. Mona校验大小、SHA-256、专家 ID、版本和包结构。
4. 官方能力包先安装，并同步到共享 Agent 环境。
5. 全部成功后原子启用专家。

专家 Prompt、Skills 和记忆仍与运行环境分离。多个专家需要同一依赖时只使用共享环境中的一份。

## 6. 网络与安装

- Python 包按“用户配置源 → 华为云 PyPI → PyPI”尝试。
- Node 包按“用户配置源 → npmmirror → npm”尝试。
- Python、Node 基础运行时和官方能力包不经过业务 VPS 转发。
- 安装命令有超时、依赖检查和失败信息。
- 同一依赖组的宿主安装操作使用锁，避免同时写入。
- AI直接执行 `pip install` 或 `npm install` 时，命令仍被宿主路由到共享 Agent 环境。

## 7. 安全边界

- 用户 Skill 脚本安装后仍默认禁用，需要明确允许。
- `skill_script_run` 和非项目 `exec` 使用同一共享 Agent 环境。
- 非项目 Agent 命令显式指定系统 Python/Node 绝对路径时拒绝执行。
- Python设置 `PYTHONNOUSERSITE=1`，不读取用户全局 site-packages。
- 项目环境和 Agent 环境双向隔离。
- R不在第一版托管范围内，不能回退系统 R。

## 8. 设置页面

“Agent 运行环境”是全局设置，不在每个专家页面重复配置：

- Python 和 Node.js 是否已安装；
- 当前版本、下载大小和更新状态；
- 下载、取消、重试和修复入口。

Agent/Skill 页面只显示“共享环境就绪”或具体错误。

## 9. 覆盖升级

覆盖升级不会修改：

- `~/.mona/agents` 中的专家配置、记忆和用户 Skill；
- `~/.mona/packages` 中已下载的专家包；
- `~/.mona/runtimes` 中已下载的基础运行时和共享环境；
- 用户项目中的 `.venv` 与 `node_modules`。

旧的多 Skill 环境目录不会在升级时强制删除。确认新共享环境稳定后，可在后续版本提供缓存清理入口。

## 10. 验收标准

1. 学者专家执行 `pip install numpy pandas matplotlib` 时，解释器位于 `~/.mona/runtimes/python/official-envs/`。
2. 同一专家随后执行 Python 统计脚本，可以直接导入上述包。
3. 不同专家和用户 Skill 返回相同的 Agent Python 解释器路径。
4. 用户 Skill 没有 runtime 字段也能安装；有 `pyproject.toml` 时自动同步依赖。
5. 项目会话的 `pip install` 只修改项目 `.venv`。
6. 非项目会话不能通过绝对路径绕到系统 Python/Node。
7. 旧专家、旧 Skill、会话、记忆和脚本授权在覆盖升级后保持不变。
