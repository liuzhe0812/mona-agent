import htmlToImageUmd from "html-to-image/dist/html-to-image.js?raw";

const allowedCdnHosts = new Set([
  "cdnjs.cloudflare.com",
  "esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
]);

const blockedTags = new Set(["iframe", "object", "embed", "base", "meta", "link"]);
const dataScriptTypes = new Set(["application/json", "application/ld+json", "text/plain"]);
const executableScriptTypes = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
]);

type ParsedAttribute = { name: string; value: string | null };
type ParsedTag = {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: ParsedAttribute[];
};

function findTagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

function findRawElementClose(source: string, start: number, tagName: string): { start: number; end: number } | null {
  const closeTag = new RegExp(`<\\s*\\/\\s*${tagName}\\s*>`, "ig");
  closeTag.lastIndex = start;
  const match = closeTag.exec(source);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/** Drop a partial final tag and any unfinished raw-text block while the model is streaming. */
function completeMarkupPrefix(source: string): string {
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("<", index);
    if (start === -1) return source;

    if (source.startsWith("<!--", start)) {
      const commentEnd = source.indexOf("-->", start + 4);
      if (commentEnd === -1) return source.slice(0, start);
      index = commentEnd + 3;
      continue;
    }

    const next = source[start + 1];
    if (!next || !(/[A-Za-z/!?]/.test(next))) {
      index = start + 1;
      continue;
    }

    const end = findTagEnd(source, start);
    if (end === -1) return source.slice(0, start);

    const tag = parseTag(source.slice(start, end + 1));
    if (tag && !tag.closing && !tag.selfClosing && (tag.name.toLowerCase() === "script" || tag.name.toLowerCase() === "style")) {
      const rawClose = findRawElementClose(source, end + 1, tag.name);
      if (!rawClose) return source.slice(0, start);
      index = rawClose.end;
      continue;
    }
    index = end + 1;
  }
  return source;
}

function parseTag(rawTag: string): ParsedTag | null {
  const opening = /^<\s*(\/?)\s*([A-Za-z][\w:.-]*)/.exec(rawTag);
  if (!opening) return null;

  const name = opening[2];
  const closing = opening[1] === "/";
  const attributes: ParsedAttribute[] = [];
  let index = opening[0].length;
  const end = rawTag.length - 1;
  let selfClosing = false;

  while (index < end) {
    while (index < end && /\s/.test(rawTag[index])) index += 1;
    if (rawTag[index] === "/") {
      selfClosing = true;
      index += 1;
      continue;
    }
    if (index >= end) break;

    const nameStart = index;
    while (index < end && !/[\s=/>]/.test(rawTag[index])) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const attributeName = rawTag.slice(nameStart, index);
    while (index < end && /\s/.test(rawTag[index])) index += 1;

    let value: string | null = null;
    if (rawTag[index] === "=") {
      index += 1;
      while (index < end && /\s/.test(rawTag[index])) index += 1;
      const quote = rawTag[index] === "\"" || rawTag[index] === "'" ? rawTag[index++] : "";
      const valueStart = index;
      if (quote) {
        while (index < end && rawTag[index] !== quote) index += 1;
      } else {
        while (index < end && !/[\s>]/.test(rawTag[index])) index += 1;
      }
      value = rawTag.slice(valueStart, index);
      if (quote && rawTag[index] === quote) index += 1;
    }
    attributes.push({ name: attributeName, value });
  }

  return { name, closing, selfClosing, attributes };
}

function decodeUrlEntities(value: string): string {
  return value
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_match, encoded: string) => {
      const codePoint = encoded[0].toLowerCase() === "x"
        ? Number.parseInt(encoded.slice(1), 16)
        : Number.parseInt(encoded, 10);
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return "";
      }
    })
    .replace(/&colon;?/gi, ":")
    .replace(/&tab;?/gi, "\t")
    .replace(/&newline;?/gi, "\n")
    .replace(/&amp;/gi, "&");
}

export function isAllowedVisualizerCdnUrl(value: string): boolean {
  try {
    const url = new URL(decodeUrlEntities(value));
    return url.protocol === "https:"
      && (url.port === "" || url.port === "443")
      && url.username === ""
      && url.password === ""
      && allowedCdnHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isInlineImageUrl(value: string): boolean {
  const normalized = decodeUrlEntities(value).trim();
  return /^data:image\//i.test(normalized)
    || /^blob:/i.test(normalized)
    || isAllowedVisualizerCdnUrl(normalized);
}

function isSafeAnchorUrl(value: string): boolean {
  const normalized = decodeUrlEntities(value).trim();
  if (normalized.startsWith("#")) return true;
  try {
    const url = new URL(normalized);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function serializeTag(tag: ParsedTag, streaming: boolean): string {
  const lowerName = tag.name.toLowerCase();
  if (blockedTags.has(lowerName) || lowerName === "form") return "";
  if (tag.closing) return `</${tag.name}>`;

  const safeAttributes: ParsedAttribute[] = [];
  const isAnchor = lowerName === "a";
  let bridgedHref: string | null = null;

  for (const attribute of tag.attributes) {
    const lowerAttribute = attribute.name.toLowerCase();
    const value = attribute.value ?? "";
    if ((streaming && lowerAttribute.startsWith("on")) || lowerAttribute === "srcdoc") continue;
    if (["action", "formaction", "ping", "srcset", "target"].includes(lowerAttribute)) continue;

    if (lowerName === "script" && lowerAttribute === "src" && !isAllowedVisualizerCdnUrl(value)) continue;
    if (lowerAttribute === "src" || lowerAttribute === "poster" || lowerAttribute === "data") {
      if (!isInlineImageUrl(value)) continue;
    }
    if (lowerAttribute === "href" || lowerAttribute === "xlink:href") {
      if (isAnchor && lowerAttribute === "href") {
        if (isSafeAnchorUrl(value) && !decodeUrlEntities(value).trim().startsWith("#")) {
          bridgedHref = decodeUrlEntities(value).trim();
          continue;
        } else if (!decodeUrlEntities(value).trim().startsWith("#")) {
          continue;
        }
      } else if (!decodeUrlEntities(value).trim().startsWith("#") && !isInlineImageUrl(value)) {
        continue;
      }
    }
    safeAttributes.push(attribute);
  }

  if (isAnchor && bridgedHref) {
    safeAttributes.push({ name: "data-mona-link", value: bridgedHref });
    safeAttributes.push({ name: "href", value: "#" });
  }

  const attributes = safeAttributes.map(({ name, value }) =>
    value === null ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`,
  ).join("");
  const slash = tag.selfClosing ? " /" : "";
  return `<${tag.name}${attributes}${slash}>`;
}

function sanitizeMarkup(source: string, streaming: boolean): string {
  const input = completeMarkupPrefix(source);
  let output = "";
  let index = 0;

  while (index < input.length) {
    const start = input.indexOf("<", index);
    if (start === -1) {
      output += input.slice(index);
      break;
    }
    output += input.slice(index, start);

    if (input.startsWith("<!--", start)) {
      const commentEnd = input.indexOf("-->", start + 4);
      if (commentEnd === -1) break;
      output += input.slice(start, commentEnd + 3);
      index = commentEnd + 3;
      continue;
    }

    const next = input[start + 1];
    if (!next || !(/[A-Za-z/!?]/.test(next))) {
      output += "<";
      index = start + 1;
      continue;
    }

    const end = findTagEnd(input, start);
    if (end === -1) break;
    const rawTag = input.slice(start, end + 1);
    const tag = parseTag(rawTag);
    if (!tag) {
      index = end + 1;
      continue;
    }

    const lowerName = tag.name.toLowerCase();
    if (!tag.closing && !tag.selfClosing && (lowerName === "script" || lowerName === "style")) {
      const rawClose = findRawElementClose(input, end + 1, lowerName);
      if (!rawClose) break;
      const bodyEnd = rawClose.start;
      const closeTag = input.slice(rawClose.start, rawClose.end);

      if (lowerName === "script") {
        const type = (tag.attributes.find((attribute) => attribute.name.toLowerCase() === "type")?.value ?? "")
          .trim().toLowerCase();
        const isDataScript = dataScriptTypes.has(type) || (!executableScriptTypes.has(type) && type !== "");
        const externalSource = tag.attributes.find((attribute) => attribute.name.toLowerCase() === "src")?.value;
        const executable = !isDataScript;
        if (!(streaming && executable) && !(externalSource && !isAllowedVisualizerCdnUrl(externalSource))) {
          output += serializeTag(tag, streaming);
          output += input.slice(end + 1, bodyEnd);
          output += closeTag;
        }
      } else {
        output += serializeTag(tag, streaming);
        output += input.slice(end + 1, bodyEnd);
        output += closeTag;
      }
      index = rawClose.end;
      continue;
    }

    if ((lowerName === "iframe" || lowerName === "object")
      && !tag.closing && !tag.selfClosing) {
      const rawClose = findRawElementClose(input, end + 1, lowerName);
      index = rawClose ? rawClose.end : input.length;
      continue;
    }

    output += serializeTag(tag, streaming);
    index = end + 1;
  }

  return output;
}

/** Sanitize the visible, non-executing preview of a partial widget response. */
export function sanitizeForStreaming(code: string): string {
  return sanitizeMarkup(code, true);
}

/** Sanitize final markup before it enters the isolated widget iframe. */
export function sanitizeForIframe(code: string): string {
  return sanitizeMarkup(code, false);
}

export function isTrustedVisualizerMessage(
  event: Pick<MessageEvent, "source" | "data">,
  iframe: Pick<HTMLIFrameElement, "contentWindow">,
  token: string,
): boolean {
  const data = event.data;
  return event.source === iframe.contentWindow
    && typeof data === "object"
    && data !== null
    && data.channel === token;
}

const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
  "img-src data: blob: https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
  "font-src https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
  "connect-src https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const widgetBootstrap = String.raw`
(function () {
  "use strict";
  var channel = __MONA_CHANNEL__;
  var root = document.getElementById("widget-root");
  var pendingResize = false;
  var maxPromptLength = 500;
  var currentTheme = { dark: false };
  function post(type, value) {
    var data = { channel: channel, type: type };
    if (value && typeof value === "object") {
      Object.keys(value).forEach(function (key) { data[key] = value[key]; });
    }
    parent.postMessage(data, "*");
  }
  function sendLink(value) {
    try {
      var raw = String(value);
      if (raw.length > 2048) return;
      var url = new URL(raw);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
        post("link", { url: url.href });
      }
    } catch (_) {}
  }
  window.sendPrompt = function (text) {
    var value = String(text == null ? "" : text).trim().slice(0, maxPromptLength);
    if (value) post("prompt", { text: value });
  };
  window.sendLink = sendLink;
  document.addEventListener("click", function (event) {
    var target = event.target;
    var anchor = target && target.closest ? target.closest("a[data-mona-link]") : null;
    if (!anchor) return;
    event.preventDefault();
    sendLink(anchor.getAttribute("data-mona-link"));
  }, true);
  function scheduleResize() {
    if (pendingResize) return;
    pendingResize = true;
    requestAnimationFrame(function () {
      pendingResize = false;
      var height = Math.ceil(root.getBoundingClientRect().height);
      post("resize", { height: height });
    });
  }
  if (window.ResizeObserver) {
    new ResizeObserver(scheduleResize).observe(root);
  }
  window.addEventListener("resize", scheduleResize);
  window.addEventListener("error", function () { post("error", { message: "图形脚本运行失败" }); });
  function applyTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    currentTheme = theme;
    var names = ["background", "foreground", "card", "muted", "muted-foreground", "border", "primary", "primary-foreground", "secondary", "secondary-foreground", "accent", "accent-foreground", "destructive", "ring", "editor-surface", "data-1", "data-2", "data-3", "data-4", "data-5", "data-6"];
    names.forEach(function (name) {
      if (typeof theme[name] === "string" && theme[name]) {
        document.documentElement.style.setProperty("--" + name, theme[name]);
      }
    });
    document.documentElement.classList.toggle("dark", theme.dark === true);
    applyChartTheme(theme);
  }
  function applyChartTheme(theme) {
    var chart = window.Chart;
    if (!chart || !chart.defaults) return;
    var foreground = theme["muted-foreground"] ? "hsl(" + theme["muted-foreground"] + ")" : "#666";
    var border = theme.border ? "hsl(" + theme.border + ")" : "#ccc";
    chart.defaults.color = foreground;
    chart.defaults.borderColor = border;
    if (chart.defaults.plugins && chart.defaults.plugins.legend && chart.defaults.plugins.legend.labels) {
      chart.defaults.plugins.legend.labels.color = foreground;
    }
    var instances = chart.instances || {};
    Object.keys(instances).forEach(function (key) {
      var instance = instances[key];
      if (!instance || !instance.options) return;
      instance.options.color = foreground;
      if (instance.options.plugins && instance.options.plugins.legend && instance.options.plugins.legend.labels) {
        instance.options.plugins.legend.labels.color = foreground;
      }
      Object.keys(instance.options.scales || {}).forEach(function (scaleKey) {
        var scale = instance.options.scales[scaleKey];
        if (scale.ticks) scale.ticks.color = foreground;
        if (scale.grid) scale.grid.color = border;
        if (scale.border) scale.border.color = border;
      });
      if (typeof instance.update === "function") instance.update("none");
    });
  }
  function allowedCdnUrl(value) {
    try {
      var url = new URL(value);
      return url.protocol === "https:" && (url.port === "" || url.port === "443") && !url.username && !url.password
        && ["cdnjs.cloudflare.com", "esm.sh", "cdn.jsdelivr.net", "unpkg.com"].indexOf(url.hostname.toLowerCase()) !== -1;
    } catch (_) { return false; }
  }
  function cleanMarkup(markup, streaming) {
    var template = document.createElement("template");
    template.innerHTML = String(markup || "");
    template.content.querySelectorAll("iframe,object,embed,base,meta,link,form").forEach(function (node) { node.remove(); });
    template.content.querySelectorAll("*").forEach(function (element) {
      Array.prototype.slice.call(element.attributes).forEach(function (attribute) {
        var name = attribute.name.toLowerCase();
        var value = attribute.value;
        if ((streaming && name.indexOf("on") === 0) || name === "srcdoc" || name === "action" || name === "formaction" || name === "ping" || name === "srcset" || name === "target") {
          element.removeAttribute(attribute.name);
          return;
        }
        if (name === "src" && element.tagName.toLowerCase() === "script" && !allowedCdnUrl(value)) element.removeAttribute(attribute.name);
        if ((name === "src" || name === "poster" || name === "data") && !(/^data:image\//i.test(value) || /^blob:/i.test(value) || allowedCdnUrl(value))) element.removeAttribute(attribute.name);
        if ((name === "href" || name === "xlink:href") && !value.trim().startsWith("#")) {
          if (element.tagName.toLowerCase() === "a" && /^https?:\/\//i.test(value)) {
            element.setAttribute("data-mona-link", value);
            element.setAttribute("href", "#");
          } else if (!(/^data:image\//i.test(value) || /^blob:/i.test(value) || allowedCdnUrl(value))) {
            element.removeAttribute(attribute.name);
          }
        }
      });
    });
    var scripts = Array.prototype.slice.call(template.content.querySelectorAll("script"));
    var executableScripts = [];
    scripts.forEach(function (script) {
      var type = (script.getAttribute("type") || "").trim().toLowerCase();
      var isData = ["application/json", "application/ld+json", "text/plain"].indexOf(type) !== -1
        || (type && ["module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"].indexOf(type) === -1);
      if (isData) return;
      if (streaming) {
        script.remove();
      } else {
        if (script.src && !allowedCdnUrl(script.src)) {
          script.remove();
          return;
        }
        executableScripts.push(script);
        script.remove();
      }
    });
    return { fragment: template.content, scripts: executableScripts };
  }
  var renderVersion = 0;
  function executeScripts(scripts, index, version) {
    if (version !== renderVersion) return Promise.resolve();
    if (index >= scripts.length) return Promise.resolve();
    var source = scripts[index];
    var script = document.createElement("script");
    Array.prototype.slice.call(source.attributes).forEach(function (attribute) {
      if (attribute.name.toLowerCase().indexOf("on") !== 0) script.setAttribute(attribute.name, attribute.value);
    });
    if (source.src) {
      script.async = false;
      return new Promise(function (resolve) {
        script.onload = function () { resolve(executeScripts(scripts, index + 1, version)); };
        script.onerror = function () { post("error", { message: "图形脚本加载失败" }); resolve(executeScripts(scripts, index + 1, version)); };
        script.src = source.src;
        document.head.appendChild(script);
      });
    }
    if (source.type === "module") {
      return new Promise(function (resolve) {
        script.onload = function () { resolve(executeScripts(scripts, index + 1, version)); };
        script.onerror = function () { post("error", { message: "图形脚本加载失败" }); resolve(executeScripts(scripts, index + 1, version)); };
        script.textContent = source.textContent || "";
        document.head.appendChild(script);
      });
    }
    script.textContent = source.textContent || "";
    document.body.appendChild(script);
    script.remove();
    return executeScripts(scripts, index + 1, version);
  }
  function render(code, streaming) {
    var version = ++renderVersion;
    root.replaceChildren();
    var result = cleanMarkup(code, streaming);
    root.appendChild(result.fragment);
    scheduleResize();
    if (!streaming) {
      return executeScripts(result.scripts, 0, version).then(function () {
        applyTheme(currentTheme);
        scheduleResize();
      });
    }
    return Promise.resolve();
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent || !event.data || event.data.channel !== channel) return;
    var message = event.data;
    if (message.type === "hello") { post("ready"); return; }
    if (message.type === "theme") applyTheme(message.theme);
    if (message.type === "update" || message.type === "finalize") {
      render(message.code, message.type === "update").catch(function () { post("error", { message: "图形渲染失败" }); });
    }
    if (message.type === "export-png") {
      if (!window.htmlToImage || !window.htmlToImage.toPng) {
        post("error", { message: "PNG 导出组件不可用" });
        return;
      }
      window.htmlToImage.toPng(root, { cacheBust: false, backgroundColor: "hsl(" + getComputedStyle(document.documentElement).getPropertyValue("--background") + ")" })
        .then(function (dataUrl) { post("png", { dataUrl: dataUrl }); })
        .catch(function () { post("error", { message: "无法导出 PNG，请检查图形中的外部资源" }); });
    }
    if (message.type === "export-svg") {
      var svg = root.querySelector("svg");
      if (!svg) { post("error", { message: "当前图形没有可导出的 SVG" }); return; }
      var clone = svg.cloneNode(true);
      var originals = [svg].concat(Array.from(svg.querySelectorAll("*")));
      var copies = [clone].concat(Array.from(clone.querySelectorAll("*")));
      originals.forEach(function (element, index) {
        var computed = getComputedStyle(element);
        ["fill", "stroke", "stroke-width", "font-family", "font-size", "font-weight", "color", "opacity", "text-anchor"].forEach(function (property) {
          copies[index].style.setProperty(property, computed.getPropertyValue(property));
        });
      });
      clone.querySelectorAll("script,iframe,object,embed,base,meta,link,form").forEach(function (node) { node.remove(); });
      clone.querySelectorAll("*").forEach(function (element) {
        Array.prototype.slice.call(element.attributes).forEach(function (attribute) {
          var name = attribute.name.toLowerCase();
          if (name.indexOf("on") === 0 || name === "srcdoc" || name === "srcset") element.removeAttribute(attribute.name);
          if ((name === "href" || name === "xlink:href" || name === "src") && !attribute.value.trim().startsWith("#") && !(/^data:image\//i.test(attribute.value) || /^blob:/i.test(attribute.value) || allowedCdnUrl(attribute.value))) element.removeAttribute(attribute.name);
        });
      });
      post("svg", { code: new XMLSerializer().serializeToString(clone) });
    }
  });
  post("ready");
})();
`;

const colorRamps = {
  purple: ["#EEEDFE", "#CECBF6", "#AFA9EC", "#534AB7", "#3C3489"],
  teal: ["#E1F5EE", "#9FE1CB", "#5DCAA5", "#0F6E56", "#085041"],
  coral: ["#FAECE7", "#F5C4B3", "#F0997B", "#993C1D", "#712B13"],
  pink: ["#FBEAF0", "#F4C0D1", "#ED93B1", "#993556", "#72243E"],
  gray: ["#F1EFE8", "#D3D1C7", "#B4B2A9", "#5F5E5A", "#444441"],
  blue: ["#E6F1FB", "#B5D4F4", "#85B7EB", "#185FA5", "#0C447C"],
  green: ["#EAF3DE", "#C0DD97", "#97C459", "#3B6D11", "#27500A"],
  amber: ["#FAEEDA", "#FAC775", "#EF9F27", "#854F0B", "#633806"],
  red: ["#FCEBEB", "#F7C1C1", "#F09595", "#A32D2D", "#791F1F"],
};
const paletteStyles = Object.entries(colorRamps).map(([name, colors]) => `
.c-${name} { --node-fill:${colors[0]}; --node-stroke:${colors[3]}; --node-title:${colors[4]}; --node-subtitle:${colors[3]}; }
:root.dark .c-${name} { --node-fill:${colors[4]}; --node-stroke:${colors[2]}; --node-title:${colors[1]}; --node-subtitle:${colors[2]}; }
.c-${name}, .c-${name} :is(rect,circle,ellipse) { fill:var(--node-fill); stroke:var(--node-stroke); }
.c-${name} :is(.t,.th) { fill:var(--node-title); stroke:none; }
.c-${name} .ts { fill:var(--node-subtitle); stroke:none; }
`).join("\n");

const frameStyles = String.raw`
:root { --background: 48 100% 99%; --foreground: 0 0% 10.2%; --card: 48 100% 99%; --muted: 60 12.8% 92.4%; --muted-foreground: 60 1.9% 41.2%; --border: 60 8.5% 88.4%; --primary: 214.3 5.5% 24.9%; --primary-foreground: 0 0% 98.8%; --secondary: 60 12.8% 92.4%; --secondary-foreground: 0 0% 10.2%; --accent: 60 12.8% 92.4%; --accent-foreground: 0 0% 10.2%; --destructive: 0 84.2% 60.2%; --ring: 356 79% 51%; --editor-surface: 0 0% 100%; --data-1: 205 35% 49%; --data-2: 168 35% 40%; --data-3: 36 52% 49%; --data-4: 270 20% 52%; --data-5: 340 36% 56%; --data-6: 68 22% 42%; color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
:root.dark { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 20px; background: hsl(var(--background)); color: hsl(var(--foreground)); }
body { overflow-wrap: anywhere; }
#widget-root { width: 100%; min-height: 20px; color: hsl(var(--foreground)); }
svg { max-width: 100%; height: auto; }
.t, .th { font-family: var(--font-sans, system-ui); font-size: 14px; fill: var(--color-text-primary); color: var(--color-text-primary); }
.ts { font-family: var(--font-sans, system-ui); font-size: 12px; fill: var(--color-text-secondary); color: var(--color-text-secondary); }
.th { font-weight: 500; }
.box { fill: var(--color-background-secondary); stroke: var(--color-border-tertiary); stroke-width: .5px; rx: 6; }
.node { cursor: pointer; }
.node:hover { opacity: .85; }
.arr { fill: none; stroke: var(--color-text-secondary); stroke-width: 1.5px; }
.leader { fill: none; stroke: var(--color-border-tertiary); stroke-width: .5px; stroke-dasharray: 4 3; }
:root { --color-background: hsl(var(--background)); --color-foreground: hsl(var(--foreground)); --color-card: hsl(var(--card)); --color-muted: hsl(var(--muted)); --color-muted-foreground: hsl(var(--muted-foreground)); --color-border: hsl(var(--border)); --color-primary: hsl(var(--primary)); --color-primary-foreground: hsl(var(--primary-foreground)); --color-secondary: hsl(var(--secondary)); --color-secondary-foreground: hsl(var(--secondary-foreground)); --color-accent: hsl(var(--accent)); --color-accent-foreground: hsl(var(--accent-foreground)); --color-destructive: hsl(var(--destructive)); --color-ring: hsl(var(--ring)); --color-editor-surface: hsl(var(--editor-surface)); --color-data-1: hsl(var(--data-1)); --color-data-2: hsl(var(--data-2)); --color-data-3: hsl(var(--data-3)); --color-data-4: hsl(var(--data-4)); --color-data-5: hsl(var(--data-5)); --color-data-6: hsl(var(--data-6)); }
:root {
  --color-background-primary: hsl(var(--background)); --color-background-secondary: hsl(var(--muted)); --color-background-tertiary: hsl(var(--secondary));
  --color-text-primary: hsl(var(--foreground)); --color-text-secondary: hsl(var(--muted-foreground)); --color-text-tertiary: hsl(var(--muted-foreground));
  --color-border-primary: hsl(var(--muted-foreground)); --color-border-secondary: hsl(var(--border)); --color-border-tertiary: hsl(var(--border));
  --color-background-info: hsl(var(--data-1) / .12); --color-background-success: hsl(var(--data-2) / .12); --color-background-warning: hsl(var(--data-3) / .12); --color-background-danger: hsl(var(--destructive) / .12);
  --color-text-info: hsl(var(--data-1)); --color-text-success: hsl(var(--data-2)); --color-text-warning: hsl(var(--data-3)); --color-text-danger: hsl(var(--destructive));
  --color-border-info: hsl(var(--data-1)); --color-border-success: hsl(var(--data-2)); --color-border-warning: hsl(var(--data-3)); --color-border-danger: hsl(var(--destructive));
  --font-sans: ui-sans-serif, system-ui, sans-serif; --font-serif: Georgia, serif; --font-mono: ui-monospace, monospace;
  --border-radius-md: .5rem; --border-radius-lg: .75rem; --border-radius-xl: 1rem;
}
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
` + paletteStyles;

/** Static iframe document. Widget source is sent later through the checked message channel. */
export function createWidgetSrcDoc(channel: string): string {
  const bootstrap = widgetBootstrap.replace("__MONA_CHANNEL__", JSON.stringify(channel));
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv=\"Content-Security-Policy\" content=\"${contentSecurityPolicy}\">`,
    `<style>${frameStyles}</style>`,
    `<script>${htmlToImageUmd}</script>`,
    "</head><body><div id=\"widget-root\"></div>",
    `<script>${bootstrap}</script>`,
    "</body></html>",
  ].join("");
}

export function createStandaloneWidgetHtml(code: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv=\"Content-Security-Policy\" content=\"${contentSecurityPolicy}\">`,
    `<style>${frameStyles}</style>`,
    "</head><body>",
    sanitizeForIframe(code),
    "</body></html>",
  ].join("");
}
