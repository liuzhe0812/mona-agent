import { describe, expect, it } from "vitest";

import { filterSessionsByQuery } from "@/lib/session-search";
import type { AgentSummary, ChatSummary } from "@/lib/types";

const sessions: ChatSummary[] = [
  {
    key: "websocket:research",
    channel: "websocket",
    chatId: "research",
    createdAt: null,
    updatedAt: null,
    title: "每周研究",
    preview: "新能源行业趋势更新",
    conversation: {
      type: "direct",
      title: "",
      agentIds: ["research-agent"],
      directAgentId: "research-agent",
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
  ["research-agent", {
    id: "research-agent",
    displayName: "行业分析师",
    enabled: true,
  }],
]);

describe("filterSessionsByQuery", () => {
  it("searches titles, previews, room goals, and agent names with AND terms", () => {
    expect(filterSessionsByQuery(sessions, "行业 每周", {}, agents)).toEqual([sessions[0]]);
    expect(filterSessionsByQuery(sessions, "运营 排期", {}, agents)).toEqual([sessions[1]]);
    expect(filterSessionsByQuery(sessions, "新能源 运营", {}, agents)).toEqual([]);
  });
});
