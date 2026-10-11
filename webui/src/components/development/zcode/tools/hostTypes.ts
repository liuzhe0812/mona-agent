export interface MessageFileLinkTarget {
  path: string;
  label: string;
  pathKind?: "file" | "directory";
  relativePath?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

export interface WorkflowRunState {
  status: string;
  stopReason?: string;
}

export interface OpenPlanDetailSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}
