import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThreePreview } from "./ThreePreview";

vi.mock("./threeRaw", () => ({
  threeModuleSource: "//three-module",
  threeCoreSource: "//three-core",
  orbitControlsSource: "//orbit-controls",
}));

const VALID_MODEL_TS = [
  "import * as THREE from 'three';",
  "export function createModel(): THREE.Group {",
  "  return new THREE.Group();",
  "}",
].join("\n");

function getIframe(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("iframe not rendered");
  return iframe;
}

function sandboxReply(iframe: HTMLIFrameElement, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data, source: iframe.contentWindow }),
    );
  });
}

/** Drive the preview into ready state: sandbox ready + model loaded. */
function driveReady(iframe: HTMLIFrameElement) {
  sandboxReply(iframe, { type: "ready", payload: {} });
  sandboxReply(iframe, { type: "model-loaded", payload: { factory: "createModel" } });
}

describe("ThreePreview", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a sandboxed iframe without allow-same-origin", () => {
    const { container } = render(<ThreePreview projectName="p1" />);
    const iframe = getIframe(container);
    expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.srcdoc).toContain("default-src 'none'");
  });

  it("sends init with local three sources once the iframe loads", () => {
    const { container } = render(<ThreePreview projectName="p1" />);
    const iframe = getIframe(container);
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "init",
        payload: {
          threeSource: "//three-module",
          threeCoreSource: "//three-core",
          orbitControlsSource: "//orbit-controls",
        },
      }),
      "*",
    );
  });

  it("compiles and loads the model after the sandbox is ready", () => {
    const { container } = render(<ThreePreview projectName="p1" modelSource={VALID_MODEL_TS} />);
    const iframe = getIframe(container);
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    sandboxReply(iframe, { type: "ready", payload: {} });
    const loadCall = post.mock.calls.find(
      ([msg]) => (msg as { type: string }).type === "load-model",
    );
    expect(loadCall).toBeDefined();
    const code = (loadCall![0] as { payload: { code: string } }).payload.code;
    expect(code).toContain("export function createModel()");
    expect(code).not.toContain(": THREE.Group");
  });

  it("shows a diagnostic when the model source fails to compile", async () => {
    const { container } = render(
      <ThreePreview projectName="p1" modelSource="export function {{{" />,
    );
    const iframe = getIframe(container);
    fireEvent.load(iframe);
    sandboxReply(iframe, { type: "ready", payload: {} });
    await waitFor(() => expect(screen.getByText(/compile failed/i)).toBeTruthy());
  });

  it("disables camera and screenshot actions until a model is ready", () => {
    const { container } = render(<ThreePreview projectName="p1" modelSource={VALID_MODEL_TS} />);
    const iframe = getIframe(container);
    fireEvent.load(iframe);
    // 沙箱未就绪：全部禁用
    expect(screen.getByRole("button", { name: "正视" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "截图" })).toHaveProperty("disabled", true);
    sandboxReply(iframe, { type: "ready", payload: {} });
    // 沙箱就绪但模型未加载完成：仍禁用
    expect(screen.getByRole("button", { name: "正视" })).toHaveProperty("disabled", true);
    sandboxReply(iframe, { type: "model-loaded", payload: { factory: "createModel" } });
    expect(screen.getByRole("button", { name: "正视" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "截图" })).toHaveProperty("disabled", false);
  });

  it("sends set-camera when a camera button is clicked", () => {
    const { container } = render(<ThreePreview projectName="p1" modelSource={VALID_MODEL_TS} />);
    const iframe = getIframe(container);
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    driveReady(iframe);
    fireEvent.click(screen.getByRole("button", { name: "正视" }));
    expect(post).toHaveBeenCalledWith(
      { type: "set-camera", payload: { camera: "front" } },
      "*",
    );
  });

  it("sends reset-view and set-grid messages", () => {
    const { container } = render(<ThreePreview projectName="p1" modelSource={VALID_MODEL_TS} />);
    const iframe = getIframe(container);
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    driveReady(iframe);
    fireEvent.click(screen.getByRole("button", { name: "重置视图" }));
    expect(post).toHaveBeenCalledWith({ type: "reset-view", payload: {} }, "*");
    fireEvent.click(screen.getByRole("button", { name: "网格" }));
    expect(post).toHaveBeenCalledWith({ type: "set-grid", payload: { visible: false } }, "*");
  });

  it("saves sandbox screenshots to the project renders dir", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, path: "/tmp/render-1.png" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRenderSaved = vi.fn();
    const { container } = render(
      <ThreePreview projectName="p1" modelSource={VALID_MODEL_TS} onRenderSaved={onRenderSaved} />,
    );
    const iframe = getIframe(container);
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    driveReady(iframe);

    fireEvent.click(screen.getByRole("button", { name: "截图" }));
    expect(post).toHaveBeenCalledWith({ type: "capture-screenshot", payload: {} }, "*");

    sandboxReply(iframe, {
      type: "screenshot",
      payload: { dataUrl: "data:image/png;base64,AAAA" },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/three/project/action");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "p1",
      action: "save-render",
      dataUrl: "data:image/png;base64,AAAA",
    });
    await waitFor(() => expect(onRenderSaved).toHaveBeenCalledWith("/tmp/render-1.png"));
  });

  it("ignores messages from other windows", () => {
    const { container } = render(<ThreePreview projectName="p1" modelSource={VALID_MODEL_TS} />);
    const iframe = getIframe(container);
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    post.mockClear();
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "ready", payload: {} }, source: window }),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("strips three/examples/jsm/* imports and stubs identifiers", () => {
    const MODEL_WITH_EXAMPLES = [
      "import * as THREE from 'three';",
      "import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';",
      "import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';",
      "import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';",
      "import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';",
      "import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';",
      "import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';",
      "",
      "export function createKnifeModel(): THREE.Group {",
      "  const root = new THREE.Group();",
      "  root.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial()));",
      "  return root;",
      "}",
      "",
      "export function createKnifeEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {",
      "  const pmrem = new THREE.PMREMGenerator(renderer);",
      "  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;",
      "  pmrem.dispose();",
      "  return texture;",
      "}",
    ].join("\n");

    const { container } = render(<ThreePreview projectName="p1" modelSource={MODEL_WITH_EXAMPLES} />);
    const iframe = getIframe(container);
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    sandboxReply(iframe, { type: "ready", payload: {} });

    const loadCall = post.mock.calls.find(
      ([msg]) => (msg as { type: string }).type === "load-model",
    );
    expect(loadCall).toBeDefined();
    const code = (loadCall![0] as { payload: { code: string } }).payload.code;

    // three/examples/jsm/* imports must be fully stripped
    expect(code).not.toContain("three/examples/");
    expect(code).not.toContain("RoomEnvironment.js");
    expect(code).not.toContain("EffectComposer.js");

    // Stub declarations must be present so the module loads
    expect(code).toContain("var RoomEnvironment");
    expect(code).toContain("var EffectComposer");
    expect(code).toContain("var RenderPass");
    expect(code).toContain("var BokehPass");
    expect(code).toContain("var UnrealBloomPass");
    expect(code).toContain("var OrbitControls");

    // Factory function must survive compilation intact
    expect(code).toContain("createKnifeModel");
  });
});
