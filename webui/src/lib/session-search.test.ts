import { describe, expect, it } from "vitest";

import { filterSessionsByQuery } from "@/lib/session-search";
import type { AgentSummary, ChatSummary } from "@/lib/types";

const sessions: ChatSummary[] = [
  {
    key: "websocket:stock",
    channel: "websocket",
    chatId: "stock",
    createdAt: null,
    updatedAt: null,
    title: "每日复盘",
    preview: "新能源板块估值更新",
    conversation: {
      type: "direct",
      title: "",
      agentIds: ["stock-agent"],
      directAgentId: "stock-agent",
    },
  },
  {
    key: "websocket:room",
    channel: "websocket",
    chatId: "room",
    createdAt: null,
    updatedAt: null,
    title: "内容计划",
    preview: "准备本周选题",
    conversation: {
      type: "room",
      title: "小红书运营室",
      goal: "完成本周内容排期",
      agentIds: ["redbook-agent"],
    },
  },
];

const agents = new Map<string, AgentSummary>([
  ["stock-agent", {
    id: "stock-agent",
    displayName: "A股分析师",
    enabled: true,
  }],
]);

describe("filterSessionsByQuery", () => {
  it("searches titles, previews, room goals, and agent names with AND terms", () => {
    expect(filterSessionsByQuery(sessions, "A股 每日", {}, agents)).toEqual([sessions[0]]);
    expect(filterSessionsByQuery(sessions, "运营 排期", {}, agents)).toEqual([sessions[1]]);
    expect(filterSessionsByQuery(sessions, "新能源 运营", {}, agents)).toEqual([]);
  });
});
