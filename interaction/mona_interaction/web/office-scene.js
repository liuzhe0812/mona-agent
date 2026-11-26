const SVG_NS = "http://www.w3.org/2000/svg";
let nextClockId = 0;

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

export function clockAngles(date) {
  const seconds = date.getSeconds() + date.getMilliseconds() / 1000;
  const minutes = date.getMinutes() + seconds / 60;
  const hours = date.getHours() % 12 + minutes / 60;
  return { hour: hours * 30, minute: minutes * 6, second: seconds * 6 };
}

// The fixed artwork is tinted gradually using the device's local time.
export function windowTint(date) {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const phases = [
    [0, 17, 25, 55, 0.66], [5, 17, 25, 55, 0.66],
    [7, 213, 125, 102, 0.26], [9, 143, 196, 231, 0.10],
    [16, 143, 196, 231, 0.10], [19, 224, 109, 73, 0.34],
    [21, 17, 25, 55, 0.66], [24, 17, 25, 55, 0.66],
  ];
  const index = phases.findIndex((phase) => phase[0] > hour);
  const start = phases[index - 1];
  const end = phases[index];
  const fraction = (hour - start[0]) / (end[0] - start[0]);
  const values = start.slice(1).map((value, i) => value + (end[i + 1] - value) * fraction);
  return `rgba(${values.slice(0, 3).map(Math.round).join(', ')}, ${values[3].toFixed(3)})`;
}

export function windowNightOpacity(date) {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const smooth = (value) => value * value * (3 - 2 * value);
  if (hour >= 5 && hour < 7) return 1 - smooth((hour - 5) / 2);
  if (hour >= 19 && hour < 21) return smooth((hour - 19) / 2);
  return hour < 5 || hour >= 21 ? 1 : 0;
}

export function fitOfficeScene(viewWidth, viewHeight, imageWidth, imageHeight) {
  const scale = Math.min(viewWidth / imageWidth, viewHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return { width, height, left: (viewWidth - width) / 2, top: (viewHeight - height) / 2 };
}

function makeClock() {
  const id = `office-clock-${++nextClockId}`;
  const clock = svgElement("svg", { viewBox: "0 0 100 100", role: "img" });
  clock.classList.add("office-scene__clock");
  const defs = svgElement("defs");
  const rim = svgElement("linearGradient", { id: `${id}-rim`, x1: "0", y1: "0", x2: "1", y2: "1" });
  rim.append(svgElement("stop", { offset: "0", "stop-color": "#4e3730" }),
    svgElement("stop", { offset: "0.48", "stop-color": "#100e0d" }),
    svgElement("stop", { offset: "1", "stop-color": "#372220" }));
  const face = svgElement("linearGradient", { id: `${id}-face`, x1: "0", y1: "0", x2: "1", y2: "1" });
  face.append(svgElement("stop", { offset: "0", "stop-color": "#f3ead9" }),
    svgElement("stop", { offset: "1", "stop-color": "#c9b09a" }));
  defs.append(rim, face);
  clock.append(defs,
    svgElement("circle", { cx: "50", cy: "50", r: "48", fill: `url(#${id}-rim)` }),
    svgElement("circle", { cx: "50", cy: "50", r: "43", fill: "#171211", stroke: "#72332e", "stroke-width": "0.8" }),
    svgElement("circle", { cx: "50", cy: "50", r: "39.5", fill: `url(#${id}-face)` }),
    svgElement("circle", { cx: "50", cy: "50", r: "35.5", fill: "none", stroke: "#ac8c7b", "stroke-width": "0.5" }));
  for (let tick = 0; tick < 12; tick += 1) {
    clock.append(svgElement("line", {
      x1: "50", y1: tick % 3 === 0 ? "17" : "19", x2: "50", y2: "22.5",
      stroke: "#342320", "stroke-width": tick % 3 === 0 ? "2" : "1.2",
      "stroke-linecap": "round", transform: `rotate(${tick * 30} 50 50)`,
    }));
  }
  const hour = svgElement("line", {
    x1: "50", y1: "53", x2: "50", y2: "30", stroke: "#211a18", "stroke-width": "3.2",
    "stroke-linecap": "round",
  });
  const minute = svgElement("line", {
    x1: "50", y1: "54", x2: "50", y2: "22", stroke: "#211a18", "stroke-width": "2.1",
    "stroke-linecap": "round",
  });
  const second = svgElement("line", {
    x1: "50", y1: "57", x2: "50", y2: "19.5", stroke: "#b7242b", "stroke-width": "0.9",
    "stroke-linecap": "round",
  });
  clock.append(hour, minute, second,
    svgElement("circle", { cx: "50", cy: "50", r: "2.1", fill: "#211a18" }),
    svgElement("circle", { cx: "50", cy: "50", r: "0.8", fill: "#d4524a" }));
  return { clock, hour, minute, second };
}

export function mountOfficeScene(host, config) {
  if (!host || typeof host.append !== "function") throw new TypeError("场景容器无效。");
  if (!config || typeof config.background_url !== "string" || !config.background_url
      || (config.night_background_url !== undefined
        && (typeof config.night_background_url !== "string" || !config.night_background_url))
      || !Number.isFinite(config.width) || config.width <= 0
      || !Number.isFinite(config.height) || config.height <= 0) {
    throw new TypeError("办公室场景资源无效。");
  }
  const inUnit = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
  const cloudFields = [config.day_sky_url, config.cloud_artwork_url, config.cloud_regions];
  const layeredClouds = cloudFields.some((value) => value !== undefined);
  if (layeredClouds && (typeof cloudFields[0] !== "string" || !cloudFields[0]
      || typeof cloudFields[1] !== "string" || !cloudFields[1]
      || !Array.isArray(cloudFields[2]) || cloudFields[2].length < 1 || cloudFields[2].length > 8
      || cloudFields[2].some((polygon) => !Array.isArray(polygon) || polygon.length < 3 || polygon.length > 256
        || polygon.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every(inUnit))))) {
    throw new TypeError("云层素材或天空范围无效。");
  }
  const { clock: position, window: windowPoints } = config;
  if (!position || !inUnit(position.x) || !inUnit(position.y)
      || !inUnit(position.diameter) || position.diameter === 0
      || !Array.isArray(windowPoints) || windowPoints.length < 3
      || windowPoints.some((point) => !Array.isArray(point) || point.length !== 2
        || !point.every(inUnit))) {
    throw new TypeError("办公室场景位置无效。");
  }

  const scene = document.createElement("div");
  scene.className = "office-scene";
  const frame = document.createElement("div");
  frame.className = "office-scene__frame";
  const background = document.createElement("img");
  background.className = "office-scene__background";
  background.alt = "";
  background.draggable = false;
  const atmosphere = document.createElement("div");
  atmosphere.className = "office-scene__atmosphere";
  atmosphere.setAttribute("aria-hidden", "true");
  atmosphere.style.clipPath = `polygon(${windowPoints.map(([x, y]) => `${x * 100}% ${y * 100}%`).join(", ")})`;
  const clouds = document.createElement("div");
  const cloudImages = [];
  const cloudAssets = [];
  if (layeredClouds) {
    clouds.className = "office-scene__cloud-layers";
    clouds.style.visibility = "hidden";
    for (const polygon of config.cloud_regions) {
      const pane = document.createElement("div");
      pane.className = "office-scene__cloud-pane";
      pane.style.clipPath = `polygon(${polygon.map(([x, y]) => `${x * 100}% ${y * 100}%`).join(", ")})`;
      const day = document.createElement("img");
      day.className = "office-scene__day-sky";
      day.alt = "";
      day.draggable = false;
      const image = document.createElement("img");
      image.className = "office-scene__cloud-image";
      image.alt = "";
      image.draggable = false;
      cloudImages.push(image);
      cloudAssets.push([day, config.day_sky_url], [image, config.cloud_artwork_url]);
      pane.append(day, image);
      clouds.append(pane);
    }
    atmosphere.append(clouds);
  } else {
    clouds.className = "office-scene__clouds";
  }
  const night = config.night_background_url ? document.createElement("img") : null;
  if (night) {
    night.className = "office-scene__night";
    night.alt = "";
    night.draggable = false;
    night.style.opacity = "0";
    atmosphere.append(night);
  }
  const sky = document.createElement("div");
  sky.className = "office-scene__sky";
  const xs = windowPoints.map(([x]) => x);
  const ys = windowPoints.map(([, y]) => y);
  const windowBounds = {
    left: Math.min(...xs), top: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
  };
  const fitWindow = (element) => {
    for (const [key, value] of Object.entries(windowBounds)) element.style[key] = `${value * 100}%`;
  };
  if (!layeredClouds) fitWindow(clouds);
  const light = document.createElement("div");
  light.className = "office-scene__light";
  if (layeredClouds) atmosphere.append(sky, light);
  else atmosphere.append(sky, clouds, light);
  // These small light accents match the city in the optional night artwork.
  const cityLights = night ? document.createElement("div") : null;
  if (cityLights) {
    cityLights.className = "office-scene__city-lights";
    fitWindow(cityLights);
    for (let index = 0; index < 3; index += 1) {
      const glow = document.createElement("span");
      glow.className = "office-scene__city-light";
      cityLights.append(glow);
    }
    atmosphere.append(cityLights);
  }
  const hands = makeClock();
  hands.clock.style.left = `${position.x * 100}%`;
  hands.clock.style.top = `${position.y * 100}%`;
  hands.clock.style.width = `${position.diameter * 100}%`;
  frame.append(background, atmosphere, hands.clock);
  let roomShade = null;
  if (night) {
    roomShade = document.createElement("div");
    roomShade.className = "office-scene__room-shade";
    roomShade.setAttribute("aria-hidden", "true");
    // The window has its own painted night plate. Shade the interior around it.
    const hole = [...windowPoints, windowPoints[0]].map(([x, y]) => `${100 * x}% ${100 * y}%`).join(", ");
    roomShade.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${hole}, 0 0)`;
    frame.append(roomShade);
  }
  scene.append(frame);
  host.append(scene);

  const onBackgroundError = () => host.dispatchEvent(new CustomEvent("mona:office-scene-error", {
    detail: { message: "办公室场景图片加载失败。" },
  }));
  let cloudAssetsReady = 0;
  let cloudAssetsFailed = false;
  const onCloudLoad = () => {
    cloudAssetsReady += 1;
    if (!cloudAssetsFailed && cloudAssetsReady === cloudAssets.length) clouds.style.visibility = "visible";
  };
  const onCloudError = () => {
    cloudAssetsFailed = true;
    clouds.style.visibility = "hidden";
    onBackgroundError();
  };
  background.addEventListener("error", onBackgroundError);
  background.src = config.background_url;
  for (const [image, source] of cloudAssets) {
    image.addEventListener("load", onCloudLoad, { once: true });
    image.addEventListener("error", onCloudError, { once: true });
    image.src = source;
  }
  if (night) {
    night.addEventListener("error", onBackgroundError);
    night.src = config.night_background_url;
  }

  const resize = () => {
    const bounds = scene.getBoundingClientRect();
    const box = fitOfficeScene(bounds.width, bounds.height, config.width, config.height);
    for (const key of ["width", "height", "left", "top"]) frame.style[key] = `${box[key]}px`;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(scene);
  resize();

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let animationId = null;
  let timerId = null;
  let lastSecond = null;
  let lastMinute = null;
  let disposed = false;
  const cancelScheduled = () => {
    if (animationId !== null) window.cancelAnimationFrame(animationId);
    if (timerId !== null) window.clearTimeout(timerId);
    animationId = null;
    timerId = null;
  };
  const tick = () => {
    animationId = null;
    timerId = null;
    if (disposed || document.hidden) return;
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60000);
    if (lastMinute !== minute) {
      sky.style.backgroundColor = windowTint(now);
      const nightOpacity = windowNightOpacity(now);
      if (night) night.style.opacity = String(nightOpacity);
      if (roomShade) roomShade.style.opacity = String(nightOpacity);
      sky.style.opacity = night ? String(1 - nightOpacity) : "1";
      if (layeredClouds) {
        for (const image of cloudImages) image.style.opacity = String(1 - nightOpacity);
      } else clouds.style.opacity = String(1 - nightOpacity);
      if (cityLights) cityLights.style.opacity = String(nightOpacity);
      lastMinute = minute;
    }
    const angles = clockAngles(now);
    for (const name of ["hour", "minute", "second"]) {
      hands[name].setAttribute("transform", `rotate(${angles[name]} 50 50)`);
    }
    const second = Math.floor(now.getTime() / 1000);
    if (lastSecond !== second) {
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((part) => String(part).padStart(2, "0")).join(":");
      hands.clock.setAttribute("aria-label", `当前时间 ${time}`);
      lastSecond = second;
    }
    if (motion.matches) timerId = window.setTimeout(tick, 1000 - now.getMilliseconds());
    else animationId = window.requestAnimationFrame(tick);
  };
  const restart = () => {
    cancelScheduled();
    lastMinute = null;
    scene.dataset.paused = String(document.hidden);
    if (!document.hidden) tick();
  };
  document.addEventListener("visibilitychange", restart);
  motion.addEventListener("change", restart);
  restart();

  return {
    frame,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelScheduled();
      document.removeEventListener("visibilitychange", restart);
      motion.removeEventListener("change", restart);
      background.removeEventListener("error", onBackgroundError);
      if (night) night.removeEventListener("error", onBackgroundError);
      for (const [image] of cloudAssets) {
        image.removeEventListener("load", onCloudLoad);
        image.removeEventListener("error", onCloudError);
      }
      observer.disconnect();
      scene.remove();
    },
  };
}
