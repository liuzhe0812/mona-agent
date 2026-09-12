import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  validate: vi.fn(),
  save: vi.fn(),
  action: vi.fn(),
  cancel: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  onEvent: vi.fn(),
  onEnded: vi.fn(),
}));

vi.mock("./docker-ipc", () => ({
  dockerReadComposeFile: mocks.read,
  dockerValidateComposeFile: mocks.validate,
  dockerSaveComposeFile: mocks.save,
  dockerComposeAction: mocks.action,
  dockerCancelActiveOperation: mocks.cancel,
  dockerSubscribeComposeEvents: mocks.subscribe,
  dockerUnsubscribeStream: mocks.unsubscribe,
  onDockerComposeEvent: mocks.onEvent,
  onDockerComposeEventEnded: mocks.onEnded,
}));

import { ComposeManager } from "./ComposeManager";

const project = {
  name: "demo",
  status: "running",
  configFile: "/srv/demo/compose.yaml",
  manageable: true,
  limitation: null,
};

const file = {
  path: "/srv/demo/compose.yaml",
  resolvedPath: "/srv/demo/compose.yaml",
  workingDirectory: "/srv/demo",
  content: "services:\n  web:\n    image: nginx:latest\n",
  sha256: "a".repeat(64),
  inputFingerprint: "f".repeat(64),
  unsupportedFeatures: [],
  size: 42,
  permissions: 0o644,
};

function renderManager(onChanged = vi.fn(), visible = true) {
  return render(
    <ComposeManager
      parentSessionId="ssh-session-1"
      project={project}
      connected
      visible={visible}
      onChanged={onChanged}
    />,
  );
}

describe("ComposeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockResolvedValue(file);
    mocks.validate.mockResolvedValue({ valid: true, error: null, services: ["web"], images: ["nginx:latest"] });
    mocks.save.mockResolvedValue({ ...file, content: "services:\n  web:\n    image: nginx:1.27\n", size: 40, sha256: "b".repeat(64) });
    mocks.action.mockResolvedValue({
      action: "pull",
      projectName: "demo",
      configFile: file.resolvedPath,
      exitCode: 0,
      durationMs: 120,
      verification: "镜像拉取完成",
      output: "Pulled",
      outputTruncated: false,
    });
    mocks.cancel.mockResolvedValue(true);
    mocks.subscribe.mockResolvedValue("compose-sub-1");
    mocks.unsubscribe.mockResolvedValue(undefined);
    mocks.onEvent.mockResolvedValue(() => {});
    mocks.onEnded.mockResolvedValue(() => {});
  });

  it("reads, validates, and saves the selected Compose file with its hash", async () => {
    const onChanged = vi.fn();
    renderManager(onChanged);

    await waitFor(() => expect(mocks.read).toHaveBeenCalledWith("ssh-session-1", project.configFile));
    const editor = screen.getByRole("textbox", { name: "Compose YAML" });
    fireEvent.change(editor, { target: { value: "services:\n  web:\n    image: nginx:1.27\n" } });

    fireEvent.click(screen.getByRole("button", { name: "校验" }));
    await waitFor(() => expect(mocks.validate).toHaveBeenCalledWith("ssh-session-1", file.resolvedPath, "services:\n  web:\n    image: nginx:1.27\n"));

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(
      "ssh-session-1",
      file.resolvedPath,
      file.sha256,
      file.inputFingerprint,
      "services:\n  web:\n    image: nginx:1.27\n",
    ));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("calls pull and reports the verified operation result", async () => {
    const onChanged = vi.fn();
    renderManager(onChanged);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Compose YAML" })).toHaveValue(file.content));

    fireEvent.click(screen.getByRole("button", { name: "Compose 拉取镜像" }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith(
      "ssh-session-1",
      file.resolvedPath,
      file.sha256,
      file.inputFingerprint,
      "demo",
      "pull",
    ));
    expect(await screen.findByText("镜像拉取完成")).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("cancels the active Compose maintenance operation", async () => {
    let finishAction!: (value: unknown) => void;
    mocks.action.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishAction = resolve;
      }),
    );
    renderManager();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Compose YAML" })).toHaveValue(file.content));

    fireEvent.click(screen.getByRole("button", { name: "Compose 拉取镜像" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消操作" }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith("ssh-session-1"));

    await act(async () => {
      finishAction({
        action: "pull",
        projectName: "demo",
        configFile: file.resolvedPath,
        exitCode: null,
        durationMs: 1,
        verification: "",
        output: "",
        outputTruncated: false,
      });
    });
  });

  it("unsubscribes Compose events when hidden and does not start another subscription", async () => {
    const view = renderManager();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Compose YAML" })).toHaveValue(file.content));

    fireEvent.click(screen.getByRole("button", { name: "监听事件" }));
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("ssh-session-1", file.resolvedPath, "demo"));

    view.rerender(
      <ComposeManager
        parentSessionId="ssh-session-1"
        project={project}
        connected
        visible={false}
      />,
    );
    await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledWith("compose-sub-1"));

    const subscriptionCalls = mocks.subscribe.mock.calls.length;
    view.rerender(
      <ComposeManager
        parentSessionId="ssh-session-1"
        project={project}
        connected
        visible={false}
      />,
    );
    expect(mocks.subscribe).toHaveBeenCalledTimes(subscriptionCalls);
  });

  it("does not read the Compose file until the Docker tab is visible", async () => {
    const view = renderManager(vi.fn(), false);
    await Promise.resolve();
    expect(mocks.read).not.toHaveBeenCalled();

    view.rerender(
      <ComposeManager
        parentSessionId="ssh-session-1"
        project={project}
        connected
        visible
      />,
    );
    await waitFor(() => expect(mocks.read).toHaveBeenCalledWith("ssh-session-1", project.configFile));
  });

  it("keeps unsupported Compose inputs read-only", async () => {
    mocks.read.mockResolvedValueOnce({ ...file, unsupportedFeatures: ["profiles"] });
    renderManager();

    expect(await screen.findByText(/profiles/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Compose YAML" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Compose 启动" })).toBeDisabled();
  });
});
