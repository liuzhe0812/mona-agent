/** Shared geometry and internal handle-ID helpers for fractional flowchart ports. */

export const FLOWCHART_DEFAULT_PORT = 0.5;
export const FLOWCHART_MIN_PORT = 0.05;
export const FLOWCHART_MAX_PORT = 0.95;

export type FlowchartPortSide = "top" | "bottom" | "left" | "right";
export type FlowchartPortRole = "source" | "target";

/** A dynamic handle rendered only when an edge references a non-default port. */
export interface FlowchartPortDescriptor {
  handle: string;
  port: number;
}

export interface DecodedFlowchartHandleId {
  /** The document handle, without the internal fractional suffix. */
  handle?: string;
  /** The internal fractional port, when the ID contains a valid suffix. */
  port?: number;
}

export function isFlowchartPort(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= FLOWCHART_MIN_PORT
    && value <= FLOWCHART_MAX_PORT;
}

/**
 * React Flow IDs carry a fractional port only for rendering, for example
 * `left-source:0.3`. Document handles remain `left-source` and keep the
 * fraction in FlowchartEdge.sourcePort/targetPort.
 */
export function encodeFlowchartHandleId(handle: string | undefined, port: number | undefined): string | undefined {
  if (!handle) return undefined;
  if (!isFlowchartPort(port) || port === FLOWCHART_DEFAULT_PORT) return handle;
  return `${handle}:${String(port)}`;
}

export function decodeFlowchartHandleId(handle: string | null | undefined): DecodedFlowchartHandleId {
  if (!handle) return {};
  const separator = handle.lastIndexOf(":");
  if (separator <= 0) return { handle };
  const port = Number(handle.slice(separator + 1));
  if (!isFlowchartPort(port)) return { handle };
  return { handle: handle.slice(0, separator), port };
}

export function flowchartHandleSide(
  handle: string | undefined,
  fallback: FlowchartPortRole,
): FlowchartPortSide {
  const base = decodeFlowchartHandleId(handle).handle;
  const side = base?.split("-")[0];
  if (side === "top" || side === "bottom" || side === "left" || side === "right") return side;
  return fallback === "source" ? "bottom" : "top";
}

/**
 * Resolve a node-box point for a handle and a 0..1 fractional port.
 * An omitted port is centered. An omitted source/target handle defaults to
 * the bottom/top side respectively; callers can pass a direction-specific
 * default handle when rendering LR diagrams.
 */
export function flowchartPortPoint(
  box: { x: number; y: number; width: number; height: number },
  handle: string | undefined,
  port: number | undefined,
  fallback: FlowchartPortRole,
): { x: number; y: number } {
  const ratio = isFlowchartPort(port)
    ? port
    : decodeFlowchartHandleId(handle).port ?? FLOWCHART_DEFAULT_PORT;
  const side = flowchartHandleSide(handle, fallback);
  if (side === "top") return { x: box.x + box.width * ratio, y: box.y };
  if (side === "bottom") return { x: box.x + box.width * ratio, y: box.y + box.height };
  if (side === "left") return { x: box.x, y: box.y + box.height * ratio };
  return { x: box.x + box.width, y: box.y + box.height * ratio };
}
