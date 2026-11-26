export class CharacterView {
  constructor(canvas, image, caption, onError) {
    this.canvas = canvas;
    this.image = image;
    this.caption = caption;
    this.onError = onError;
    this.disposed = false;
    this.contextLost = (event) => {
      event.preventDefault();
      this.image.hidden = false;
      this.canvas.hidden = true;
      this.caption.textContent = "角色显示正在恢复";
    };
    this.contextRestored = () => this.load();
    canvas.addEventListener("webglcontextlost", this.contextLost);
    canvas.addEventListener("webglcontextrestored", this.contextRestored);
  }

  async load() {
    this.character?.dispose();
    this.character = null;
    try {
      const response = await fetch("/character", { redirect: "error" });
      if (!response.ok) throw new Error("Character configuration unavailable");
      const config = await response.json();
      if (!config.available || this.disposed) return;
      this.caption.textContent = "正在准备 Mona";
      if (!window.Live2DCubismCore) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = config.core_url;
          script.onload = resolve;
          script.onerror = () => reject(new Error("Cubism Core unavailable"));
          document.head.append(script);
        });
      }
      if (this.disposed) return;
      const { CubismCharacter } = await import("/vendor/cubism-runtime.js");
      const character = await CubismCharacter.create(this.canvas, config);
      if (this.disposed) return character.dispose();
      this.character = character;
      this.image.hidden = true;
      this.canvas.hidden = false;
      this.caption.textContent = "";
      window.dispatchEvent(new CustomEvent("mona:character-ready", {
        detail: { missingParameters: character.missingParameters },
      }));
    } catch {
      if (this.disposed) return;
      this.image.hidden = false;
      this.canvas.hidden = true;
      this.caption.textContent = "角色资源暂时无法使用";
      this.onError("角色显示未完成", "请检查角色资源是否完整、与当前版本匹配。你仍可继续文字对话。");
    }
  }

  render(parameters, deltaSeconds) {
    if (!this.character) return;
    try {
      this.character.render(parameters, deltaSeconds);
    } catch {
      this.character.dispose();
      this.character = null;
      this.image.hidden = false;
      this.canvas.hidden = true;
      this.caption.textContent = "角色显示暂时不可用";
      this.onError("角色显示中断", "角色暂时无法继续显示。刷新页面后可重新加载，当前对话会保留。");
    }
  }

  dispose() {
    this.disposed = true;
    this.character?.dispose();
    this.character = null;
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.contextRestored);
  }
}
