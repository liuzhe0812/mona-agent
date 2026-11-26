import { CubismFramework } from "@live2d/framework/src/live2dcubismframework";
import { CubismModelSettingJson } from "@live2d/framework/src/cubismmodelsettingjson";
import { CubismUserModel } from "@live2d/framework/src/model/cubismusermodel";
import { CubismMatrix44 } from "@live2d/framework/src/math/cubismmatrix44";
import { CubismRenderer_WebGL } from "@live2d/framework/src/rendering/cubismrenderer_webgl";
import { CubismShaderManager_WebGL } from "@live2d/framework/src/rendering/cubismshader_webgl";
import { resolveBindings, parameterValues } from "../../mona_interaction/web/parameter-bindings.js";
import { registeredCanvasMatrix } from "./registered-canvas.js";

let frameworkUsers = 0;

const SHADERS = [
  'vertshadersrc.vert', 'vertshadersrcmasked.vert', 'vertshadersrcsetupmask.vert',
  'fragshadersrcsetupmask.frag', 'fragshadersrcpremultipliedalpha.frag',
  'fragshadersrcmaskpremultipliedalpha.frag', 'fragshadersrcmaskinvertedpremultipliedalpha.frag',
  'vertshadersrccopy.vert', 'fragshadersrccopy.frag', 'fragshadersrccolorblend.frag',
  'fragshadersrcalphablend.frag', 'vertshadersrcblend.vert', 'fragshadersrcpremultipliedalphablend.frag',
];

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
}

async function bytes(url, signal) {
  const response = await fetch(url, { credentials: "same-origin", redirect: "error", signal });
  if (!response.ok) throw new Error("Character resource unavailable");
  const data = await response.arrayBuffer();
  checkAbort(signal);
  return data;
}

async function prepareShaders(renderer, gl, signal) {
  const sources = new Map(await Promise.all(SHADERS.map(async (name) => {
    const response = await fetch(`/vendor/shaders/${name}`, { credentials: 'same-origin', redirect: 'error', signal });
    if (!response.ok) throw new Error('Character shader unavailable');
    const source = await response.text();
    if (!source.trim() || /^\s*(?:<!doctype|<html)/i.test(source)) throw new Error('Character shader invalid');
    return [name, source];
  })));
  checkAbort(signal);
  const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
  if (!shader) throw new Error('Character shader unavailable');
  // The pinned Framework's loader otherwise fetches asynchronously without
  // checking HTTP errors. Supply already-validated, local shader sources.
  shader.loadShader = async (url) => {
    const name = url.slice(url.lastIndexOf('/') + 1);
    if (!sources.has(name)) throw new Error('Character shader unavailable');
    return sources.get(name);
  };
  renderer.loadShaders('/vendor/shaders/');
  // The Framework compiles after asynchronous source loading; do not report
  // the character ready until those microtasks have finished.
  for (let attempt = 0; attempt < 10 && shader._isShaderLoading; attempt += 1) {
    await Promise.resolve();
  }
  checkAbort(signal);
  if (!shader._isShaderLoaded || !shader._shaderSets.slice(0, 11).every((set) =>
    set?.shaderProgram && gl.getProgramParameter(set.shaderProgram, gl.LINK_STATUS))) {
    throw new Error('Character shader failed to compile');
  }
}

class CharacterModel extends CubismUserModel {
  updateParameters(deltaSeconds, values) {
    this._model.loadParameters();
    for (const { index, value } of values) this._model.setParameterValueByIndex(index, value);
    this._physics?.evaluate(this._model, deltaSeconds);
    this._pose?.updateParameters(this._model, deltaSeconds);
    this._model.update();
  }
}

export class CubismCharacter {
  static async create(canvas, config) {
    const character = new CubismCharacter(canvas);
    try {
      await character.load(config);
      return character;
    } catch (error) {
      character.dispose();
      throw error;
    }
  }

  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!this.gl) throw new Error("WebGL2 unavailable");
    if (frameworkUsers === 0) {
      // No log callback is needed. Core allocates a wasm function pointer each
      // time one is registered, including after a Framework cleanup.
      if (!CubismFramework.startUp()) throw new Error("Cubism startup failed");
      CubismFramework.initialize();
    }
    frameworkUsers += 1;
    this.textures = [];
    this.model = new CharacterModel();
  }

  async load(config) {
    if (config.projection !== undefined && config.projection !== "fit" && config.projection !== "registered") {
      throw new TypeError("Invalid character projection");
    }
    const signal = config.signal;
    checkAbort(signal);
    const settingsBytes = await bytes(config.model_url, signal);
    const settings = new CubismModelSettingJson(settingsBytes, settingsBytes.byteLength);
    const resource = (name) => new URL(name, new URL(config.model_url, location.origin));
    try {
      this.model.loadModel(await bytes(resource(settings.getModelFileName()), signal), true);
      const model = this.model.getModel();
      if (!model) throw new Error("Cubism model rejected");
      this.registeredProjection = config.projection === "registered"
        ? registeredCanvasMatrix(model.getModel()?.canvasinfo, config.expected_canvas) : null;
      const layout = new Map();
      settings.getLayoutMap(layout);
      this.model.getModelMatrix().setupFromLayout(layout);
      if (settings.getPhysicsFileName()) {
        const data = await bytes(resource(settings.getPhysicsFileName()), signal);
        this.model.loadPhysics(data, data.byteLength);
      }
      if (settings.getPoseFileName()) {
        const data = await bytes(resource(settings.getPoseFileName()), signal);
        this.model.loadPose(data, data.byteLength);
      }
      this.resize();
      this.model.createRenderer(this.canvas.width, this.canvas.height);
      const renderer = this.model.getRenderer();
      renderer.startUp(this.gl);
      renderer.setIsPremultipliedAlpha(true);
      await prepareShaders(renderer, this.gl, signal);
      for (let index = 0; index < settings.getTextureCount(); index += 1) {
        const response = await fetch(resource(settings.getTextureFileName(index)), { redirect: "error", credentials: "same-origin", signal });
        if (!response.ok) throw new Error("Character texture unavailable");
        const image = await createImageBitmap(await response.blob(), { premultiplyAlpha: "premultiply" });
        try {
          checkAbort(signal);
          const gl = this.gl;
          const texture = gl.createTexture();
          if (!texture) throw new Error("Character texture allocation failed");
          this.textures.push(texture);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.generateMipmap(gl.TEXTURE_2D);
          renderer.bindTexture(index, texture);
        } finally {
          image.close();
        }
      }
      const parameters = Array.from({ length: model.getParameterCount() }, (_, index) => ({
        id: model.getParameterId(index).getString(),
        index,
        min: model.getParameterMinimumValue(index),
        max: model.getParameterMaximumValue(index),
      }));
      const resolved = resolveBindings(parameters, config.bindings);
      this.bindings = resolved.bindings;
      this.missingParameters = resolved.missing;
      checkAbort(signal);
    } finally {
      settings.release();
    }
  }

  resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.model.setRenderTargetSize(width, height);
    }
  }

  render(frame, deltaSeconds) {
    if (!this.model || this.gl.isContextLost()) return;
    this.resize();
    const gl = this.gl;
    const { width, height } = this.canvas;
    const model = this.model.getModel();
    const projection = new CubismMatrix44();
    if (this.registeredProjection) {
      projection.setMatrix(this.registeredProjection);
    } else {
      const matrix = this.model.getModelMatrix();
      const aspect = width / height;
      const fit = Math.min(1, 2 * aspect / (model.getCanvasWidth() * Math.abs(matrix.getScaleX())),
        2 / (model.getCanvasHeight() * Math.abs(matrix.getScaleY()))) * 0.94;
      projection.scale(fit / aspect, fit);
      projection.multiplyByMatrix(matrix);
    }
    this.model.updateParameters(Math.max(0, Math.min(deltaSeconds, 0.1)), parameterValues(this.bindings, frame));
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const renderer = this.model.getRenderer();
    renderer.setMvpMatrix(projection);
    renderer.setRenderState(null, [0, 0, width, height]);
    renderer.drawModel();
  }

  dispose() {
    if (!this.model) return;
    this.model.release();
    this.model = null;
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    this.textures = [];
    frameworkUsers -= 1;
    if (frameworkUsers === 0) {
      CubismRenderer_WebGL.doStaticRelease();
      CubismFramework.dispose();
      CubismFramework.cleanUp();
    }
  }
}
