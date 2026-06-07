export type AppType = "fileManager" | "taskManager" | "terminal" | "textEditor" | "recycleBin" | null;

export interface WindowState {
  id: string;
  type: AppType;
  title: string;
  isMinimized: boolean;
  isMaximized: boolean;
  zIndex: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  data?: Record<string, unknown>;
}

export interface DesktopIcon {
  id: string;
  name: string;
  icon: string;
  appType: AppType;
}
