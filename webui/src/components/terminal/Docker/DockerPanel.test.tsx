import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  listContainers: vi.fn(),
  inspect: vi.fn(),
  logs: vi.fn(),
  projects: vi.fn(),
  action: vi.fn(),
  cancel: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  onOutput: vi.fn(),
  onEnded: vi.fn(),
  resources: vi.fn(),
  removeResource: vi.fn(),
  checkUpdate: vi.fn(),
  readCompose: vi.fn(),
}));

vi.mock("./docker-ipc", () => ({
  dockerProbe: mocks.probe,
  dockerListContainers: mocks.listContainers,
  dockerInspectContainer: mocks.inspect,
  dockerContainerLogs: mocks.logs,
  dockerListComposeProjects: mocks.projects,
  dockerContainerAction: mocks.action,
  dockerCancelActiveOperation: mocks.cancel,
  dockerSubscribeLogs: mocks.subscribe,
  dockerUnsubscribeLogs: mocks.unsubscribe,
  onDockerLogOutput: mocks.onOutput,
  onDockerLogEnded: mocks.onEnded,
  dockerListResources: mocks.resources,
  dockerRemoveResource: mocks.removeResource,
  dockerCheckImageUpdate: mocks.checkUpdate,
  dockerReadComposeFile: mocks.readCompose,
}));

vi.mock("./ComposeManager", () => ({
  ComposeManager: ({ project }: { project: { name: string } }) => (
    <div data-testid="compose-manager">{project.name}</div>
  ),
}));

import { DockerPanel } from "./DockerPanel";

const firstContainer = {
  id: "container-1",
  name: "web",
  image: "nginx:latest",
  state: "running",
  status: "Up 2 minutes",
  ports: "0.0.0.0:80->80/tcp",
  mounts: "",
  networks: "demo_default",
  createdAt: "2026-09-12T00:00:00Z",
  runningFor: "2 minutes",
  size: "0B",
  command: "nginx -g daemon off;",
  composeProject: "demo",
  cpuPercent: "1.2%",
  memoryUsage: "1KiB / 2KiB",
  memoryPercent: "50.0%",
  netIo: "1kB / 2kB",
  blockIo: "0B / 0B",
  pids: "1",
};

const secondContainer = {
  ...firstContainer,
  id: "container-2",
  name: "worker",
  state: "exited",
  ports: "",
  composeProject: null,
};

function renderPanel(
  parentStatus: "connected" | "disconnected" = "connected",
  visible = true,
) {
  return render(
    <DockerPanel
      parentSessionId="ssh-session-1"
      parentStatus={parentStatus}
      hostTitle="server-a"
      visible={visible}
    />,
  );
}

describe("DockerPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.probe.mockResolvedValue({
      available: true,
      issue: null,
      dockerVersion: "27.0",
      serverVersion: "27.0",
      composeVersion: "v2.29",
      engineId: "engine-1",
      endpoint: "unix:///var/run/docker.sock",
      operatingSystem: "Ubuntu",
      architecture: "amd64",
      permissionMode: "direct",
      podmanAvailable: false,
      targetLabel: "root@server-a:22",
      probedAt: 1,
    });
    mocks.listContainers.mockResolvedValue({
      capturedAt: 1,
      containers: [firstContainer, secondContainer],
      statsAvailable: true,
      warnings: [],
    });
    mocks.projects.mockResolvedValue([
      {
        name: "demo",
        status: "running",
        configFile: "/srv/demo/compose.yaml",
        manageable: true,
        limitation: null,
      },
    ]);
    mocks.inspect.mockResolvedValue({
      ...firstContainer,
      imageId: "sha256:image",
      createdAt: "2026-09-12T00:00:00Z",
      platform: "linux",
      health: "healthy",
      exitCode: 0,
      oomKilled: false,
      restartCount: 0,
      error: "",
      startedAt: "2026-09-12T00:00:00Z",
      finishedAt: "",
      restartPolicy: "unless-stopped",
      privileged: false,
      networkMode: "demo_default",
      pidMode: "",
      memoryLimit: 2048,
      cpuQuota: 0,
      command: ["nginx", "-g", "daemon off;"],
      environmentNames: ["APP_ENV"],
      labelNames: [],
      mounts: [],
      networks: [{ name: "demo_default", ipAddress: "172.20.0.2", gateway: "172.20.0.1", macAddress: "00:00:00:00:00:01" }],
    });
    mocks.logs.mockResolvedValue({
      stdout: "server ready",
      stderr: "",
      tail: 200,
      truncated: false,
    });
    mocks.action.mockResolvedValue({
      action: "stop",
      containerId: "container-1",
      containerName: "web",
      exitCode: 0,
      durationMs: 100,
      verification: "容器已停止",
    });
    mocks.cancel.mockResolvedValue(true);
    mocks.subscribe.mockResolvedValue("subscription-1");
    mocks.unsubscribe.mockResolvedValue(undefined);
    mocks.onOutput.mockResolvedValue(() => {});
    mocks.onEnded.mockResolvedValue(() => {});
    mocks.resources.mockResolvedValue({ images: [], volumes: [], diskUsage: [], capturedAt: 1, warnings: [] });
    mocks.removeResource.mockResolvedValue({ kind: "image", resourceId: "image-1", verification: "镜像已不存在" });
    mocks.checkUpdate.mockResolvedValue({
      reference: "demo/web:latest",
      status: "current",
      localDigests: ["demo/web@sha256:demo"],
      remoteDigest: "sha256:demo",
      reason: null,
      checkedAt: 1,
    });
    mocks.readCompose.mockResolvedValue({
      path: "/opt/new/compose.yaml",
      resolvedPath: "/opt/new/compose.yaml",
      workingDirectory: "/opt/new",
      content: "services: {}\n",
      sha256: "a".repeat(64),
      inputFingerprint: "f".repeat(64),
      unsupportedFeatures: [],
      size: 13,
      permissions: 420,
    });
  });

  it("loads data for the parent SSH session and filters containers", async () => {
    renderPanel();

    await waitFor(() => expect(mocks.probe).toHaveBeenCalledWith("ssh-session-1"));
    await waitFor(() => expect(screen.getByText("server ready")).toBeTruthy());
    expect(screen.getByTestId("docker-container-container-1")).toBeTruthy();
    expect(screen.getByTestId("docker-container-container-2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "已停止" }));
    expect(screen.queryByTestId("docker-container-container-1")).toBeNull();
    expect(screen.getByTestId("docker-container-container-2")).toBeTruthy();
  });

  it("waits for a successful probe before listing containers or Compose projects", async () => {
    let resolveProbe!: (value: unknown) => void;
    mocks.probe.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );
    renderPanel();

    await Promise.resolve();
    expect(mocks.listContainers).not.toHaveBeenCalled();
    expect(mocks.projects).not.toHaveBeenCalled();

    resolveProbe({
      available: true,
      issue: null,
      dockerVersion: "27.0",
      serverVersion: "27.0",
      composeVersion: "v2.29",
      engineId: "engine-1",
      endpoint: "unix:///var/run/docker.sock",
      operatingSystem: "Ubuntu",
      architecture: "amd64",
      permissionMode: "direct",
      podmanAvailable: false,
      targetLabel: "root@server-a:22",
      probedAt: 1,
    });
    await waitFor(() => expect(mocks.listContainers).toHaveBeenCalledWith("ssh-session-1"));
    expect(mocks.projects).toHaveBeenCalledWith("ssh-session-1");
  });

  it("loads selected container details and recent logs", async () => {
    renderPanel();

    await waitFor(() => expect(mocks.inspect).toHaveBeenCalledWith("ssh-session-1", "container-1"));
    expect(mocks.logs).toHaveBeenCalledWith("ssh-session-1", "container-1", 200);
    expect(screen.getByText("server ready")).toBeTruthy();
    expect(screen.getByText("demo_default")).toBeTruthy();
  });

  it("subscribes to live logs and unsubscribes when returning to recent logs", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("server ready")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "实时" }));
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("ssh-session-1", "container-1", 200));

    fireEvent.click(screen.getByRole("button", { name: "最近" }));
    await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledWith("subscription-1"));
  });

  it("stops polling and unsubscribes live logs when the Docker tab is hidden", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    try {
      const view = renderPanel("connected", true);
      await waitFor(() => expect(setIntervalSpy).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText("server ready")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "实时" }));
      await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("ssh-session-1", "container-1", 200));
      const pollCount = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 5_000).length;

      view.rerender(
        <DockerPanel
          parentSessionId="ssh-session-1"
          parentStatus="connected"
          hostTitle="server-a"
          visible={false}
        />,
      );
      await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledWith("subscription-1"));
      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 5_000)).toHaveLength(pollCount);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("awaits a container action and refreshes the Docker snapshot", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("server ready")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "停止容器" }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith("ssh-session-1", "container-1", "stop"));
    await waitFor(() => expect(mocks.probe).toHaveBeenCalledTimes(2));
    expect(mocks.listContainers).toHaveBeenCalledTimes(2);
  });

  it("loads resources on demand and removes only the selected image", async () => {
    mocks.resources.mockResolvedValueOnce({
      images: [{
        repository: "demo/web",
        tag: "latest",
        digest: "sha256:demo",
        id: "image-1",
        createdSince: "1 day ago",
        size: "20MB",
        containers: "0",
        sharedSize: "0B",
        uniqueSize: "20MB",
      }],
      volumes: [],
      diskUsage: [],
      capturedAt: 1,
      warnings: [],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("server ready")).toBeTruthy());

    fireEvent.mouseDown(screen.getByRole("tab", { name: /镜像与空间/ }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getByRole("tab", { name: /镜像与空间/ })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(mocks.resources).toHaveBeenCalledWith("ssh-session-1"));
    await waitFor(() => expect(screen.getByTestId("docker-images-table")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "检查镜像更新 demo/web:latest" }));
    await waitFor(() => expect(mocks.checkUpdate).toHaveBeenCalledWith("ssh-session-1", "demo/web:latest"));
    fireEvent.click(screen.getByRole("button", { name: "删除镜像 demo/web:latest" }));
    await waitFor(() => expect(mocks.removeResource).toHaveBeenCalledWith("ssh-session-1", "image", "image-1"));
  });

  it("associates one explicitly selected remote Compose file", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("server ready")).toBeTruthy());

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Compose 项目" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "关联 Compose 文件" }));
    fireEvent.change(screen.getByLabelText("远程绝对路径"), {
      target: { value: "/opt/new/compose.yaml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "关联" }));

    await waitFor(() =>
      expect(mocks.readCompose).toHaveBeenCalledWith("ssh-session-1", "/opt/new/compose.yaml"),
    );
    expect(await screen.findByText("/opt/new/compose.yaml")).toBeTruthy();
  });

  it("keeps the last snapshot visible and disables refresh after disconnect", async () => {
    const view = renderPanel();
    await waitFor(() => expect(screen.getByTestId("docker-container-container-1")).toBeTruthy());

    view.rerender(
      <DockerPanel
        parentSessionId="ssh-session-1"
        parentStatus="disconnected"
        hostTitle="server-a"
        visible
      />,
    );

    expect(screen.getByText("SSH 会话已断开")).toBeTruthy();
    expect(screen.getByTestId("docker-container-container-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新 Docker 状态" })).toBeDisabled();
  });
});
