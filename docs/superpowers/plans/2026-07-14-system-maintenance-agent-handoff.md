# 系统维护失败交给 Mona Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 保留系统管家的既有规划功能，并在固定维护操作失败时，把任务交给右侧区域中的真实 Mona Agent 执行和复核。

**Architecture:** SystemView 持有一条待交接任务并传给现有右侧 SystemAssistant。右栏默认保留规划器；收到任务时切换到内嵌 Agent 对话。对话复用已有 WebSocket、消息流、历史记录和渲染组件，只在首次交接时创建临时会话。

**Tech Stack:** React 18、TypeScript、Vitest、React Testing Library、现有 MonaClient、useMonaStream、useSessionHistory 和 Tauri IPC。

---

### Task 1: 定义并测试交接任务

**Files:**

- Create: webui/src/components/system/systemAgentHandoff.ts
- Create: webui/src/components/system/systemAgentHandoff.test.ts

- [ ] **Step 1: 写入失败测试**

~~~~ts
import { describe, expect, it } from "vitest";

import { buildSystemAgentHandoffPrompt } from "./systemAgentHandoff";

describe("buildSystemAgentHandoffPrompt", () => {
  it("保留失败操作的目标、参数和错误原文", () => {
    const prompt = buildSystemAgentHandoffPrompt({
      id: "uninstall-notepad",
      title: "卸载 Notepad++",
      action: "卸载软件",
      target: "Notepad++",
      arguments: { id: null, name: "Notepad++", installLocation: "C:\\\\Program Files\\\\Notepad++" },
      error: "WinGet exit code 1603",
    });

    expect(prompt).toContain("请直接接管并完成任务，而不是只说明步骤");
    expect(prompt).toContain("操作：卸载软件");
    expect(prompt).toContain("目标：Notepad++");
    expect(prompt).toContain('"installLocation":"C:\\\\Program Files\\\\Notepad++"');
    expect(prompt).toContain("错误：WinGet exit code 1603");
  });
});
~~~~

- [ ] **Step 2: 运行测试，确认模块尚不存在**

Run: npm run test -- src/components/system/systemAgentHandoff.test.ts

Expected: FAIL，报错找不到 ./systemAgentHandoff。

- [ ] **Step 3: 添加最小实现**

~~~~ts
export interface SystemAgentHandoffTask {
  id: string;
  title: string;
  action: string;
  target: string;
  arguments: Record<string, unknown>;
  error: string;
}

export function buildSystemAgentHandoffPrompt(task: SystemAgentHandoffTask): string {
  return [
    "系统维护固定操作失败。请直接接管并完成任务，而不是只说明步骤。",
    "操作：" + task.action,
    "目标：" + task.target,
    "参数：" + JSON.stringify(task.arguments),
    "错误：" + task.error,
    "完成后复核实际状态，并如实报告执行结果。",
  ].join("\\n");
}
~~~~

- [ ] **Step 4: 运行测试，确认通过**

Run: npm run test -- src/components/system/systemAgentHandoff.test.ts

Expected: PASS，1 个测试通过。

- [ ] **Step 5: 提交**

~~~~bash
git add webui/src/components/system/systemAgentHandoff.ts webui/src/components/system/systemAgentHandoff.test.ts
git commit -m "feat: define system agent handoff task"
~~~~

### Task 2: 在右栏实现真实的 Agent 对话

**Files:**

- Create: webui/src/components/system/SystemAgentChat.tsx
- Create: webui/src/components/system/SystemAgentChat.test.tsx

- [ ] **Step 1: 写入失败测试**

~~~~tsx
import { useState } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SystemAgentChat } from "./SystemAgentChat";

const send = vi.fn();
const newChat = vi.fn(() => Promise.resolve("system-agent-chat"));

vi.mock("@/providers/ClientProvider", () => ({
  useClientOptional: () => ({ client: { newChat }, token: "test" }),
}));
vi.mock("@/hooks/useSessions", () => ({
  useSessionHistory: () => ({ messages: [], loading: false, error: null, hasPendingToolCalls: false, version: 0 }),
}));
vi.mock("@/hooks/useMonaStream", () => ({
  useMonaStream: () => ({ messages: [], isStreaming: false, send, stop: vi.fn(), setMessages: vi.fn(), streamError: null, dismissStreamError: vi.fn() }),
}));

describe("SystemAgentChat", () => {
  it("创建临时会话并发送交接任务", async () => {
    const onChatCreated = vi.fn();
    const onTaskHandled = vi.fn();
    function Harness() {
      const [chatId, setChatId] = useState<string | null>(null);
      return (
        <SystemAgentChat
          chatId={chatId}
          task={{ id: "startup-wechat", title: "禁用 WeChat 启动项", action: "禁用启动项", target: "WeChat", arguments: { id: "wechat", enabled: false }, error: "access denied" }}
          onChatCreated={(id) => { setChatId(id); onChatCreated(id); }}
          onTaskHandled={onTaskHandled}
        />
      );
    }
    render(
      <Harness />,
    );

    await waitFor(() => expect(newChat).toHaveBeenCalledWith(5_000, true));
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.stringContaining("错误：access denied"), undefined, { displayContent: "禁用 WeChat 启动项" }));
    expect(onChatCreated).toHaveBeenCalledWith("system-agent-chat");
    expect(onTaskHandled).toHaveBeenCalledWith("startup-wechat");
  });
});
~~~~

- [ ] **Step 2: 运行测试，确认组件尚不存在**

Run: npm run test -- src/components/system/SystemAgentChat.test.tsx

Expected: FAIL，报错找不到 ./SystemAgentChat。

- [ ] **Step 3: 复制现有聊天链路的最小部分**

组件属性固定为：

~~~~ts
interface SystemAgentChatProps {
  chatId: string | null;
  task: SystemAgentHandoffTask | null;
  onChatCreated: (chatId: string) => void;
  onTaskHandled: (taskId: string) => void;
}
~~~~

复用 webui/src/components/ppt/PptChatPanel.tsx 中的 useClientOptional、useSessionHistory、useMonaStream 和 ThreadMessages。当 task 存在但 chatId 为空时执行：

~~~~ts
const nextChatId = await client.newChat(5_000, true);
onChatCreated(nextChatId);
~~~~

会话创建完成后只发送一次：

~~~~ts
send(buildSystemAgentHandoffPrompt(task), undefined, { displayContent: task.title });
onTaskHandled(task.id);
~~~~

渲染 ThreadMessages、历史/流错误、文本输入以及停止/发送按钮。不得新增 HTTP 接口、执行器或备用系统命令。

- [ ] **Step 4: 运行测试，确认通过**

Run: npm run test -- src/components/system/SystemAgentChat.test.tsx

Expected: PASS，且没有未处理的 Promise 警告。

- [ ] **Step 5: 提交**

~~~~bash
git add webui/src/components/system/SystemAgentChat.tsx webui/src/components/system/SystemAgentChat.test.tsx
git commit -m "feat: add system maintenance agent chat"
~~~~

### Task 3: 保留规划器并在同一右栏切换到 Agent

**Files:**

- Modify: webui/src/components/system/SystemAssistant.tsx
- Modify: webui/src/components/system/SystemView.tsx
- Modify: webui/src/components/system/SystemView.test.tsx

- [ ] **Step 1: 写入失败的模式切换测试**

在 SystemView.test.tsx mock SystemAgentChat，使它显示传入任务的错误文本：

~~~~tsx
vi.mock("./SystemAgentChat", () => ({
  SystemAgentChat: ({ task }: { task: { error: string } | null }) => <div>{task?.error}</div>,
}));
~~~~

补充测试：从软件面板触发失败交接后，右栏显示错误文本和“返回系统方案”；点击返回后，现有“告诉 Mona 你想改善什么？”规划器内容仍可见。

- [ ] **Step 2: 运行测试，确认失败**

Run: npm run test -- src/components/system/SystemView.test.tsx

Expected: FAIL，当前右栏不会接收或显示交接任务。

- [ ] **Step 3: 添加单条待交接任务和右栏模式**

在 SystemView.tsx 添加：

~~~~ts
const [handoffTask, setHandoffTask] = useState<SystemAgentHandoffTask | null>(null);
~~~~

把 setHandoffTask 传给所有可执行的维护面板，并把 handoffTask 与消费回调传给 SystemAssistant。

在 SystemAssistant.tsx 保留现有 idle、diagnosing、plan、running、done 规划状态，新增：

~~~~ts
const [viewMode, setViewMode] = useState<"planner" | "agent">("planner");
const [agentChatId, setAgentChatId] = useState<string | null>(null);

useEffect(() => {
  if (!handoffTask) return;
  setDrawerOpen(true);
  setViewMode("agent");
}, [handoffTask]);
~~~~

只在 viewMode 为 agent 时渲染 SystemAgentChat。此模式提供“返回系统方案”，该按钮只执行 setViewMode("planner")，不能清空规划状态或 agentChatId。顶部“Mona 协助”仍进入规划器并调用原来的 startGoal。

- [ ] **Step 4: 运行测试，确认通过**

Run: npm run test -- src/components/system/SystemView.test.tsx

Expected: PASS，已有规划和执行测试继续通过，新测试确认交接不离开右栏。

- [ ] **Step 5: 提交**

~~~~bash
git add webui/src/components/system/SystemAssistant.tsx webui/src/components/system/SystemView.tsx webui/src/components/system/SystemView.test.tsx
git commit -m "feat: hand off failed system tasks in place"
~~~~

### Task 4: 交接存储扫描和清理失败

**Files:**

- Modify: webui/src/components/system/StoragePanel.tsx
- Modify: webui/src/components/system/SystemView.tsx
- Modify: webui/src/components/system/SystemView.test.tsx

- [ ] **Step 1: 写入两个失败测试**

让 scan_storage reject “scan denied”，断言扫描错误区域有“交给 Mona”。让 clean_storage 返回：

~~~~ts
{ freedGb: 0, cleanedIds: [], failures: ["file locked"] }
~~~~

断言清理失败区域也有“交给 Mona”。

- [ ] **Step 2: 运行测试，确认失败**

Run: npm run test -- src/components/system/SystemView.test.tsx

Expected: FAIL，现有存储错误只显示重试或状态文本。

- [ ] **Step 3: 添加最小交接数据**

给 StoragePanel 增加 onHandoff: (task: SystemAgentHandoffTask) => void。

扫描失败任务为：

~~~~ts
{
  id: crypto.randomUUID(),
  title: "扫描存储空间",
  action: "扫描存储空间",
  target: "本机磁盘",
  arguments: {},
  error,
}
~~~~

清理结果含 failures 时，保留原状态提示并提供交接按钮；目标为选中项目名称，参数为 { ids: selectedItems.map((item) => item.id) }，错误为 result.failures.join("；")。不得改变扫描或清理 IPC 调用。

- [ ] **Step 4: 运行测试，确认通过**

Run: npm run test -- src/components/system/SystemView.test.tsx

Expected: PASS，扫描和清理失败均可交接。

- [ ] **Step 5: 提交**

~~~~bash
git add webui/src/components/system/StoragePanel.tsx webui/src/components/system/SystemView.tsx webui/src/components/system/SystemView.test.tsx
git commit -m "feat: hand off failed storage operations"
~~~~

### Task 5: 交接软件更新和卸载失败

**Files:**

- Modify: webui/src/components/system/SoftwarePanel.tsx
- Modify: webui/src/components/system/SystemView.tsx
- Modify: webui/src/components/system/SystemView.test.tsx

- [ ] **Step 1: 写入失败测试**

将卸载 mock 改为：

~~~~ts
{ success: false, message: "WinGet exit code 1603", exitCode: 1603, residuals: [] }
~~~~

确认卸载后断言错误提示有“交给 Mona”。同时断言现有 Broken Tool 失败记录也有交接按钮。

- [ ] **Step 2: 运行测试，确认失败**

Run: npm run test -- src/components/system/SystemView.test.tsx

Expected: FAIL，软件失败只显示详情或重试。

- [ ] **Step 3: 添加软件交接**

给 SoftwarePanel 增加同一 onHandoff 属性。失败记录的任务使用 failure.action、failure.name、{ packageId: failure.packageId } 与 failure.message。卸载失败使用所选软件名及原始 Tauri 参数：

~~~~ts
{ id: null, name: selectedInstalled.name, installLocation: selectedInstalled.installLocation || null }
~~~~

不得重试、转换或修改 WinGet 参数。

- [ ] **Step 4: 运行测试，确认通过**

Run: npm run test -- src/components/system/SystemView.test.tsx

Expected: PASS，右栏任务含真实卸载目标和 WinGet 错误。

- [ ] **Step 5: 提交**

~~~~bash
git add webui/src/components/system/SoftwarePanel.tsx webui/src/components/system/SystemView.tsx webui/src/components/system/SystemView.test.tsx
git commit -m "feat: hand off failed software operations"
~~~~

### Task 6: 交接启动项切换和恢复失败

**Files:**

- Modify: webui/src/components/system/useSystemData.ts
- Modify: webui/src/components/system/StartupPanel.tsx
- Modify: webui/src/components/system/MaintenancePanel.tsx
- Modify: webui/src/components/system/SystemView.tsx
- Modify: webui/src/components/system/SystemView.test.tsx

- [ ] **Step 1: 写入失败测试**

让 system_toggle_startup_item reject “access denied”。点击 WeChat 开关后，断言错误区域显示 WeChat 和“交给 Mona”。对维护记录中的恢复操作增加同样断言。

- [ ] **Step 2: 运行测试，确认失败**

Run: npm run test -- src/components/system/SystemView.test.tsx

Expected: FAIL，Hook 目前只留下原始错误文本，调用者不知道失败目标。

- [ ] **Step 3: 保留失败目标并交接**

让 useStartupItems().toggle 与 useMaintenanceHistory().restore 返回 Promise<string | null>：成功刷新后返回 null；原有 catch 中提取错误、保留当前 error state，并返回该错误，不再额外 throw。

StartupPanel 对失败项构造：

~~~~ts
{
  id: crypto.randomUUID(),
  title: (item.enabled ? "禁用" : "启用") + item.name + " 启动项",
  action: item.enabled ? "禁用启动项" : "启用启动项",
  target: item.name,
  arguments: { id: item.id, enabled: !item.enabled },
  error: failure,
}
~~~~

MaintenancePanel 从 event.title、event.relatedId、event.restoreEnabled 和返回错误构造恢复任务。两者通过 SystemView 的回调发送。不得更改启动项 IPC 参数。

- [ ] **Step 4: 运行测试，确认通过**

Run: npm run test -- src/components/system/SystemView.test.tsx

Expected: PASS，WeChat 和恢复操作均带真实参数交接。

- [ ] **Step 5: 提交**

~~~~bash
git add webui/src/components/system/useSystemData.ts webui/src/components/system/StartupPanel.tsx webui/src/components/system/MaintenancePanel.tsx webui/src/components/system/SystemView.tsx webui/src/components/system/SystemView.test.tsx
git commit -m "feat: hand off failed startup operations"
~~~~

### Task 7: 全量验证

**Files:**

- Verify only: webui/src/components/system/*

- [ ] **Step 1: 运行目标测试**

Run: npm run test -- src/components/system/SystemView.test.tsx src/components/system/systemAgentHandoff.test.ts src/components/system/SystemAgentChat.test.tsx

Expected: PASS，规划器现有行为与所有交接路径均通过。

- [ ] **Step 2: 运行静态检查和构建**

Run: npm run lint && npm run build

Expected: 两个命令均以 exit code 0 结束。

- [ ] **Step 3: 检查提交范围**

Run: git diff --check HEAD~6..HEAD && git status --short

Expected: 没有空白错误；实现提交只包含系统维护交接文件。

- [ ] **Step 4: 仅在验证修复时提交**

~~~~bash
git add webui/src/components/system
git commit -m "test: verify system agent handoffs"
~~~~

仅当验证步骤确实修改了文件时执行该提交；否则不创建空提交。
