export type DockerPermissionMode = "direct" | "sudoNonInteractive";

export interface DockerProbe {
  available: boolean;
  issue: string | null;
  dockerVersion: string | null;
  serverVersion: string | null;
  composeVersion: string | null;
  engineId: string | null;
  endpoint: string | null;
  operatingSystem: string | null;
  architecture: string | null;
  permissionMode: DockerPermissionMode | null;
  podmanAvailable: boolean;
  targetLabel: string;
  probedAt: number;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  mounts: string;
  networks: string;
  createdAt: string;
  runningFor: string;
  size: string;
  command: string;
  composeProject: string | null;
  cpuPercent: string | null;
  memoryUsage: string | null;
  memoryPercent: string | null;
  netIo: string | null;
  blockIo: string | null;
  pids: string | null;
}

export interface DockerSnapshot {
  containers: DockerContainer[];
  capturedAt: number;
  statsAvailable: boolean;
  warnings: string[];
}

export interface DockerMountDetail {
  kind: string;
  source: string;
  destination: string;
  mode: string;
  readOnly: boolean;
}

export interface DockerNetworkDetail {
  name: string;
  ipAddress: string;
  gateway: string;
  macAddress: string;
}

export interface DockerContainerDetail {
  id: string;
  name: string;
  image: string;
  imageId: string;
  createdAt: string;
  platform: string;
  state: string;
  status: string;
  health: string | null;
  exitCode: number;
  oomKilled: boolean;
  restartCount: number;
  error: string;
  startedAt: string;
  finishedAt: string;
  restartPolicy: string;
  privileged: boolean;
  networkMode: string;
  pidMode: string;
  memoryLimit: number;
  cpuQuota: number;
  command: string[];
  environmentNames: string[];
  labelNames: string[];
  mounts: DockerMountDetail[];
  networks: DockerNetworkDetail[];
}

export interface DockerLogsResult {
  stdout: string;
  stderr: string;
  tail: number;
  truncated: boolean;
}

export type DockerContainerAction = "start" | "stop" | "restart" | "remove";

export interface DockerActionResult {
  action: DockerContainerAction;
  containerId: string;
  containerName: string;
  exitCode: number | null;
  durationMs: number;
  verification: string;
}

export interface DockerLogOutputEvent {
  subscriptionId: string;
  sessionId: string;
  containerId: string;
  stream: "stdout" | "stderr";
  data: string;
}

export interface DockerLogEndedEvent {
  subscriptionId: string;
}

export interface ComposeProject {
  name: string;
  status: string;
  configFile: string | null;
  manageable: boolean;
  limitation: string | null;
}

export type DockerResourceKind = "image" | "volume";

export interface DockerImage {
  repository: string;
  tag: string;
  digest: string;
  id: string;
  createdSince: string;
  size: string;
  containers: string;
  sharedSize: string;
  uniqueSize: string;
}

export interface DockerVolume {
  name: string;
  driver: string;
  scope: string;
  mountpoint: string;
  size: string;
  links: string;
}

export interface DockerDiskUsageItem {
  kind: string;
  totalCount: string;
  active: string;
  size: string;
  reclaimable: string;
}

export interface DockerResourceSnapshot {
  images: DockerImage[];
  volumes: DockerVolume[];
  diskUsage: DockerDiskUsageItem[];
  capturedAt: number;
  warnings: string[];
}

export interface DockerResourceRemoveResult {
  kind: DockerResourceKind;
  resourceId: string;
  verification: string;
}

export interface DockerImageUpdate {
  reference: string;
  status: "current" | "updateAvailable" | "unknown";
  localDigests: string[];
  remoteDigest: string | null;
  reason: string | null;
  checkedAt: number;
}

export interface ComposeFileContent {
  path: string;
  resolvedPath: string;
  workingDirectory: string;
  content: string;
  sha256: string;
  size: number;
  permissions: number | null;
  ownerUid: number | null;
  ownerGid: number | null;
  inputFingerprint: string;
  unsupportedFeatures: string[];
}

export interface ComposeValidation {
  valid: boolean;
  error: string | null;
  services: string[];
  images: string[];
}

export type ComposeAction = "pull" | "up" | "stop" | "restart" | "recreate" | "down";

export interface ComposeActionResult {
  action: ComposeAction;
  projectName: string;
  configFile: string;
  exitCode: number | null;
  durationMs: number;
  verification: string;
  output: string;
  outputTruncated: boolean;
}

export interface DockerComposeEvent {
  subscriptionId: string;
  sessionId: string;
  projectName: string;
  stream: "stdout" | "stderr";
  data: string;
}

export interface DockerComposeEventEnded {
  subscriptionId: string;
}

export interface DockerTerminalOutputEvent {
  terminalId: string;
  sessionId: string;
  containerId: string;
  data: string;
}

export interface DockerTerminalEndedEvent {
  terminalId: string;
  exitCode: number | null;
}
