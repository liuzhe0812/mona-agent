import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdviceContent, RichProfile } from "@/lib/profile-api";

import { WorkPatternTab } from "./WorkPatternTab";

const mocks = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return { ...actual, openExternalUrl: mocks.openExternalUrl };
});

type OneInsightFields = {
  kind: "one_insight";
  knowledge: { title: string; content: string };
  learning_advice: string;
  resources: Array<{ title: string; url: string; source?: string }>;
};

const insight = {
  id: "advice-1",
  dimension: "learning",
  title: "旧标题不应覆盖新的知识标题",
  why_now: "旧建议依据：你在多次交流中反复校准上下文范围。",
  source_refs: [],
  first_step: "先看一次真实输入。",
  starter_content: "旧版学习建议。",
  expected_output: "一份理解",
  done_when: "能解释清楚。",
  start_prompt: "请继续解释。",
  created_at: "2026-09-08T09:00:00+08:00",
  last_supported_at: "2026-09-08T09:00:00+08:00",
  source_scope_id: "scope",
  kind: "one_insight",
  knowledge: {
    title: "AI 能否真正了解你，取决于它看到了什么",
    content: "关于你的判断，必须建立在真正送入模型的相关信息上。\n\n> 先弄清 AI 看到了什么，再判断它是否真的了解了你。",
  },
  learning_advice: "1. 先分清当前对话、长期保存的信息，以及检索补回的内容。\n2. 看一次真实分析的输入。",
  resources: [
    { title: "LangChain：短期与长期记忆", url: "https://docs.langchain.com/oss/python/concepts/memory", source: "LangChain" },
    { title: "无效资料", url: "javascript:alert(1)" },
  ],
} as AdviceContent & OneInsightFields;

const secondInsight = {
  ...insight,
  id: "advice-2",
  knowledge: { title: "不应展示的第二条", content: "第二条内容。" },
} as AdviceContent & OneInsightFields;

function renderProfile(items: AdviceContent[] = [insight, secondInsight], currentIds = ["advice-1"]) {
  const data: RichProfile = { advice: { generation_status: "ready", current_ids: currentIds, items } };
  return render(<WorkPatternTab data={data} loading={false} />);
}

describe("WorkPatternTab one insight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openExternalUrl.mockResolvedValue(undefined);
  });

  it("renders only the first current insight with the new schema", () => {
    renderProfile([secondInsight, insight], ["advice-1", "advice-2"]);

    expect(screen.getByText("AI 给你的一个建议")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI 能否真正了解你，取决于它看到了什么" })).toBeInTheDocument();
    expect(screen.getByText("关于你的判断，必须建立在真正送入模型的相关信息上。")).toBeInTheDocument();
    expect(screen.getByText("怎么提升")).toBeInTheDocument();
    expect(screen.getByText("先分清当前对话、长期保存的信息，以及检索补回的内容。")).toBeInTheDocument();
    expect(screen.getByText("参考资源")).toBeInTheDocument();
    expect(screen.getByText("docs.langchain.com")).toBeInTheDocument();
    expect(screen.queryByText("不应展示的第二条")).not.toBeInTheDocument();
    expect(screen.queryByText("学懂之后，能用在很多地方")).not.toBeInTheDocument();
  });

  it("opens only validated http and https resources with openExternalUrl", async () => {
    renderProfile([insight]);

    fireEvent.click(screen.getByRole("link", { name: /LangChain：短期与长期记忆/ }));

    await waitFor(() => expect(mocks.openExternalUrl).toHaveBeenCalledWith("https://docs.langchain.com/oss/python/concepts/memory"));
    expect(screen.queryByRole("link", { name: /无效资料/ })).not.toBeInTheDocument();
  });

  it("falls back to legacy advice fields when the one-insight fields are absent", () => {
    const legacy = {
      ...insight,
      kind: undefined,
      knowledge: undefined,
      learning_advice: undefined,
      resources: undefined,
      title: "理解上下文与长期记忆的关系",
      why_now: "这能解释为什么保存过的信息不一定会被当前分析使用。",
      starter_content: "先从一次真实分析的输入开始核对。",
    } as AdviceContent;
    renderProfile([legacy]);

    expect(screen.getByRole("heading", { name: "理解上下文与长期记忆的关系" })).toBeInTheDocument();
    expect(screen.getByText("这能解释为什么保存过的信息不一定会被当前分析使用。")).toBeInTheDocument();
    expect(screen.getByText("先从一次真实分析的输入开始核对。")).toBeInTheDocument();
  });
});
