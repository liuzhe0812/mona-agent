function validateQuad(points) {
  if (!Array.isArray(points) || points.length !== 4
      || points.some((point) => !Array.isArray(point) || point.length !== 2
        || !point.every(Number.isFinite))) {
    throw new TypeError("工作台屏幕位置无效。");
  }
  for (let index = 0; index < 4; index += 1) {
    const [a, b, c] = [points[index], points[(index + 1) % 4], points[(index + 2) % 4]];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 1e-10) {
      throw new TypeError("工作台屏幕的四角无效。");
    }
  }
}

export function quadTransform(width, height, points) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new TypeError("工作台尺寸无效。");
  }
  validateQuad(points);
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = points;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const determinant = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / determinant;
  const h = (dx1 * dy3 - dx3 * dy1) / determinant;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  return [
    a / width, d / width, 0, g / width,
    b / height, e / height, 0, h / height,
    0, 0, 1, 0,
    x0, y0, 0, 1,
  ];
}

export function mountWorkbenchSurface(host, element, { width, height, screen }) {
  if (!host || typeof host.append !== "function" || !element || element.nodeType !== 1
      || element.isConnected || host.contains(element)) {
    throw new TypeError("工作台元素必须尚未挂载。");
  }
  if (!Array.isArray(screen) || screen.some((point) => !Array.isArray(point)
        || point.some((value) => !Number.isFinite(value) || value < 0 || value > 1))) {
    throw new TypeError("工作台屏幕位置无效。");
  }
  quadTransform(width, height, screen);

  const root = document.createElement("div");
  root.className = "workbench-surface";
  root.dataset.expanded = "false";
  const viewport = document.createElement("div");
  viewport.className = "workbench-surface__viewport";
  viewport.style.width = `${width}px`;
  viewport.style.height = `${height}px`;
  viewport.tabIndex = -1;
  viewport.setAttribute("role", "region");
  viewport.setAttribute("aria-label", "Mona 工作台");
  const content = document.createElement("div");
  content.className = "workbench-surface__content";
  const openButton = document.createElement("button");
  openButton.className = "workbench-surface__open";
  openButton.type = "button";
  openButton.setAttribute("aria-label", "打开工作台");
  const closeButton = document.createElement("button");
  closeButton.className = "button secondary workbench-surface__close";
  closeButton.type = "button";
  closeButton.textContent = "收起";
  closeButton.setAttribute("aria-label", "收起工作台");
  closeButton.hidden = true;
  const originalInert = Boolean(element.inert);
  element.inert = true;
  content.append(element);
  viewport.append(content, openButton);
  root.append(viewport, closeButton);
  host.append(root);

  let expanded = false;
  let disposed = false;
  let focusBeforeExpand = null;
  let frameDocument = null;
  const layout = () => {
    const bounds = host.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    let points = screen.map(([x, y]) => [x * bounds.width, y * bounds.height]);
    if (expanded) {
      const scale = Math.min(bounds.width * 0.86 / width, bounds.height * 0.8 / height);
      const projectedWidth = width * scale;
      const projectedHeight = height * scale;
      const left = (bounds.width - projectedWidth) / 2;
      const top = (bounds.height - projectedHeight) / 2;
      points = [[left, top], [left + projectedWidth, top],
        [left + projectedWidth, top + projectedHeight], [left, top + projectedHeight]];
      closeButton.style.left = `${left + projectedWidth}px`;
      closeButton.style.top = `${Math.max(0, top - 44)}px`;
    }
    viewport.style.transform = `matrix3d(${quadTransform(width, height, points).join(",")})`;
  };
  const observer = new ResizeObserver(layout);
  observer.observe(host);
  layout();

  const expand = () => {
    if (disposed || expanded) return;
    focusBeforeExpand = document.activeElement;
    expanded = true;
    root.dataset.expanded = "true";
    element.inert = false;
    openButton.hidden = true;
    closeButton.hidden = false;
    layout();
    viewport.focus({ preventScroll: true });
  };
  const collapse = () => {
    if (disposed || !expanded) return;
    expanded = false;
    root.dataset.expanded = "false";
    element.inert = true;
    openButton.hidden = false;
    closeButton.hidden = true;
    layout();
    const target = focusBeforeExpand?.isConnected && typeof focusBeforeExpand.focus === "function"
      ? focusBeforeExpand : openButton;
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) openButton.focus({ preventScroll: true });
    focusBeforeExpand = null;
  };
  const onKeyDown = (event) => {
    if (expanded && event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      collapse();
    }
  };
  const watchFrame = () => {
    if (frameDocument) frameDocument.removeEventListener("keydown", onKeyDown, true);
    frameDocument = null;
    try {
      frameDocument = element.contentWindow?.document || null;
      frameDocument?.addEventListener("keydown", onKeyDown, true);
    } catch (error) {
      if (error.name !== "SecurityError") throw error;
      host.dispatchEvent(new CustomEvent("mona:workbench-escape-unavailable", {
        detail: { reason: "cross-origin" },
      }));
    }
  };
  openButton.addEventListener("click", expand);
  closeButton.addEventListener("click", collapse);
  document.addEventListener("keydown", onKeyDown, true);
  if (element.tagName === "IFRAME") {
    element.addEventListener("load", watchFrame);
    watchFrame();
  }

  return {
    expand,
    collapse,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      openButton.removeEventListener("click", expand);
      closeButton.removeEventListener("click", collapse);
      document.removeEventListener("keydown", onKeyDown, true);
      if (element.tagName === "IFRAME") element.removeEventListener("load", watchFrame);
      if (frameDocument) frameDocument.removeEventListener("keydown", onKeyDown, true);
      element.inert = originalInert;
      root.remove();
    },
  };
}
