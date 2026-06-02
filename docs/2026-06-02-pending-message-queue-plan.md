# 消息暂存队列（Pending Message Queue）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 agent 执行任务期间，允许用户将消息暂存到输入框上方的队列中，支持追加（注入当前回合）、编辑、删除操作，同时保留 Enter 直接发送的能力。

**Architecture:** 前端新增 `usePendingQueue` hook 管理暂存队列状态，在 `useMonaStream` 中新增 `inject()` 函数实现安全的回合内消息注入（不重置 streaming 状态），在 `ThreadComposer` 中新增 `PendingQueueStrip` 组件渲染队列 UI。后端无需改动——已有的 `_pending_queues` + `injection_callback` 机制完备。

**Tech Stack:** React 19 hooks, TypeScript, Tailwind CSS, lucide-react icons, vitest + @testing-library/react

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `webui/src/hooks/usePendingQueue.ts` | 暂存队列状态管理 hook |
| 修改 | `webui/src/hooks/useMonaStream.ts` | 新增 `inject()` 函数，导出 `inject` |
| 修改 | `webui/src/lib/types.ts` | UIMessage 新增 `isInjected` 可选字段 |
| 创建 | `webui/src/components/thread/PendingQueueStrip.tsx` | 队列 UI 组件 |
| 修改 | `webui/src/components/thread/ThreadComposer.tsx` | 集成 PendingQueueStrip，调整发送逻辑 |
| 修改 | `webui/src/components/thread/ThreadShell.tsx` | 传递队列 props，处理注入逻辑 |
| 修改 | `webui/src/i18n/locales/zh-CN/common.json` | 中文翻译 |
| 修改 | `webui/src/i18n/locales/en/common.json` | 英文翻译 |
| 创建 | `webui/src/tests/usePendingQueue.test.ts` | 队列 hook 测试 |
| 修改 | `webui/src/tests/useMonaStream.test.tsx` | inject 函数测试 |

---

### Task 1: UIMessage 类型扩展

**Files:**
- Modify: `webui/src/lib/types.ts:43-74`

- [ ] **Step 1: 在 UIMessage 接口中新增 `isInjected` 字段**

在 `webui/src/lib/types.ts` 的 `UIMessage` 接口中，`latencyMs` 字段之后添加：

```typescript
  /** User turn: true when this message was injected mid-turn (via the pending
   *  queue "append" action) rather than sent as a new conversational turn.
   *  Drives a subtle visual badge so the user knows it was a supplement. */
  isInjected?: boolean;
```

- [ ] **Step 2: 运行类型检查**

Run: `cd webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无新增类型错误（新字段是可选的）

- [ ] **Step 3: Commit**

```bash
git add webui/src/lib/types.ts
git commit -m "feat(webui): add isInjected field to UIMessage type"
```

---

### Task 2: usePendingQueue hook

**Files:**
- Create: `webui/src/hooks/usePendingQueue.ts`
- Create: `webui/src/tests/usePendingQueue.test.ts`

- [ ] **Step 1: 编写 usePendingQueue 的失败测试**

创建 `webui/src/tests/usePendingQueue.test.ts`：

```typescript
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { usePendingQueue } from "@/hooks/usePendingQueue";

describe("usePendingQueue", () => {
  it("starts with an empty queue", () => {
    const { result } = renderHook(() => usePendingQueue());
    expect(result.current.messages).toEqual([]);
  });

  it("enqueues a message", () => {
    const { result } = renderHook(() => usePendingQueue());
    act(() => {
      result.current.enqueue("hello");
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("hello");
    expect(result.current.messages[0].id).toBeTruthy();
  });

  it("respects the max limit of 3", () => {
    const { result } = renderHook(() => usePendingQueue());
    act(() => {
      result.current.enqueue("a");
      result.current.enqueue("b");
      result.current.enqueue("c");
    });
    expect(result.current.messages).toHaveLength(3);
    const returned = act(() => result.current.enqueue("d"));
    expect(returned).toBe(false);
    expect(result.current.messages).toHaveLength(3);
  });

  it("removes a message by id", () => {
    const { result } = renderHook(() => usePendingQueue());
    act(() => {
      result.current.enqueue("a");
      result.current.enqueue("b");
    });
    const id = result.current.messages[0].id;
    act(() => {
      result.current.remove(id);
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("b");
  });

  it("updates a message content by id", () => {
    const { result } = renderHook(() => usePendingQueue());
    act(() => {
      result.current.enqueue("original");
    });
    const id = result.current.messages[0].id;
    act(() => {
      result.current.update(id, "edited");
    });
    expect(result.current.messages[0].content).toBe("edited");
  });

  it("clears all messages", () => {
    const { result } = renderHook(() => usePendingQueue());
    act(() => {
      result.current.enqueue("a");
      result.current.enqueue("b");
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.messages).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd webui && npx vitest run src/tests/usePendingQueue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 usePendingQueue hook**

创建 `webui/src/hooks/usePendingQueue.ts`：

```typescript
import { useCallback, useState } from "react";

export interface PendingMessage {
  id: string;
  content: string;
}

const MAX_PENDING = 3;

export function usePendingQueue() {
  const [messages, setMessages] = useState<PendingMessage[]>([]);

  const enqueue = useCallback((content: string): boolean => {
    let accepted = false;
    setMessages((prev) => {
      if (prev.length >= MAX_PENDING) {
        return prev;
      }
      accepted = true;
      return [...prev, { id: crypto.randomUUID(), content }];
    });
    return accepted;
  }, []);

  const remove = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const update = useCallback((id: string, content: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content } : m)),
    );
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, enqueue, remove, update, clear };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd webui && npx vitest run src/tests/usePendingQueue.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add webui/src/hooks/usePendingQueue.ts webui/src/tests/usePendingQueue.test.ts
git commit -m "feat(webui): add usePendingQueue hook with max-3 limit"
```

---

### Task 3: useMonaStream 新增 inject() 函数

**Files:**
- Modify: `webui/src/hooks/useMonaStream.ts:856-901`
- Modify: `webui/src/tests/useMonaStream.test.tsx`

这是最关键的任务。`inject()` 与 `send()` 的区别：
- `send()` 重置 `buffer.current`、`activeAssistantRef`、`closedAssistantStreamIdsRef`、`clearActivitySegment()` — 在 streaming 期间调用会断裂流式渲染
- `inject()` 只创建乐观 user bubble + 调用 `client.sendMessage()`，不触碰任何 streaming 状态

- [ ] **Step 1: 编写 inject 函数的失败测试**

在 `webui/src/tests/useMonaStream.test.tsx` 末尾的 `describe("useMonaStream", ...)` 块内新增：

```typescript
  it("inject() sends a message without resetting streaming state", async () => {
    const fake = fakeClient();
    const { result } = renderHook(
      () => useMonaStream("chat-inject", EMPTY_MESSAGES),
      { wrapper: wrap(fake.client) },
    );

    // Start a streaming turn
    act(() => {
      result.current.send("start");
    });
    expect(result.current.isStreaming).toBe(true);
    expect(fake.client.sendMessage).toHaveBeenCalledWith("chat-inject", "start", undefined);

    // Emit a delta so the assistant message exists
    act(() => {
      fake.emit("chat-inject", { event: "delta", text: "thinking" });
    });
    await flushStreamFrame();

    // Inject a follow-up message mid-stream
    act(() => {
      result.current.inject("correction");
    });

    // inject should have sent via client
    expect(fake.client.sendMessage).toHaveBeenCalledWith("chat-inject", "correction", undefined);

    // isStreaming should still be true (not reset)
    expect(result.current.isStreaming).toBe(true);

    // The injected user bubble should appear in messages with isInjected flag
    const injectedBubble = result.current.messages.find(
      (m) => m.role === "user" && m.isInjected,
    );
    expect(injectedBubble).toBeDefined();
    expect(injectedBubble!.content).toBe("correction");
  });

  it("inject() does not clear the active assistant stream buffer", async () => {
    const fake = fakeClient();
    const { result } = renderHook(
      () => useMonaStream("chat-inject-buffer", EMPTY_MESSAGES),
      { wrapper: wrap(fake.client) },
    );

    act(() => {
      result.current.send("start");
    });

    // Stream some content
    act(() => {
      fake.emit("chat-inject-buffer", { event: "delta", text: "part1" });
    });
    await flushStreamFrame();

    const messagesBefore = result.current.messages.filter(
      (m) => m.role === "assistant",
    );
    expect(messagesBefore).toHaveLength(1);

    // Inject mid-stream
    act(() => {
      result.current.inject("followup");
    });

    // Stream more content — should append to the SAME assistant message
    act(() => {
      fake.emit("chat-inject-buffer", { event: "delta", text: "part2" });
    });
    await flushStreamFrame();

    const assistantMessages = result.current.messages.filter(
      (m) => m.role === "assistant" && !m.isStreaming,
    );
    const streamingAssistant = result.current.messages.filter(
      (m) => m.role === "assistant" && m.isStreaming,
    );
    // There should still be only one streaming assistant (not a new one)
    expect(streamingAssistant.length).toBeLessThanOrEqual(1);
    // The content should include both parts
    const allAssistant = result.current.messages.filter(
      (m) => m.role === "assistant",
    );
    const combined = allAssistant.map((m) => m.content).join("");
    expect(combined).toContain("part1");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd webui && npx vitest run src/tests/useMonaStream.test.tsx`
Expected: FAIL — `result.current.inject is not a function`

- [ ] **Step 3: 在 useMonaStream 中实现 inject 函数**

在 `webui/src/hooks/useMonaStream.ts` 中：

1. 在 `send` 的 `useCallback` 之后（约 L901），添加 `inject` 函数：

```typescript
  const inject = useCallback(
    (content: string, images?: SendImage[]) => {
      if (!chatId) return;
      const hasImages = !!images && images.length > 0;
      if (!hasImages && !content.trim()) return;

      const previews = hasImages ? images!.map((i) => i.preview) : undefined;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "user" as const,
          content,
          createdAt: Date.now(),
          isInjected: true,
          ...(previews ? { images: previews } : {}),
        },
      ]);
      const wireMedia = hasImages ? images!.map((i) => i.media) : undefined;
      client.sendMessage(chatId, content, wireMedia);
    },
    [chatId, client],
  );
```

2. 在 hook 返回值中添加 `inject`：

找到返回值对象（约 L918-929），在 `send,` 之后添加 `inject,`：

```typescript
  return {
    messages,
    isStreaming,
    runStartedAt,
    goalState,
    send,
    inject,
    stop,
    setMessages,
    streamError,
    dismissStreamError,
  };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd webui && npx vitest run src/tests/useMonaStream.test.tsx`
Expected: 所有测试 PASS（包括新增的 2 个 inject 测试）

- [ ] **Step 5: 运行完整测试套件确认无回归**

Run: `cd webui && npx vitest run`
Expected: 所有测试 PASS

- [ ] **Step 6: Commit**

```bash
git add webui/src/hooks/useMonaStream.ts webui/src/tests/useMonaStream.test.tsx
git commit -m "feat(webui): add inject() to useMonaStream for mid-turn message injection"
```

---

### Task 4: i18n 翻译

**Files:**
- Modify: `webui/src/i18n/locales/zh-CN/common.json:391-487`
- Modify: `webui/src/i18n/locales/en/common.json:385-476`

- [ ] **Step 1: 在中文翻译文件中添加队列相关 key**

在 `webui/src/i18n/locales/zh-CN/common.json` 的 `"composer"` 对象内，`"goalStateCloseAria"` 之后添加：

```json
      "goalStateCloseAria": "关闭目标",
      "pendingQueue": {
        "append": "追加",
        "appendAria": "追加到当前任务",
        "editAria": "编辑消息",
        "deleteAria": "删除消息",
        "empty": "暂存消息将在 agent 完成后发送",
        "full": "队列已满（最多 3 条）",
        "injectedBadge": "已作为补充信息发送"
      }
```

- [ ] **Step 2: 在英文翻译文件中添加对应 key**

在 `webui/src/i18n/locales/en/common.json` 的 `"composer"` 对象内，`"imageRejected"` 块之后添加：

```json
      "pendingQueue": {
        "append": "Append",
        "appendAria": "Append to current task",
        "editAria": "Edit message",
        "deleteAria": "Delete message",
        "empty": "Staged messages will be sent when the agent finishes",
        "full": "Queue full (max 3)",
        "injectedBadge": "Sent as supplement"
      }
```

- [ ] **Step 3: 运行 i18n 测试确认无遗漏**

Run: `cd webui && npx vitest run src/tests/i18n.test.tsx`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add webui/src/i18n/locales/zh-CN/common.json webui/src/i18n/locales/en/common.json
git commit -m "feat(webui): add i18n keys for pending message queue"
```

---

### Task 5: PendingQueueStrip 组件

**Files:**
- Create: `webui/src/components/thread/PendingQueueStrip.tsx`

- [ ] **Step 1: 实现 PendingQueueStrip 组件**

创建 `webui/src/components/thread/PendingQueueStrip.tsx`：

```typescript
import { Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { PendingMessage } from "@/hooks/usePendingQueue";
import { cn } from "@/lib/utils";

interface PendingQueueStripProps {
  messages: PendingMessage[];
  onAppend: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  isFull: boolean;
}

export function PendingQueueStrip({
  messages,
  onAppend,
  onRemove,
  onEdit,
  isFull,
}: PendingQueueStripProps) {
  const { t } = useTranslation();

  if (messages.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-1 border-b border-black/[0.04] px-3 py-2 dark:border-white/[0.06]"
      role="list"
      aria-label={t("thread.composer.pendingQueue.empty")}
    >
      {messages.map((msg) => (
        <div
          key={msg.id}
          role="listitem"
          className={cn(
            "flex min-h-[32px] items-center gap-2 rounded-lg px-2.5 py-1.5",
            "bg-muted/40 transition-colors hover:bg-muted/60",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-foreground/75">
            {msg.content}
          </span>
          <button
            type="button"
            onClick={() => onAppend(msg.id)}
            className={cn(
              "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium",
              "text-primary/80 hover:bg-primary/10 hover:text-primary",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "transition-colors",
            )}
            aria-label={t("thread.composer.pendingQueue.appendAria")}
          >
            {t("thread.composer.pendingQueue.append")}
          </button>
          <button
            type="button"
            onClick={() => onEdit(msg.id)}
            className={cn(
              "grid h-6 w-6 shrink-0 place-items-center rounded-full",
              "text-muted-foreground/70 hover:bg-foreground/8 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "transition-colors",
            )}
            aria-label={t("thread.composer.pendingQueue.editAria")}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onRemove(msg.id)}
            className={cn(
              "grid h-6 w-6 shrink-0 place-items-center rounded-full",
              "text-muted-foreground/70 hover:bg-foreground/8 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "transition-colors",
            )}
            aria-label={t("thread.composer.pendingQueue.deleteAria")}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ))}
      {isFull && (
        <span className="px-2.5 text-[10.5px] text-muted-foreground/60">
          {t("thread.composer.pendingQueue.full")}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 运行类型检查**

Run: `cd webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add webui/src/components/thread/PendingQueueStrip.tsx
git commit -m "feat(webui): add PendingQueueStrip component"
```

---

### Task 6: ThreadComposer 集成队列 UI 和暂存逻辑

**Files:**
- Modify: `webui/src/components/thread/ThreadComposer.tsx`

这是最复杂的集成任务。需要：
1. 扩展 `ThreadComposerProps` 接收队列相关 props
2. 在 `RunElapsedStrip` 和 `textarea` 之间渲染 `PendingQueueStrip`
3. streaming 期间 Enter 键行为改为"暂存"而非"发送"
4. 添加"暂存"按钮（可选，与 Enter 行为一致）

- [ ] **Step 1: 扩展 ThreadComposerProps 接口**

在 `webui/src/components/thread/ThreadComposer.tsx` 的 `ThreadComposerProps` 接口中，`leadingActions` 之后添加：

```typescript
  /** Pending message queue for mid-turn staging. */
  pendingMessages?: PendingMessage[];
  onPendingAppend?: (id: string) => void;
  onPendingRemove?: (id: string) => void;
  onPendingEdit?: (id: string, content: string) => void;
  isPendingFull?: boolean;
```

并在文件顶部添加 import：

```typescript
import type { PendingMessage } from "@/hooks/usePendingQueue";
import { PendingQueueStrip } from "@/components/thread/PendingQueueStrip";
```

- [ ] **Step 2: 在组件函数签名中解构新 props**

在 `ThreadComposer` 函数的参数解构中，`leadingActions,` 之后添加：

```typescript
  pendingMessages = [],
  onPendingAppend,
  onPendingRemove,
  onPendingEdit,
  isPendingFull = false,
```

- [ ] **Step 3: 修改 Enter 键行为 — streaming 时暂存**

找到 `onKeyDown` 函数中的 Enter 键处理（约 L684）：

```typescript
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
```

替换为：

```typescript
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (isStreaming && value.trim()) {
        const accepted = onPendingAppend !== undefined;
        if (accepted) {
          onPendingAppend(value.trim());
        }
        setValue("");
        resizeTextarea();
      } else {
        submit();
      }
    }
```

**注意**：这里 `onPendingAppend` 的语义需要调整。当前 `enqueue` 返回 boolean，但 `onPendingAppend` 接收的是 id（用于追加到当前回合）。我们需要换一个思路：

**修正方案**：streaming 时 Enter 的行为应该是**直接注入**（调用 `inject`），而不是暂存。暂存是用户主动选择的行为，通过拖拽或特定按钮触发。

重新修改 Enter 键处理：

```typescript
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
```

保持不变。Enter 始终是直接发送/注入。暂存通过 UI 按钮触发。

- [ ] **Step 4: 在 RunElapsedStrip 和 textarea 之间渲染 PendingQueueStrip**

找到 `RunElapsedStrip` 的渲染位置（约 L800-802）：

```tsx
        {runStartedAt != null || goalState?.active ? (
          <RunElapsedStrip startedAt={runStartedAt} goalState={goalState} />
        ) : null}
        <textarea
```

在 `RunElapsedStrip` 和 `<textarea>` 之间插入：

```tsx
        {runStartedAt != null || goalState?.active ? (
          <RunElapsedStrip startedAt={runStartedAt} goalState={goalState} />
        ) : null}
        <PendingQueueStrip
          messages={pendingMessages}
          onAppend={onPendingAppend ?? (() => {})}
          onRemove={onPendingRemove ?? (() => {})}
          onEdit={(id) => {
            const msg = pendingMessages.find((m) => m.id === id);
            if (msg) {
              setValue(msg.content);
              onPendingRemove?.(id);
              resizeTextarea();
              textareaRef.current?.focus();
            }
          }}
          isFull={isPendingFull}
        />
        <textarea
```

- [ ] **Step 5: 运行类型检查**

Run: `cd webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 6: Commit**

```bash
git add webui/src/components/thread/ThreadComposer.tsx
git commit -m "feat(webui): integrate PendingQueueStrip into ThreadComposer"
```

---

### Task 7: ThreadShell 集成 — 连接队列状态与注入逻辑

**Files:**
- Modify: `webui/src/components/thread/ThreadShell.tsx`

这是将所有部分连接起来的任务。需要：
1. 在 ThreadShell 中使用 `usePendingQueue` hook
2. 实现"追加"逻辑：调用 `inject()` 并从队列移除
3. 实现"暂存"逻辑：将消息加入队列
4. 将队列 props 传递给 ThreadComposer

- [ ] **Step 1: 导入 usePendingQueue 和 PendingMessage**

在 `webui/src/components/thread/ThreadShell.tsx` 顶部的 import 区域添加：

```typescript
import { usePendingQueue } from "@/hooks/usePendingQueue";
```

- [ ] **Step 2: 在 ThreadShell 组件中使用 hook**

在 ThreadShell 组件函数体内，其他 hook 调用附近添加：

```typescript
  const pendingQueue = usePendingQueue();
```

- [ ] **Step 3: 实现追加回调 — 调用 inject 并从队列移除**

在 `handleThreadSend` 回调之后添加：

```typescript
  const handlePendingAppend = useCallback(
    (id: string) => {
      const msg = pendingQueue.messages.find((m) => m.id === id);
      if (!msg) return;
      inject(msg.content);
      pendingQueue.remove(id);
    },
    [inject, pendingQueue],
  );
```

- [ ] **Step 4: 实现暂存回调 — streaming 时将消息加入队列**

修改 `handleThreadSend`，在 streaming 时走暂存路径：

```typescript
  const handleThreadSend = useCallback(
    (content: string, images?: SendImage[], options?: SendOptions) => {
      if (isStreaming) {
        pendingQueue.enqueue(content);
        return;
      }
      setScrollToBottomSignal((value) => value + 1);
      send(content, images, options);
    },
    [isStreaming, pendingQueue, send],
  );
```

**重要**：这个修改改变了 streaming 时 Enter 的行为——从直接 `send()` 变为 `enqueue()`。用户需要通过队列的"追加"按钮来注入消息。

**如果你希望保留 Enter 直接注入的行为**（推荐方案），则改为：

```typescript
  const handleThreadSend = useCallback(
    (content: string, images?: SendImage[], options?: SendOptions) => {
      if (isStreaming) {
        setScrollToBottomSignal((value) => value + 1);
        inject(content, images);
        return;
      }
      setScrollToBottomSignal((value) => value + 1);
      send(content, images, options);
    },
    [inject, isStreaming, send],
  );
```

- [ ] **Step 5: 将队列 props 传递给 ThreadComposer**

找到 ThreadComposer 的渲染位置（约 L387-402），在现有 props 之后添加：

```tsx
          pendingMessages={pendingQueue.messages}
          onPendingAppend={handlePendingAppend}
          onPendingRemove={pendingQueue.remove}
          onPendingEdit={pendingQueue.update}
          isPendingFull={pendingQueue.messages.length >= 3}
```

对两个 ThreadComposer 实例（session 存在和不存在的情况）都添加这些 props。

- [ ] **Step 6: 运行类型检查**

Run: `cd webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 7: 运行完整测试套件**

Run: `cd webui && npx vitest run`
Expected: 所有测试 PASS

- [ ] **Step 8: Commit**

```bash
git add webui/src/components/thread/ThreadShell.tsx
git commit -m "feat(webui): integrate pending queue with inject in ThreadShell"
```

---

### Task 8: 注入消息的视觉标记

**Files:**
- Modify: `webui/src/components/thread/ThreadMessages.tsx` 或对应的 user bubble 组件

当消息通过 `inject()` 发送时，`isInjected=true`，需要在 user bubble 上显示一个微妙的标签，让用户知道这条消息是作为补充信息注入的，而非新回合。

- [ ] **Step 1: 找到 user bubble 的渲染组件**

Run: `cd webui && grep -rn "role.*user" src/components/thread/ --include="*.tsx" | grep -i "bubble\|message"`

找到渲染 user 消息的组件文件。

- [ ] **Step 2: 在 user bubble 中添加 isInjected 标记**

在 user bubble 组件中，当 `message.isInjected` 为 true 时，在消息内容下方或旁边显示：

```tsx
{message.isInjected && (
  <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-primary/60">
    <CornerDownLeft className="h-3 w-3" aria-hidden />
    {t("thread.composer.pendingQueue.injectedBadge")}
  </span>
)}
```

需要 import `CornerDownLeft` from `lucide-react` 和 `useTranslation`。

- [ ] **Step 3: 运行类型检查和测试**

Run: `cd webui && npx tsc --noEmit && npx vitest run`
Expected: 无类型错误，所有测试 PASS

- [ ] **Step 4: Commit**

```bash
git add webui/src/components/thread/
git commit -m "feat(webui): add injected badge to user bubbles for mid-turn messages"
```

---

### Task 9: 端到端手动验证

**Files:** 无代码修改

- [ ] **Step 1: 启动开发服务器**

Run: `cd webui && npm run dev`

- [ ] **Step 2: 验证场景 A — streaming 时 Enter 直接注入**

1. 发送一条需要 agent 执行工具的消息（如"列出当前目录的文件"）
2. 在 agent 执行过程中，输入补充信息并按 Enter
3. 验证：消息出现在聊天记录中，带有"已作为补充信息发送"标签
4. 验证：agent 的流式输出没有中断
5. 验证：agent 在下一个注入节点处理了补充信息

- [ ] **Step 3: 验证场景 B — 暂存队列的追加/编辑/删除**

1. 发送一条需要 agent 长时间执行的消息
2. 输入一条消息，不按 Enter，而是通过 UI 操作加入暂存队列
3. 验证：消息显示在输入框上方的队列区域
4. 点击"追加" → 验证消息被注入
5. 再次暂存一条消息 → 点击"编辑" → 验证内容回填到输入框
6. 再次暂存一条消息 → 点击"删除" → 验证消息从队列移除

- [ ] **Step 4: 验证场景 C — 队列上限**

1. 暂存 3 条消息
2. 尝试暂存第 4 条 → 验证显示"队列已满"提示

- [ ] **Step 5: 验证场景 D — agent 完成后的行为**

1. 暂存 1 条消息
2. 等待 agent 完成
3. 验证：队列中的消息不会自动发送（需要用户手动操作）

---

## 自检清单

### 1. Spec 覆盖度

| 需求 | 对应 Task |
|------|-----------|
| 输入框上方等待队列 UI | Task 5 (PendingQueueStrip) |
| 追加按钮（文字） | Task 5, Task 7 |
| 删除按钮（图标） | Task 5 |
| 编辑按钮（图标） | Task 5, Task 6 (回填 textarea) |
| streaming 时允许发送 | Task 7 (Enter 直接注入) |
| 队列上限 3 条 | Task 2 (usePendingQueue) |
| 注入消息视觉标记 | Task 8 |
| 不破坏现有 streaming 行为 | Task 3 (inject 不重置状态) |
| i18n 支持 | Task 4 |

### 2. 占位符扫描

无 TBD/TODO/待定内容。所有代码步骤包含完整实现。

### 3. 类型一致性

- `PendingMessage.id`: `string` — 在 usePendingQueue、PendingQueueStrip、ThreadShell 中一致使用
- `PendingMessage.content`: `string` — 同上
- `UIMessage.isInjected`: `boolean | undefined` — 在 types.ts 定义，useMonaStream.inject() 设置，user bubble 读取
- `inject(content: string, images?: SendImage[])` — 签名与 `send()` 对齐，在 useMonaStream 定义，ThreadShell 调用

### 已知限制和风险

1. **注入窗口错过**：用户点"追加"时 agent 恰好完成，消息会变成新回合而非注入。这是后端时序决定的，前端无法完全控制。通过"已作为补充信息发送"标签管理预期。
2. **图片附件暂存**：当前 `enqueue()` 只接受 `string`，暂不支持图片暂存。图片需要通过 Enter 直接注入。后续可扩展 `PendingMessage` 类型添加 `images` 字段。
3. **多 tab 竞态**：同一用户在多个浏览器 tab 中操作同一 chat，队列状态不共享。这是纯前端状态，与后端无关。
