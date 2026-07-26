import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  NewChatDashboard,
  selectTodayFocus,
} from "@/components/thread/NewChatDashboard";
import type { ScheduleItem } from "@/components/schedule/types";
import type { ChatSummary } from "@/lib/types";

const now = new Date(2026, 6, 11, 10, 0);

function scheduleItem(
  title: string,
  hour: number,
  overrides: Partial<ScheduleItem> = {},
): ScheduleItem {
  return {
    id: title,
    title,
    description: "",
    startAtMs: new Date(2026, 6, 11, hour, 0).getTime(),
    endAtMs: null,
    allDay: false,
    recurrence: "none",
    cronExpr: null,
    tz: null,
    kind: "personal",
    aiMessage: null,
    aiDeliver: false,
    done: false,
    enabled: true,
    color: null,
    sourceModule: null,
    sourceChatId: null,
    lastRunAtMs: null,
    nextRunAtMs: null,
    lastStatus: null,
    lastError: null,
    createdAtMs: now.getTime(),
    updatedAtMs: now.getTime(),
    ...overrides,
  };
}

const recentSession: ChatSummary = {
  key: "websocket:research",
  channel: "websocket",
  chatId: "research",
  createdAt: "2026-07-11T01:20:00.000Z",
  updatedAt: "2026-07-11T01:45:00.000Z",
  title: "客户方案调研",
  preview: "",
};

describe("NewChatDashboard", () => {
  it("keeps the closest completed and upcoming items in today's focus timeline", () => {
    const focus = selectTodayFocus(
      [
        scheduleItem("下午检查", 14),
        scheduleItem("项目例会", 9, { done: true }),
        scheduleItem("客户方案评审", 10),
        scheduleItem("明天会议", 11, {
          startAtMs: new Date(2026, 6, 12, 11, 0).getTime(),
        }),
      ],
      now,
    );

    expect(focus.map((item) => item.title)).toEqual([
      "项目例会",
      "客户方案评审",
      "下午检查",
    ]);
  });

  it("continues the latest work and starts the three approved actions", () => {
    const onContinue = vi.fn();
    const onConnectHost = vi.fn();
    const onConnectDatabase = vi.fn();
    const onCreateNote = vi.fn();

    render(
      <NewChatDashboard
        scheduleItems={[
          scheduleItem("项目例会", 9, { done: true }),
          scheduleItem("客户方案评审", 10),
        ]}
        unreadCount={12}
        recentSession={recentSession}
        now={now}
        onContinue={onContinue}
        onConnectHost={onConnectHost}
        onConnectDatabase={onConnectDatabase}
        onCreateNote={onCreateNote}
      />,
    );

    expect(screen.getByText("今日焦点")).toBeInTheDocument();
    expect(screen.getByText("客户方案调研")).toBeInTheDocument();
    expect(screen.getByText("待处理邮件").closest("section")).toHaveTextContent("12 封未读");

    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("button", { name: "连接主机" }));
    fireEvent.click(screen.getByRole("button", { name: "连接数据库" }));
    fireEvent.click(screen.getByRole("button", { name: "新建笔记" }));

    expect(onContinue).toHaveBeenCalledWith(recentSession.key);
    expect(onConnectHost).toHaveBeenCalledOnce();
    expect(onConnectDatabase).toHaveBeenCalledOnce();
    expect(onCreateNote).toHaveBeenCalledOnce();
  });
});
