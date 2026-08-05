/**
 * 3D 预览沙箱消息协议（主页面 → 沙箱 iframe）。
 * 与 mona/api/three_preview.py 中的白名单保持一致。
 */

export const ALLOWED_MESSAGE_TYPES = [
  "load-model",
  "set-camera",
  "reset-view",
  "set-grid",
  "get-bounds",
  "select-node",
  "capture-screenshot",
] as const;

export type SandboxMessageType = (typeof ALLOWED_MESSAGE_TYPES)[number];

export interface SandboxMessage {
  type: SandboxMessageType;
  payload: Record<string, unknown>;
}

/** 沙箱 → 主页面的回执消息类型。 */
export const SANDBOX_REPLY_TYPES = [
  "ready",
  "model-loaded",
  "camera-set",
  "grid-set",
  "bounds",
  "node-selected",
  "screenshot",
  "error",
] as const;

export type SandboxReplyType = (typeof SANDBOX_REPLY_TYPES)[number];

export interface SandboxReply {
  type: SandboxReplyType;
  payload: Record<string, unknown>;
}

export const FIXED_CAMERAS = ["front", "side", "top", "iso"] as const;
export type FixedCamera = (typeof FIXED_CAMERAS)[number];

export function validateMessage(msg: { type: string; payload?: Record<string, unknown> }): SandboxMessage {
  if (!(ALLOWED_MESSAGE_TYPES as readonly string[]).includes(msg.type)) {
    throw new Error(`unknown message type: ${msg.type}`);
  }
  return { type: msg.type as SandboxMessageType, payload: msg.payload ?? {} };
}

export function buildLoadModelMessage(code: string): SandboxMessage {
  return { type: "load-model", payload: { code } };
}

export function buildSetCameraMessage(camera: FixedCamera): SandboxMessage {
  if (!(FIXED_CAMERAS as readonly string[]).includes(camera)) {
    throw new Error(`unknown camera: ${camera}`);
  }
  return { type: "set-camera", payload: { camera } };
}

export function buildResetViewMessage(): SandboxMessage {
  return { type: "reset-view", payload: {} };
}

export function buildSetGridMessage(visible: boolean): SandboxMessage {
  return { type: "set-grid", payload: { visible } };
}
