import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  ComposeProject,
  ComposeAction,
  ComposeActionResult,
  ComposeFileContent,
  ComposeValidation,
  DockerActionResult,
  DockerContainerAction,
  DockerContainerDetail,
  DockerLogEndedEvent,
  DockerLogOutputEvent,
  DockerLogsResult,
  DockerTerminalEndedEvent,
  DockerTerminalOutputEvent,
  DockerComposeEvent,
  DockerComposeEventEnded,
  DockerProbe,
  DockerResourceKind,
  DockerImageUpdate,
  DockerResourceRemoveResult,
  DockerResourceSnapshot,
  DockerSnapshot,
} from "./types";

export function dockerProbe(sessionId: string): Promise<DockerProbe> {
  return invoke<DockerProbe>("docker_probe", { sessionId });
}

export function dockerListContainers(sessionId: string): Promise<DockerSnapshot> {
  return invoke<DockerSnapshot>("docker_list_containers", { sessionId });
}

export function dockerInspectContainer(
  sessionId: string,
  containerId: string,
): Promise<DockerContainerDetail> {
  return invoke<DockerContainerDetail>("docker_inspect_container", {
    sessionId,
    containerId,
  });
}

export function dockerContainerLogs(
  sessionId: string,
  containerId: string,
  tail: number,
): Promise<DockerLogsResult> {
  return invoke<DockerLogsResult>("docker_container_logs", {
    sessionId,
    containerId,
    tail,
  });
}

export function dockerContainerAction(
  sessionId: string,
  containerId: string,
  action: DockerContainerAction,
): Promise<DockerActionResult> {
  return invoke<DockerActionResult>("docker_container_action", {
    sessionId,
    containerId,
    action,
  });
}

export function dockerSubscribeLogs(
  sessionId: string,
  containerId: string,
  tail = 200,
): Promise<string> {
  return invoke<string>("docker_subscribe_logs", { sessionId, containerId, tail });
}

export function dockerUnsubscribeLogs(subscriptionId: string): Promise<void> {
  return invoke("docker_unsubscribe_logs", { subscriptionId });
}

export function onDockerLogOutput(
  handler: (event: DockerLogOutputEvent) => void,
): Promise<() => void> {
  return listen<DockerLogOutputEvent>("docker-log-output", (event) => handler(event.payload));
}

export function onDockerLogEnded(
  handler: (event: DockerLogEndedEvent) => void,
): Promise<() => void> {
  return listen<DockerLogEndedEvent>("docker-log-ended", (event) => handler(event.payload));
}

export function dockerListResources(sessionId: string): Promise<DockerResourceSnapshot> {
  return invoke<DockerResourceSnapshot>("docker_list_resources", { sessionId });
}

export function dockerCheckImageUpdate(
  sessionId: string,
  imageReference: string,
): Promise<DockerImageUpdate> {
  return invoke<DockerImageUpdate>("docker_check_image_update", {
    sessionId,
    imageReference,
  });
}

export function dockerRemoveResource(
  sessionId: string,
  kind: DockerResourceKind,
  resourceId: string,
): Promise<DockerResourceRemoveResult> {
  return invoke<DockerResourceRemoveResult>("docker_remove_resource", {
    sessionId,
    kind,
    resourceId,
  });
}

export async function dockerCancelActiveOperation(sessionId: string): Promise<boolean> {
  const active = await invoke<{ task: { id: string } } | null>(
    "terminal_maintenance_get_active",
    { sessionId },
  );
  if (!active) return false;
  await invoke("terminal_maintenance_cancel", { taskId: active.task.id });
  return true;
}

export function dockerListComposeProjects(sessionId: string): Promise<ComposeProject[]> {
  return invoke<ComposeProject[]>("docker_list_compose_projects", { sessionId });
}

export function dockerReadComposeFile(sessionId: string, path: string): Promise<ComposeFileContent> {
  return invoke<ComposeFileContent>("docker_read_compose_file", { sessionId, path });
}

export function dockerValidateComposeFile(
  sessionId: string,
  path: string,
  content: string,
): Promise<ComposeValidation> {
  return invoke<ComposeValidation>("docker_validate_compose_file", { sessionId, path, content });
}

export function dockerSaveComposeFile(
  sessionId: string,
  path: string,
  expectedSha256: string,
  expectedInputFingerprint: string,
  content: string,
): Promise<ComposeFileContent> {
  return invoke<ComposeFileContent>("docker_save_compose_file", {
    sessionId,
    path,
    expectedSha256,
    expectedInputFingerprint,
    content,
  });
}

export function dockerComposeAction(
  sessionId: string,
  configFile: string,
  expectedSha256: string,
  expectedInputFingerprint: string,
  projectName: string,
  action: ComposeAction,
): Promise<ComposeActionResult> {
  return invoke<ComposeActionResult>("docker_compose_action", {
    sessionId,
    configFile,
    expectedSha256,
    expectedInputFingerprint,
    projectName,
    action,
  });
}

export function dockerSubscribeComposeEvents(
  sessionId: string,
  configFile: string,
  projectName: string,
): Promise<string> {
  return invoke<string>("docker_subscribe_compose_events", {
    sessionId,
    configFile,
    projectName,
  });
}

export function dockerUnsubscribeStream(subscriptionId: string): Promise<void> {
  return invoke("docker_unsubscribe_stream", { subscriptionId });
}

export function onDockerComposeEvent(
  handler: (event: DockerComposeEvent) => void,
): Promise<() => void> {
  return listen<DockerComposeEvent>("docker-compose-event", (event) => handler(event.payload));
}

export function onDockerComposeEventEnded(
  handler: (event: DockerComposeEventEnded) => void,
): Promise<() => void> {
  return listen<DockerComposeEventEnded>("docker-compose-event-ended", (event) => handler(event.payload));
}

export function dockerOpenContainerTerminal(
  sessionId: string,
  containerId: string,
  cols: number,
  rows: number,
): Promise<string> {
  return invoke<string>("docker_open_container_terminal", { sessionId, containerId, cols, rows });
}

export function dockerWriteContainerTerminal(terminalId: string, data: string): Promise<void> {
  return invoke("docker_write_container_terminal", { terminalId, data });
}

export function dockerResizeContainerTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke("docker_resize_container_terminal", { terminalId, cols, rows });
}

export function dockerCloseContainerTerminal(terminalId: string): Promise<void> {
  return invoke("docker_close_container_terminal", { terminalId });
}

export function onDockerTerminalOutput(
  handler: (event: DockerTerminalOutputEvent) => void,
): Promise<() => void> {
  return listen<DockerTerminalOutputEvent>("docker-terminal-output", (event) => handler(event.payload));
}

export function onDockerTerminalEnded(
  handler: (event: DockerTerminalEndedEvent) => void,
): Promise<() => void> {
  return listen<DockerTerminalEndedEvent>("docker-terminal-ended", (event) => handler(event.payload));
}
