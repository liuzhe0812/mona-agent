import type { InlineWidgetData, UIMediaAttachment, UIMessage } from "./types";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const STATIC_ELEMENTS = new Set((
  "svg g defs symbol use title desc rect circle ellipse line polyline polygon path text tspan "
  + "textpath lineargradient radialgradient stop clippath mask pattern marker"
).split(" "));
const previewCache = new WeakMap<InlineWidgetData, UIMediaAttachment | null>();

export interface WidgetDisplayMessage extends UIMessage {
  widgetImages?: UIMediaAttachment[];
}

function staticImage(widget: InlineWidgetData): UIMediaAttachment | null {
  if (typeof widget.code !== "string") return null;
  const source = widget.code.trim();
  if (!/^<svg(?=\s|>)/.test(source) || /<!\s*(?:doctype|entity)|<\?/i.test(source)) return null;
  try {
    const document = new DOMParser().parseFromString(source, "image/svg+xml");
    const svg = document.documentElement;
    if (svg?.localName !== "svg" || document.querySelector("parsererror") || !svg.getAttribute("viewBox")) return null;
    for (const node of [svg, ...svg.querySelectorAll("*")]) {
      if (!STATIC_ELEMENTS.has(node.localName.toLowerCase()) || (node.namespaceURI && node.namespaceURI !== SVG_NAMESPACE)) return null;
      for (const attribute of node.attributes) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on") || name === "style" || name === "xml:base") return null;
        if (attribute.localName === "href" && !/^#[\w:.-]+$/.test(attribute.value)) return null;
        const withoutLocalReferences = attribute.value.replace(/url\(\s*(['"]?)#[\w:.-]+\1\s*\)/gi, "");
        if (/url\s*\(|\\/i.test(withoutLocalReferences)) return null;
      }
    }
    if (!svg.namespaceURI) svg.setAttribute("xmlns", SVG_NAMESPACE);
    const title = widget.title?.trim() || "image";
    return {
      kind: "image",
      name: title.toLowerCase().endsWith(".svg") ? title : `${title}.svg`,
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`,
    };
  } catch {
    return null;
  }
}

function imageForWidget(widget: InlineWidgetData): UIMediaAttachment | null {
  const cached = previewCache.get(widget);
  if (cached !== undefined) return cached;
  const image = staticImage(widget);
  previewCache.set(widget, image);
  return image;
}

/** Project display-only images without changing the recorded widget events. */
export function projectStaticWidgetImages(messages: UIMessage[]): WidgetDisplayMessage[] {
  const images = new Map<UIMessage, UIMediaAttachment>();
  const laterResults = new Set<string>();
  const replaced = new Set<UIMessage>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && !message.isInjected) laterResults.clear();
    const widget = message.kind === "widget" ? message.widget : undefined;
    if (!widget) continue;
    const title = widget.title?.trim();
    const key = title ? JSON.stringify([message.taskId, message.authorId, title]) : null;
    if (widget.status === "complete") {
      const image = imageForWidget(widget);
      if (!image) continue;
      images.set(message, image);
      if (key) laterResults.add(key);
    } else if (widget.status === "error" && key && laterResults.has(key) && imageForWidget(widget)) {
      replaced.add(message);
    }
  }

  if (images.size === 0) return messages;
  const result: WidgetDisplayMessage[] = [];
  for (const message of messages) {
    if (replaced.has(message)) continue;
    const image = images.get(message);
    if (!image) {
      result.push(message);
      continue;
    }
    const previous = result.at(-1);
    if (previous?.widgetImages
      && previous.taskId === message.taskId && previous.authorId === message.authorId) {
      result[result.length - 1] = { ...previous, widgetImages: [...previous.widgetImages, image] };
    } else {
      result.push({ ...message, widgetImages: [image] });
    }
  }
  return result;
}
