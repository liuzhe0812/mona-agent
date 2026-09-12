import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  dockerCancelActiveOperation,
  dockerContainerLogs,
  dockerInspectContainer,
  dockerListComposeProjects,
  dockerListContainers,
  dockerProbe,
} from "./docker-ipc";

describe("Docker IPC contract", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
  });

  it("uses the typed Tauri command names and camelCase arguments", async () => {
    await dockerProbe("ssh-1");
    await dockerListContainers("ssh-1");
    await dockerInspectContainer("ssh-1", "container-1");
    await dockerContainerLogs("ssh-1", "container-1", 200);
    await dockerListComposeProjects("ssh-1");
    invoke.mockResolvedValueOnce({ task: { id: "task-1" } });
    await dockerCancelActiveOperation("ssh-1");

    expect(invoke.mock.calls).toEqual([
      ["docker_probe", { sessionId: "ssh-1" }],
      ["docker_list_containers", { sessionId: "ssh-1" }],
      ["docker_inspect_container", { sessionId: "ssh-1", containerId: "container-1" }],
      ["docker_container_logs", { sessionId: "ssh-1", containerId: "container-1", tail: 200 }],
      ["docker_list_compose_projects", { sessionId: "ssh-1" }],
      ["terminal_maintenance_get_active", { sessionId: "ssh-1" }],
      ["terminal_maintenance_cancel", { taskId: "task-1" }],
    ]);
  });
});
