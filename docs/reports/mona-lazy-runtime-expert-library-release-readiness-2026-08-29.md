# Mona 懒加载运行时与专家库发布就绪报告

> 日期：2026-08-29  
> 当前结论：运行时已在 2026-08-30 收敛为共享 Agent Python/Node 环境；生产发布仍受干净机验收阻塞。

## 需求核对

| 需求 | 当前证据 | 状态 |
|---|---|---|
| 基础安装包不包含 Python/Node | 运行时源位于被忽略的 `runtime-library/components/`，不进入 PyInstaller | 已实现，待 NSIS 重建测量 |
| 全新安装默认用户可见 Agent 只有 Mona | 科研/小红书/股神源已迁至 `expert-library/`；股票自动工作流角色全部为内部可见性；用户本地自定义专家继续加载 | 已验证 |
| 专家按需召唤 | VPS 官方目录、七牛 ZIP、后台 job、断点续传、安全 ZIP、SHA-256、原子激活与回滚 | 已验证，本地/MockTransport；待部署 VPS 路由 |
| Python/Node 按需安装 | 设置页组件、运行时目录、后台 job、组件版本仓和健康检查 | 已验证 |
| 所有非项目 Agent 代码使用固定解释器 | `exec` 与 `skill_script_run` 共同路由到共享 Agent Python/Node；项目会话单独路由 | 已验证 |
| 官方科研基础依赖可离线准备 | 33 个 Windows wheels，`--no-index --require-hashes` 安装；AI新增包进入同一共享环境 | 已验证 |
| 旧用户数据不丢失 | 专家包仓与 `agents/<id>/memory|skills|config` 分离；重装提示不删除用户目录 | 已验证 |
| 中国大陆网络友好 | 目录访问 Mona VPS；大文件访问七牛；Python 构建输入华为云优先，Node npmmirror 优先 | 已验证构建侧下载 |
| 基础运行时容量受控 | 专家、运行时组件、Python venv 代际保留当前与最近版本；共享环境扩展包清理入口待后续补充 | 部分完成 |

## 真实制品

| 制品 | SHA/版本 | 压缩大小 | 本地 smoke |
|---|---|---:|---|
| Python 构建输入 | `3.13.15`, SHA-256 `647922…c7a5` | 32.73 MiB | 哈希一致 |
| Node 构建输入 | `22.23.2`, SHA-256 `1177b4…9f97` | 34.03 MiB | 哈希一致 |
| `python-base@3.13.15` | 运行时 ZIP | 17.21 MiB | `venv` 成功 |
| `node-base@22.23.2` | 运行时 ZIP | 35.49 MiB | `v22.23.2` |
| `python-academic@1.0.0` | 33 wheels 哈希锁 | 112.26 MiB | numpy/pandas/matplotlib/PDF 导入成功 |
| 科研专家 `2.1.0` | 确定性 Agent ZIP | 约 1.0 MiB | 哈希校验、安装和注册表加载成功 |
| 小红书专家 `1.4.0` | 确定性 Agent ZIP | 约 5.1 MiB | 哈希校验、安装和注册表加载成功 |

## 验证结果

- 本功能 Python 专项：`128 passed`。
- WebUI 全套：`147 files passed`，`1501 passed`，`14 skipped`。
- 其中 11 个 skip 是旧版可折叠侧栏单体契约，当前行为由 AppRail、ChatList、SessionListPanel 和 sidebar-state 聚焦测试覆盖。
- TypeScript：`tsc --noEmit` 通过。
- WebUI 生产构建：Vite build 通过。
- Ruff：本次 Python 变更全部通过。
- 完整 Python 首错模式推进到 `429 passed` 后，仍有既有 `/goal` 文件编辑完成事件断言失败；不属于懒加载链路，但正式全库门禁仍为红色。

### 测试隔离修复

完整 Python 门禁发现旧夹具仍把 `MemoryStore(tmp_path)` 误认为会把 Agent 私有数据
写进 `tmp_path`。现已增加全局 autouse 隔离，所有测试的 Agent memory/skills 都被
重定向到每个测试自己的临时目录。修复前产生了 6 条高度疑似测试历史记录
（cursor 21–40）；未获用户授权前不自动删除任何真实记忆文件。

## 生产阻塞项

1. 当前环境没有 `QINIU_AK`、`QINIU_SK`、`QINIU_BUCKET`。
2. 尚未执行七牛 ZIP 真实上传、VPS catalog 发布和大陆多网络 smoke。
3. 尚未在无系统 Python/Node 的干净 Windows 用户机执行升级、安装、离线和回滚矩阵。
4. 完整 Python 套件仍存在本功能之外的现存失败，需要在最终版本分支清零或正式豁免。

上述任一项未完成前，不应把版本标记为正式上线完成。
