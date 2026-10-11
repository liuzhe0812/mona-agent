import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ModelEngineDialog } from "./ModelEngineDialog";

const engineOptions = [
  { id: "mona" as const, label: "Mona", supported: true },
  { id: "codex" as const, label: "Codex", supported: true },
  { id: "claude" as const, label: "Claude Code", supported: false, reason: "当前模型不兼容 Claude Code" },
];

const model = {
  id: "qwen3.7-plus",
  name: "千问 3.7-Plus",
  context_window: 983_616,
  input_modalities: ["text", "image"],
  description: "用于内容写作、编程与问题分析。",
};

function renderDialog(onSave = vi.fn().mockResolvedValue(undefined)) {
  const onOpenChange = vi.fn();
  render(
    <ModelEngineDialog
      open
      onOpenChange={onOpenChange}
      model={model}
      providerLabel="阿里云百炼 Coding Plan（包月）"
      engineOptions={engineOptions}
      onSave={onSave}
    />,
  );
  return { onOpenChange, onSave };
}

describe("ModelEngineDialog", () => {
  it("defaults to Mona and shows known model details read-only", () => {
    renderDialog();

    expect(screen.getByRole("heading", { name: model.name })).toBeInTheDocument();
    expect(screen.getByText("阿里云百炼 Coding Plan（包月）")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Mona/ })).toBeChecked();
    expect(screen.getByText("qwen3.7-plus")).toBeInTheDocument();
    expect(screen.getByText("983,616 tokens")).toBeInTheDocument();
    expect(screen.getByText("图片输入").parentElement).toHaveTextContent("支持");
    expect(screen.getByText(model.description)).toBeInTheDocument();
  });

  it("lets the user select and save a supported engine", async () => {
    const { onOpenChange, onSave } = renderDialog();

    fireEvent.click(screen.getByRole("radio", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("codex"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables unsupported engines and explains why", () => {
    renderDialog();

    expect(screen.getByRole("radio", { name: /Claude Code/ })).toBeDisabled();
    expect(screen.getByText("当前模型不兼容 Claude Code")).toBeInTheDocument();
  });

  it("hides backend errors and lets the user retry a failed save", async () => {
    const onSave = vi.fn()
      .mockRejectedValueOnce(new Error("backend stack trace"))
      .mockResolvedValueOnce(undefined);
    const { onOpenChange } = renderDialog(onSave);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("保存失败");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("请重试");
    expect(screen.queryByText("backend stack trace")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
