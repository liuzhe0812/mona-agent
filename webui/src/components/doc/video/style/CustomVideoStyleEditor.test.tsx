import React from "react";
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CustomVideoStyleEditor,
  type CustomVideoStyleEditorProps,
} from "./CustomVideoStyleEditor";

afterEach(cleanup);

function props(overrides: Partial<CustomVideoStyleEditorProps> = {}): CustomVideoStyleEditorProps {
  return {
    name: "暖色讲解",
    onNameChange: vi.fn(),
    description: "温暖的纸张质感，用图形解释概念。",
    onDescriptionChange: vi.fn(),
    referencePaths: ["C:\\private\\reference.png"],
    onAddReference: vi.fn(),
    onRemoveReference: vi.fn(),
    sample: null,
    busy: false,
    saving: false,
    onGenerate: vi.fn(),
    onSave: vi.fn(),
    onBack: vi.fn(),
    onStop: vi.fn(),
    canSave: true,
    style: {
      primaryColor: "#315F9A",
      backgroundColor: "#F5F7FA",
      fontFamily: "Noto Sans SC",
    },
    onStyleChange: vi.fn(),
    chat: <div data-testid="mock-chat">会话内容和输入框</div>,
    onChatVisibleChange: vi.fn(),
    ...overrides,
  };
}

describe("CustomVideoStyleEditor", () => {
  it("keeps the initial prompt until the conversation is ready, then reveals the mounted chat", async () => {
    const editorProps = props();
    const view = render(<CustomVideoStyleEditor {...editorProps} />);

    expect(screen.getByLabelText("描述想要的风格")).toBeInTheDocument();
    expect(screen.getByText("reference.png")).toBeInTheDocument();
    expect(screen.queryByText("C:\\private")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存风格" })).not.toBeInTheDocument();
    expect(screen.getByTestId("custom-video-style-chat-content")).toHaveStyle({ display: "none" });

    fireEvent.click(screen.getByRole("button", { name: "生成样片" }));

    expect(editorProps.onGenerate).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("描述想要的风格")).toBeInTheDocument();

    view.rerender(<CustomVideoStyleEditor {...editorProps} conversationStarted />);

    expect(screen.queryByLabelText("描述想要的风格")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tab", { name: "对话" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("custom-video-style-chat-content")).toHaveStyle({ display: "block" }));

    fireEvent.mouseDown(screen.getByRole("tab", { name: "样式" }), { button: 0, ctrlKey: false });
    await waitFor(() => {
      expect(screen.getByTestId("custom-video-style-chat-content")).toHaveStyle({ display: "none" });
      expect(screen.getByTestId("custom-video-style-chat-content").closest('[role="tabpanel"]')).toHaveStyle({ display: "none" });
      expect(editorProps.onChatVisibleChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("opens the existing conversation on a host request without generating or creating one", async () => {
    const editorProps = props({
      sample: null,
      conversationStarted: false,
      openConversationRequest: 1,
    });
    render(<CustomVideoStyleEditor {...editorProps} />);

    await waitFor(() => expect(screen.getByTestId("custom-video-style-chat-content")).toHaveStyle({ display: "block" }));
    expect(screen.getByRole("tab", { name: "对话" })).toBeInTheDocument();
    expect(editorProps.onGenerate).not.toHaveBeenCalled();
    await waitFor(() => expect(editorProps.onChatVisibleChange).toHaveBeenLastCalledWith(true));
  });

  it("leaves a failed first prompt editable and retries through onGenerate when onRetry is absent", async () => {
    const onGenerate = vi.fn()
      .mockRejectedValueOnce(new Error("internal failure"))
      .mockResolvedValueOnce(undefined);
    const editorProps = props({ onGenerate });
    render(<CustomVideoStyleEditor {...editorProps} />);

    fireEvent.click(screen.getByRole("button", { name: "生成样片" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("未能开始制作样片，请重试。"));
    expect(screen.getByLabelText("描述想要的风格")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试生成" }));
    expect(onGenerate).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole("button", { name: "生成样片" })).toBeEnabled());
  });

  it("keeps the single stop action in the preview toolbar while the chat panel is hidden", async () => {
    const editorProps = props({
      sample: { html: "<html><body>sample</body></html>", duration: 12 },
      busy: true,
      status: "正在更新样片…",
    });
    render(<CustomVideoStyleEditor {...editorProps} />);

    expect(screen.getByTitle("风格样片预览")).toBeInTheDocument();
    expect(screen.getByText("正在更新样片…")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "样式" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    expect(editorProps.onStop).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.getByTestId("custom-video-style-chat-content")).toHaveStyle({ display: "none" });
      expect(editorProps.onChatVisibleChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("keeps the first prompt visible while project creation is busy but the conversation is not ready", () => {
    const editorProps = props({
      sample: null,
      busy: true,
      conversationStarted: false,
      status: "正在准备工作区…",
    });
    render(<CustomVideoStyleEditor {...editorProps} />);

    expect(screen.getByLabelText("描述想要的风格")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "对话" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
    expect(screen.getByTestId("custom-video-style-chat-content")).toHaveStyle({ display: "none" });
  });

  it("uses the host aspect ratio, exposes simple style fields, and saves only a ready sample", async () => {
    const editorProps = props({
      saveLabel: "保存并使用",
      sample: { html: "<html><body>sample</body></html>", duration: 12 },
      aspectRatio: "16:9",
      onAspectRatioChange: vi.fn(),
    });
    render(<CustomVideoStyleEditor {...editorProps} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "画幅" }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "竖屏（9:16）" }));
    expect(editorProps.onAspectRatioChange).toHaveBeenCalledWith("9:16");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "样式" }), { button: 0, ctrlKey: false });
    fireEvent.change(await screen.findByLabelText("主题色"), { target: { value: "#ff0000" } });
    expect(editorProps.onStyleChange).toHaveBeenCalledWith({ primaryColor: "#ff0000" });
    expect(screen.getByRole("button", { name: "保存并使用" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));
    expect(editorProps.onSave).toHaveBeenCalledOnce();
  });

  it("shows only fields bound by the host and a quiet fallback when none are editable", () => {
    const sample = { html: "<html><body>sample</body></html>", duration: 12 };
    const boundFields = props({ sample, editableFields: ["primaryColor"] });
    const view = render(<CustomVideoStyleEditor {...boundFields} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "样式" }), { button: 0, ctrlKey: false });
    expect(screen.getByLabelText("主题色")).toBeInTheDocument();
    expect(screen.queryByLabelText("背景色")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("字体")).not.toBeInTheDocument();

    view.unmount();
    const noFields = props({ sample, editableFields: [] });
    render(<CustomVideoStyleEditor {...noFields} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "样式" }), { button: 0, ctrlKey: false });
    expect(screen.getByText("可以在对话中说明想调整的样式。"))
      .toBeInTheDocument();
  });

  it("disables editable inputs and selects while generating or saving", () => {
    const editorProps = props({
      sample: { html: "<html><body>sample</body></html>", duration: 12 },
      busy: true,
    });
    const view = render(<CustomVideoStyleEditor {...editorProps} />);

    expect(screen.getByLabelText("风格名称")).toBeDisabled();
    expect(screen.getByRole("button", { name: "画幅" })).toBeDisabled();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "样式" }), { button: 0, ctrlKey: false });
    expect(screen.getByLabelText("主题色")).toBeDisabled();
    expect(screen.getByLabelText("背景色")).toBeDisabled();
    expect(screen.getByRole("button", { name: "字体" })).toBeDisabled();

    view.rerender(<CustomVideoStyleEditor {...editorProps} busy={false} saving backDisabled />);
    expect(screen.getByRole("button", { name: "返回" })).toBeDisabled();
    expect(screen.getByLabelText("风格名称")).toBeDisabled();
    expect(screen.getByLabelText("主题色")).toBeDisabled();
    expect(screen.getByLabelText("背景色")).toBeDisabled();
    expect(screen.getByRole("button", { name: "字体" })).toBeDisabled();
  });

  it("does not offer stop for a short operation without a running task", () => {
    render(<CustomVideoStyleEditor {...props({ busy: true, onStop: undefined })} />);
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  it("forwards pasted and dropped reference images while leaving plain text paste intact", () => {
    const onReferenceFiles = vi.fn();
    const referencePath = "C:\\private\\reference.png";
    const editorProps = props({
      referencePaths: [referencePath],
      referencePreviews: { [referencePath]: "data:image/png;base64,cHJldmlldw==" },
      onReferenceFiles,
    });
    render(<CustomVideoStyleEditor {...editorProps} />);

    expect(screen.getByAltText("")).toHaveAttribute("src", editorProps.referencePreviews?.[referencePath]);
    const description = screen.getByLabelText("描述想要的风格");
    const file = new File(["image"], "pasted.png", { type: "image/png" });
    const textPaste = createEvent.paste(description, {
      clipboardData: { items: [{ kind: "string", type: "text/plain" }] },
    });
    fireEvent(description, textPaste);
    expect(textPaste.defaultPrevented).toBe(false);

    const imagePaste = createEvent.paste(description, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      },
    });
    fireEvent(description, imagePaste);
    expect(imagePaste.defaultPrevented).toBe(true);

    fireEvent.drop(screen.getByRole("region", { name: "参考图" }), {
      dataTransfer: { types: ["Files"], files: [file] },
    });
    expect(onReferenceFiles).toHaveBeenCalledTimes(2);
    expect(onReferenceFiles).toHaveBeenNthCalledWith(1, [file]);
    expect(onReferenceFiles).toHaveBeenNthCalledWith(2, [file]);
  });
});
