/**
 * 沙箱 iframe 的 srcdoc HTML。
 *
 * 安全边界：
 * - iframe 不授予 allow-same-origin（opaque origin，无法访问父页面/存储）。
 * - CSP default-src 'none'：禁止一切网络请求，仅允许内联脚本与 blob: 模块。
 * - three ESM 源码与 OrbitControls 源码由主页面通过 postMessage 注入，沙箱内
 *   创建 blob URL 并动态写入 import map，生成代码同样在沙箱内以 blob 模块加载。
 *
 * 模型工厂契约：生成模块必须导出且仅导出一个匹配 /^create[A-Za-z0-9_]*Model$/
 * 的工厂函数（上游 generate_threejs_factory.py 输出 create<Name>Model）。
 */

export const IFRAME_SANDBOX_ATTR = "allow-scripts";

const BOOTSTRAP = String.raw`
"use strict";
const state = {
  THREE: null, renderer: null, scene: null, camera: null,
  controls: null, model: null, bounds: null, selected: null, grid: null,
};

function reply(type, payload) {
  parent.postMessage({ type, payload: payload || {} }, "*");
}

function moduleUrl(code) {
  return URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
}

function measure() {
  const THREE = state.THREE;
  if (!state.model) return null;
  const box = new THREE.Box3().setFromObject(state.model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    min: box.min.toArray(), max: box.max.toArray(),
    size: size.toArray(), center: center.toArray(),
    radius: Math.max(size.x, size.y, size.z) || 1,
  };
}

function placeCamera(preset) {
  const b = state.bounds;
  const d = (b ? b.radius : 1) * 2.2;
  const c = b ? b.center : [0, 0, 0];
  const pos = {
    front: [c[0], c[1], c[2] + d],
    side: [c[0] + d, c[1], c[2]],
    top: [c[0], c[1] + d, c[2] + 0.001],
    iso: [c[0] + d, c[1] + d, c[2] + d],
  }[preset] || [c[0] + d, c[1] + d, c[2] + d];
  state.camera.position.set(pos[0], pos[1], pos[2]);
  if (state.controls) {
    state.controls.target.set(c[0], c[1], c[2]);
    state.controls.update();
  } else {
    state.camera.lookAt(c[0], c[1], c[2]);
  }
  render();
}

function render() {
  if (state.renderer && state.scene && state.camera) {
    state.renderer.render(state.scene, state.camera);
  }
}

function disposeObject(root) {
  root.traverse((node) => {
    if (node.geometry && node.geometry.dispose) node.geometry.dispose();
    const materials = node.material
      ? (Array.isArray(node.material) ? node.material : [node.material])
      : [];
    for (const material of materials) {
      for (const key of Object.keys(material)) {
        const value = material[key];
        if (value && value.isTexture && value.dispose) value.dispose();
      }
      if (material.dispose) material.dispose();
    }
  });
}

function findFactory(mod) {
  const names = Object.keys(mod);
  const matches = names.filter(
    (n) => /^create[A-Za-z0-9_]*Model$/.test(n) && typeof mod[n] === "function",
  );
  if (matches.length === 1) return { factory: mod[matches[0]], name: matches[0] };
  if (matches.length === 0) {
    throw new Error(
      "model module must export exactly one create<Name>Model() factory; detected exports: "
      + (names.join(", ") || "(none)"),
    );
  }
  throw new Error(
    "model module exports multiple factories (" + matches.join(", ")
    + "); expected exactly one create<Name>Model()",
  );
}

async function handleInit(payload) {
  let threeSource = payload.threeSource;
  if (payload.threeCoreSource) {
    // three r167+ splits the module build: three.module(.min).js re-exports
    // from ./three.core(.min).js. Relative specifiers cannot resolve against a
    // blob URL, so rewrite them to the core blob created in this sandbox.
    const coreUrl = moduleUrl(payload.threeCoreSource);
    threeSource = threeSource.replace(
      /from\s*(["'])\.\/three\.core(\.min)?\.js\1/g,
      'from"' + coreUrl + '"',
    );
  }
  const threeUrl = moduleUrl(threeSource);
  const importMap = document.createElement("script");
  importMap.type = "importmap";
  importMap.textContent = JSON.stringify({ imports: { "three": threeUrl } });
  document.head.appendChild(importMap);
  state.THREE = await import(threeUrl);

  const THREE = state.THREE;
  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color(0x1a1d24);
  state.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  state.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  document.body.appendChild(state.renderer.domElement);

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  state.scene.add(key);
  state.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  state.grid = new THREE.GridHelper(10, 20, 0x334, 0x223);
  state.scene.add(state.grid);

  // OrbitControls ships with the three package (examples/jsm); its only import
  // is the bare specifier "three", which the import map above resolves.
  if (payload.orbitControlsSource) {
    const controlsMod = await import(moduleUrl(payload.orbitControlsSource));
    state.controls = new controlsMod.OrbitControls(state.camera, state.renderer.domElement);
    state.controls.addEventListener("change", render);
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    state.renderer.setSize(w, h, false);
    state.camera.aspect = w / Math.max(h, 1);
    state.camera.updateProjectionMatrix();
    render();
  }
  window.addEventListener("resize", resize);
  resize();
  placeCamera("iso");
  reply("ready");
}

async function handleLoadModel(payload) {
  const mod = await import(moduleUrl(payload.code));
  const found = findFactory(mod);
  const next = found.factory();
  if (!next || !next.isObject3D) {
    throw new Error(found.name + "() must return a THREE.Object3D");
  }
  if (state.model) {
    state.scene.remove(state.model);
    disposeObject(state.model);
  }
  clearSelection();
  state.model = next;
  state.scene.add(next);
  state.bounds = measure();
  placeCamera("iso");
  reply("model-loaded", { bounds: state.bounds, factory: found.name });
}

function clearSelection() {
  if (state.selected && state.selected.material && state.selected.__emissive !== undefined) {
    state.selected.material.emissive.setHex(state.selected.__emissive);
  }
  state.selected = null;
}

const handlers = {
  "init": handleInit,
  "load-model": handleLoadModel,
  "set-camera": (payload) => { placeCamera(payload.camera); reply("camera-set", { camera: payload.camera }); },
  "reset-view": () => { placeCamera("iso"); reply("camera-set", { camera: "iso" }); },
  "set-grid": (payload) => {
    if (state.grid) {
      state.grid.visible = payload.visible !== false;
      render();
    }
    reply("grid-set", { visible: state.grid ? state.grid.visible : false });
  },
  "get-bounds": () => { state.bounds = measure(); reply("bounds", { bounds: state.bounds }); },
  "select-node": (payload) => {
    clearSelection();
    let found = null;
    if (state.model) {
      state.model.traverse((obj) => { if (!found && obj.name === payload.name) found = obj; });
    }
    if (found && found.material && found.material.emissive) {
      found.__emissive = found.material.emissive.getHex();
      found.material.emissive.setHex(0x3366ff);
      state.selected = found;
      render();
    }
    reply("node-selected", { found: !!found });
  },
  "capture-screenshot": () => {
    render();
    reply("screenshot", { dataUrl: state.renderer.domElement.toDataURL("image/png") });
  },
};

window.addEventListener("message", (event) => {
  const msg = event.data || {};
  const handler = handlers[msg.type];
  if (!handler) return;
  Promise.resolve()
    .then(() => handler(msg.payload || {}))
    .catch((err) => reply("error", { message: String((err && err.message) || err), source: msg.type }));
});
`;

export function buildSandboxHtml(): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' blob:; style-src \'unsafe-inline\'; img-src blob: data:; worker-src blob:;">',
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:#1a1d24}canvas{display:block;width:100%;height:100%}</style>",
    "</head>",
    "<body>",
    `<script>${BOOTSTRAP}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
