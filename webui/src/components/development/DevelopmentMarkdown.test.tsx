import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectFileLink } from "@/components/markdown/MarkdownMedia";
import { developmentApi, type DevProject } from "@/lib/development-api";
import { DevelopmentMarkdown } from "./DevelopmentMarkdown";
import { DevelopmentTranscript } from "./DevelopmentTranscript";
import { fileKey, useDevelopmentStore } from "./store";

afterEach(() => { cleanup(); vi.restoreAllMocks(); useDevelopmentStore.setState({ files: {}, sides: {}, selectedFiles: {} }); });
const project: DevProject = { id: "project", rootPath: "D:/project", displayName: "project", lastOpenedAt: "" };

it("keeps a generated image visible after the completed work folds and reads it through the owning project", async () => {
  const reference = `mona-media:sha256-${"a".repeat(64)}.png`;
  const read = vi.spyOn(developmentApi, "media").mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:generated-image");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const common = { runId: "run_image", toolCalls: [], truncated: false, queued: false };
  const view = render(<DevelopmentMarkdown project={project} sessionId="parent"><DevelopmentTranscript
    messages={[
      { ...common, id: "request", role: "user", content: "生成一张机器人图片" },
      { ...common, id: "image", role: "assistant", content: "", media: [{ kind: "image", url: reference, name: "生成的图片" }] },
      { ...common, id: "answer", role: "assistant", content: "已生成机器人图片。" },
    ]}
    events={[
      { id: "image_started", sequence: 1, runId: common.runId, type: "tool.started", payload: { itemId: "generated", kind: "imageGeneration", status: "inProgress" } },
      { id: "image_done", sequence: 2, runId: common.runId, type: "tool.completed", payload: { itemId: "generated", kind: "imageGeneration", status: "completed", messageId: "image" } },
      { id: "answer_done", sequence: 3, runId: common.runId, type: "agent.message.completed", payload: { messageId: "answer" } },
    ]}
    runs={[{ id: common.runId, sessionId: "parent", executor: "codex", status: "succeeded", revision: 1, createdAt: "2026-10-09T00:00:00Z", resultMessageId: "answer" }]}
    sessionId="parent" /></DevelopmentMarkdown>);
  expect(await screen.findByRole("img", { name: "生成的图片" })).toBeVisible();
  expect(screen.getByRole("img", { name: "生成的图片" })).toHaveAttribute("src", "blob:generated-image");
  expect(read).toHaveBeenCalledWith(project.id, reference);
  expect(screen.getByText("已生成机器人图片。")).toBeVisible();
  view.unmount();
  expect(revoke).toHaveBeenCalledWith("blob:generated-image");
});

it("opens a project reference in the owning workbench without replacing a dirty buffer", async () => {
  const read = vi.spyOn(developmentApi, "file");
  useDevelopmentStore.getState().loadFile("parent", { path: "src/main.ts", content: "original", sha256: "sha", bom: false });
  useDevelopmentStore.getState().editFile("parent", "src/main.ts", "unsaved");
  render(<DevelopmentMarkdown project={project} sessionId="parent"><ProjectFileLink path="D:/project/src/main.ts">源码</ProjectFileLink></DevelopmentMarkdown>);
  fireEvent.click(screen.getByRole("button", { name: "源码" }));
  await waitFor(() => expect(useDevelopmentStore.getState().sides.parent.tab).toBe("workspace"));
  expect(useDevelopmentStore.getState().files[fileKey("parent", "src/main.ts")].draft).toBe("unsaved");
  expect(useDevelopmentStore.getState().selectedFiles.parent).toBe("src/main.ts");
  expect(read).not.toHaveBeenCalled();
});

it("preserves a buffer edited while the file request was in flight", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof developmentApi.file>>) => void;
  vi.spyOn(developmentApi, "file").mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<DevelopmentMarkdown project={project} sessionId="parent"><ProjectFileLink path="src/main.ts">源码</ProjectFileLink></DevelopmentMarkdown>);
  fireEvent.click(screen.getByRole("button", { name: "源码" }));
  const file = { path: "src/main.ts", content: "original", sha256: "sha", bom: false };
  useDevelopmentStore.getState().loadFile("parent", file);
  useDevelopmentStore.getState().editFile("parent", file.path, "new draft");
  resolve(file);
  await waitFor(() => expect(useDevelopmentStore.getState().sides.parent.tab).toBe("workspace"));
  expect(useDevelopmentStore.getState().files[fileKey("parent", file.path)].draft).toBe("new draft");
});
