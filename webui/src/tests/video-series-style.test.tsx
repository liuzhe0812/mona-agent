import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoStyleWorkspace } from "@/components/doc/video/style/VideoStyleWorkspace";
import { ApiError, type VideoStyleDraft } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  createVideoSeries: vi.fn(), createVideoProject: vi.fn(), fetchVideoProject: vi.fn(), fetchVideoStyleDraft: vi.fn(), fetchVideoSeriesDetail: vi.fn(),
  importVideoProjectAsset: vi.fn(), lockVideoStyle: vi.fn(), saveVideoChatId: vi.fn(), saveVideoStyleDraft: vi.fn(),
  updateVideoProjectSettings: vi.fn(), updateVideoSeries: vi.fn(), bindVideoStyleSample: vi.fn(), fetchVideoStyleSample: vi.fn(),
  fetchVideoStyleReference: vi.fn(),
  fetchVideoSessionModelBinding: vi.fn(),
  client: { newChat: vi.fn(), sendMessage: vi.fn(), getRunStartedAt: vi.fn(() => null), onRunStatus: vi.fn(() => () => {}), onChat: vi.fn(() => () => {}) },
}));
vi.mock("@/lib/api", () => ({ ...mocks, ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/video-style-api", () => mocks);
vi.mock("@/providers/ClientProvider", () => ({ useClient: () => ({ token: "test", client: mocks.client }) }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => false }));
vi.mock("@/components/doc/DocChatPanel", () => ({ DocChatPanel: ({ chatId }: { chatId: string }) => <div>风格对话 {chatId}</div> }));
vi.mock("@/components/doc/video/VideoModelSelector", () => ({ VideoModelSelector: ({ value, onChange, disabled }: any) => <button disabled={disabled} aria-label="选择制作模型" onClick={() => onChange({ executor: "codex", model: "gpt-6.1-sol", provider: null, effort: "high" })}>{value?.model ?? "跟随 Mona"}</button> }));

const initial: VideoStyleDraft = {
  seriesId: "my-style", revision: 0, name: "我的纸张风格", baseTemplateId: "dashi-paper",
  tokens: { colors: { primary: "#123456", background: "#ffffff" }, typography: { bodyFamily: "Microsoft YaHei" } },
};

describe("custom video style workflow", () => {
  let saved: VideoStyleDraft;
  let projectExists: boolean;
  beforeEach(() => {
    vi.clearAllMocks();
    saved = structuredClone(initial); projectExists = false;
    mocks.fetchVideoSessionModelBinding.mockResolvedValue(null);
    mocks.createVideoSeries.mockResolvedValue({ ok: true, series: { id: initial.seriesId, name: initial.name }, draft: saved });
    mocks.saveVideoStyleDraft.mockImplementation(async (_token, _id, draft) => { saved = { ...saved, ...draft, authoring: { ...saved.authoring, ...draft.authoring }, tokens: draft.tokens ? { ...saved.tokens, ...draft.tokens } : saved.tokens, revision: saved.revision + 1 }; return { ok: true, draft: saved }; });
    mocks.fetchVideoStyleDraft.mockImplementation(async () => saved);
    mocks.fetchVideoSeriesDetail.mockResolvedValue({ id: initial.seriesId, name: initial.name, latestStyleVersion: 1, styles: [] });
    mocks.createVideoProject.mockImplementation(async () => { projectExists = true; return { ok: true }; });
    mocks.fetchVideoProject.mockImplementation(async () => {
      if (!projectExists) throw new ApiError(404, "not found");
      return { name: "风格样片-my-style", chatId: null, meta: { scenes: [] } };
    });
    mocks.bindVideoStyleSample.mockImplementation(async (_token, _id, projectName, revision, description) => {
      expect(revision).toBe(saved.revision);
      saved = { ...saved, revision: revision + 1, authoring: { ...saved.authoring, projectName, description } };
      return { ok: true, draft: saved };
    });
    mocks.client.newChat.mockResolvedValue("style-chat");
    mocks.saveVideoChatId.mockResolvedValue({ ok: true });
    mocks.updateVideoSeries.mockResolvedValue({ ok: true });
    mocks.fetchVideoStyleSample.mockResolvedValue({ ok: true, html: "<html><body>实际样片</body></html>", duration: 10, revision: 2, editableFields: ["primaryColor"] });
    mocks.lockVideoStyle.mockResolvedValue({ ok: true, version: { seriesId: initial.seriesId, version: 1 } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("creates a sample with its own chat and returned draft revision, without starting the full video", async () => {
    const onSaved = vi.fn();
    const view = render(<VideoStyleWorkspace aspectRatio="9:16" topic="过滤水流" onBack={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("描述想要的风格"), { target: { value: "温暖纸张，蓝色线稿" } });
    expect(screen.queryByRole("button", { name: "保存并使用" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成样片" }));
    await waitFor(() => expect(mocks.client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.createVideoProject).toHaveBeenCalledWith("test", "风格样片-my-style", "1080x1920", expect.objectContaining({ templateId: "dashi-paper" }));
    expect(mocks.createVideoSeries).toHaveBeenCalledWith("test", expect.objectContaining({ baseTemplateId: "custom" }));
    expect(mocks.saveVideoChatId).toHaveBeenCalledWith("test", "风格样片-my-style", "style-chat");
    expect(mocks.client.sendMessage.mock.calls[0][1]).toContain("不要导出");
    expect(onSaved).not.toHaveBeenCalled();
    view.unmount();
  });

  it("reconciles a lost project-create response before retrying, avoiding duplicate project creation", async () => {
    mocks.createVideoProject.mockImplementationOnce(async () => { projectExists = true; throw new ApiError(503, "暂时不可用"); });
    const view = render(<VideoStyleWorkspace aspectRatio="16:9" onBack={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("描述想要的风格"), { target: { value: "剪纸风格" } });
    fireEvent.click(screen.getByRole("button", { name: "生成样片" }));
    await screen.findByText("暂时不可用");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "生成样片" }));
    await waitFor(() => expect(mocks.client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.createVideoProject).toHaveBeenCalledOnce();
    expect(mocks.client.newChat).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("retains an unfinished draft on return without creating a conversation or video", async () => {
    const onBack = vi.fn();
    const view = render(<VideoStyleWorkspace aspectRatio="16:9" onBack={onBack} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("描述想要的风格"), { target: { value: "简洁手绘" } });
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(mocks.saveVideoStyleDraft).toHaveBeenCalled();
    expect(mocks.createVideoProject).not.toHaveBeenCalled();
    expect(mocks.client.newChat).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps the editor open when the recovery draft cannot be saved", async () => {
    mocks.saveVideoStyleDraft.mockRejectedValue(new Error("write failed"));
    const onBack = vi.fn();
    const view = render(<VideoStyleWorkspace aspectRatio="16:9" onBack={onBack} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("描述想要的风格"), { target: { value: "简洁手绘" } });
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await screen.findByText("草稿未能保留，请重试后再返回。");
    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByLabelText("描述想要的风格")).toHaveValue("简洁手绘");
    view.unmount();
  });

  it("reuses a restored sample chat and preserves a failed save for retry", async () => {
    saved = { ...initial, revision: 2, authoring: { projectName: "风格样片-my-style", description: "蓝色纸张" } };
    projectExists = true;
    mocks.fetchVideoProject.mockResolvedValue({ name: "风格样片-my-style", chatId: "original-style-chat", meta: { resolution: "1920x1080", scenes: [{ sourceHash: "source", motionReviewSourceHash: "source" }] } });
    mocks.lockVideoStyle.mockRejectedValueOnce(new ApiError(503, "保存暂时失败"));
    const onSaved = vi.fn();
    const view = render(<VideoStyleWorkspace initialSeriesId="my-style" aspectRatio="16:9" onBack={vi.fn()} onSaved={onSaved} />);
    const save = await screen.findByRole("button", { name: "保存并使用" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await screen.findByText("保存暂时失败");
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试", exact: true }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ seriesId: "my-style", version: 1 }));
    expect(mocks.client.newChat).not.toHaveBeenCalled();
    expect(mocks.client.sendMessage).not.toHaveBeenCalled();
    view.unmount();
  });
  it("uses the latest server revision for a rename without overwriting Agent style updates", async () => {
    saved = { ...initial, revision: 2, authoring: { projectName: "风格样片-my-style", description: "纸张" } };
    mocks.fetchVideoProject.mockResolvedValue({ chatId: "style-chat", meta: { resolution: "1920x1080", scenes: [{ sourceHash: "s", motionReviewSourceHash: "s" }] } });
    const view = render(<VideoStyleWorkspace initialSeriesId="my-style" aspectRatio="16:9" onBack={vi.fn()} onSaved={vi.fn()} />);
    const save = await screen.findByRole("button", { name: "保存并使用" });
    await waitFor(() => expect(save).not.toBeDisabled());
    saved = { ...saved, revision: 6, tokens: { ...saved.tokens, colors: { ...saved.tokens?.colors, primary: "#aa8822" } }, authoring: { ...saved.authoring, rules: "Agent最新画法" } };
    fireEvent.change(screen.getByLabelText("风格名称"), { target: { value: "新风格名" } });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.lockVideoStyle).toHaveBeenCalled());
    expect(mocks.saveVideoStyleDraft.mock.calls.at(-1)?.[2]).toMatchObject({ revision: 6, name: "新风格名" });
    expect(saved.tokens?.colors?.primary).toBe("#aa8822");
    expect(saved.authoring?.rules).toBe("Agent最新画法");
    view.unmount();
  });

  it("keeps a color edit when an older automatic name-save response arrives first", async () => {
    saved = { ...initial, revision: 2, authoring: { projectName: "风格样片-my-style", description: "纸张" } };
    mocks.fetchVideoProject.mockResolvedValue({ chatId: "style-chat", meta: { resolution: "1920x1080", scenes: [{ sourceHash: "s", motionReviewSourceHash: "s" }] } });
    let completeNameSave: (() => void) | undefined;
    mocks.saveVideoStyleDraft.mockImplementationOnce((_token, _id, payload) => new Promise((resolve) => {
      completeNameSave = () => { saved = { ...saved, ...payload, authoring: { ...saved.authoring, ...payload.authoring }, revision: saved.revision + 1 }; resolve({ ok: true, draft: structuredClone(saved) }); };
    }));
    const view = render(<VideoStyleWorkspace initialSeriesId="my-style" aspectRatio="16:9" onBack={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByRole("button", { name: "保存并使用" });
    fireEvent.change(screen.getByLabelText("风格名称"), { target: { value: "名称先改" } });
    await waitFor(() => expect(completeNameSave).toBeDefined());
    fireEvent.mouseDown(screen.getByRole("tab", { name: "样式", exact: true }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByLabelText("主题色"), { target: { value: "#dd2244" } });
    completeNameSave!();
    await waitFor(() => expect(mocks.bindVideoStyleSample).toHaveBeenCalledWith("test", "my-style", "风格样片-my-style", expect.any(Number), "纸张", true));
    expect(saved.tokens?.colors?.primary).toBe("#dd2244");
    expect(screen.getByLabelText("主题色")).toHaveValue("#dd2244");
    view.unmount();
  });

  it("restores a draft reference thumbnail and releases it on leaving", async () => {
    const path = "C:/workspace/uploads/reference.png";
    saved = { ...initial, revision: 2, authoring: { referencePaths: [path], description: "墨线" } };
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:restored-reference");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    mocks.fetchVideoStyleReference.mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    const view = render(<VideoStyleWorkspace initialSeriesId="my-style" aspectRatio="16:9" onBack={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(view.container.querySelector('img[src="blob:restored-reference"]')).not.toBeNull());
    expect(mocks.fetchVideoStyleReference).toHaveBeenCalledWith("test", "my-style", 0, expect.any(AbortSignal));
    expect(createUrl).toHaveBeenCalledOnce();
    view.unmount();
    expect(revokeUrl).toHaveBeenCalledWith("blob:restored-reference");
  });

  it("does not present a saved sample as outdated or save it twice", async () => {
    saved = { ...initial, revision: 2, authoring: { projectName: "风格样片-my-style", description: "纸张" } };
    mocks.fetchVideoProject.mockResolvedValue({ chatId: "style-chat", meta: { resolution: "1920x1080", scenes: [{ sourceHash: "s", motionReviewSourceHash: "s" }] } });
    const view = render(<VideoStyleWorkspace initialSeriesId="my-style" aspectRatio="16:9" useOnSave={false} onBack={vi.fn()} onSaved={vi.fn()} />);
    const save = await screen.findByRole("button", { name: "保存风格" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    expect(mocks.lockVideoStyle).toHaveBeenCalledOnce();
    expect(screen.queryByText("样片更新后可保存")).not.toBeInTheDocument();
    view.unmount();
  });

  it("uses the selected native model for the sample chat and first production turn", async () => {
    const binding = { executor: "codex", model: "gpt-6.1-sol", provider: null, effort: "high" } as const;
    mocks.fetchVideoSessionModelBinding.mockResolvedValue(binding);
    const view = render(<VideoStyleWorkspace aspectRatio="16:9" onBack={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "选择制作模型" }));
    await screen.findByText("gpt-6.1-sol");
    fireEvent.change(screen.getByLabelText("描述想要的风格"), { target: { value: "蓝色线稿" } });
    fireEvent.click(screen.getByRole("button", { name: "生成样片" }));
    await waitFor(() => expect(mocks.client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.client.newChat).toHaveBeenCalledWith(45000, false, null, "video", binding);
    expect(mocks.client.sendMessage.mock.calls[0][3]).toMatchObject({ agentKind: "video" });
    expect(mocks.client.sendMessage.mock.calls[0][3]).not.toHaveProperty("modelBinding");
    expect(saved.authoring?.modelBinding).toEqual(binding);
    view.unmount();
  });

});
