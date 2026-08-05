import { describe, expect, it } from "vitest";

import { compileModelSource } from "./compileModel";
import { buildSandboxHtml, IFRAME_SANDBOX_ATTR } from "./sandboxHtml";
import {
  ALLOWED_MESSAGE_TYPES,
  buildLoadModelMessage,
  buildSetCameraMessage,
  validateMessage,
} from "./sandboxProtocol";

describe("sandboxProtocol", () => {
  it("defines the fixed message whitelist", () => {
    expect(ALLOWED_MESSAGE_TYPES).toContain("load-model");
    expect(ALLOWED_MESSAGE_TYPES).toContain("set-camera");
    expect(ALLOWED_MESSAGE_TYPES).toContain("get-bounds");
    expect(ALLOWED_MESSAGE_TYPES).toContain("select-node");
    expect(ALLOWED_MESSAGE_TYPES).toContain("capture-screenshot");
  });

  it("rejects unknown message types", () => {
    expect(() => validateMessage({ type: "eval-code", payload: {} })).toThrow(
      /unknown message type/,
    );
  });

  it("accepts a known message type", () => {
    const msg = validateMessage({ type: "load-model", payload: { code: "..." } });
    expect(msg.type).toBe("load-model");
  });

  it("builds a load-model message", () => {
    const msg = buildLoadModelMessage("export function createModel() {}");
    expect(msg).toEqual({
      type: "load-model",
      payload: { code: "export function createModel() {}" },
    });
  });

  it("builds a set-camera message with a fixed camera id", () => {
    const msg = buildSetCameraMessage("iso");
    expect(msg).toEqual({ type: "set-camera", payload: { camera: "iso" } });
  });

  it("rejects a set-camera message with an unknown camera id", () => {
    expect(() => buildSetCameraMessage("free-fly" as never)).toThrow(/unknown camera/);
  });
});

describe("sandboxHtml", () => {
  it("uses a strict CSP that forbids network and storage", () => {
    const html = buildSandboxHtml();
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("allow-same-origin");
  });

  it("never grants the iframe same-origin access", () => {
    expect(IFRAME_SANDBOX_ATTR).not.toContain("allow-same-origin");
    expect(IFRAME_SANDBOX_ATTR).toContain("allow-scripts");
  });

  it("contains an import map placeholder for three", () => {
    const html = buildSandboxHtml();
    expect(html).toContain("importmap");
    expect(html).toContain('"three"');
  });

  it("bootstraps a message listener inside the sandbox", () => {
    const html = buildSandboxHtml();
    expect(html).toContain('addEventListener("message"');
  });

  it("rewrites the split three.core import to an in-sandbox blob", () => {
    const html = buildSandboxHtml();
    expect(html).toContain("threeCoreSource");
    expect(html).toContain("three.core");
  });
});

describe("compileModel", () => {
  it("transpiles a TypeScript model factory to executable JS", () => {
    const ts = [
      "import * as THREE from 'three';",
      "export function createModel(): THREE.Group {",
      "  const root = new THREE.Group();",
      "  root.name = 'Test';",
      "  return root;",
      "}",
    ].join("\n");
    const js = compileModelSource(ts);
    expect(js).toContain("export function createModel()");
    expect(js).not.toContain(": THREE.Group");
    expect(js).toContain("from 'three'");
  });

  it("throws a diagnostic error on syntax-invalid input", () => {
    expect(() => compileModelSource("export function {{{")).toThrow();
  });
});
