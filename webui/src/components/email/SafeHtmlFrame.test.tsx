import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ openEmailLink: vi.fn() }));

vi.mock("./lib/emailLinks", () => ({ openEmailLink: mocks.openEmailLink }));

import { SafeHtmlFrame } from "./MailView";

function renderFrame(
  html: string,
  props: { onImageOpen?: (src: string) => void; onLinkClick?: (url: string) => void } = {},
) {
  const view = render(<SafeHtmlFrame html="<p>placeholder</p>" {...props} />);
  const iframe = view.getByTitle("邮件正文") as HTMLIFrameElement;
  const doc = iframe.contentDocument;
  if (!doc?.body) throw new Error("SafeHtmlFrame iframe document is unavailable");
  doc.body.innerHTML = html;
  fireEvent.load(iframe);
  return { ...view, doc, iframe };
}

function click(target: Element) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("SafeHtmlFrame email links", () => {
  beforeEach(() => mocks.openEmailLink.mockReset());
  afterEach(() => cleanup());

  it("uses the default opener once for nested text and image links and prevents iframe navigation", () => {
    const onImageOpen = vi.fn();
    const { doc } = renderFrame(
      '<a id="text-link" href="https://example.com/read" target="_blank"><span>进入查看</span></a>' +
        '<a id="image-link" href="https://example.com/image" target="_blank"><img src="https://images.example.com/picture.png"></a>',
      { onImageOpen },
    );

    expect(click(doc.querySelector("#text-link span")!)).toBe(true);
    expect(click(doc.querySelector("#image-link img")!)).toBe(true);
    expect(mocks.openEmailLink.mock.calls).toEqual([
      ["https://example.com/read"],
      ["https://example.com/image"],
    ]);
    expect(onImageOpen).not.toHaveBeenCalled();
  });

  it("normalizes protocol-relative links and preserves mailto links", () => {
    const { doc } = renderFrame(
      '<a id="protocol-relative" href="//example.com/path">网页</a>' +
        '<a id="mailto" href="mailto:person@example.com?subject=Hello">邮件</a>',
    );

    expect(click(doc.querySelector("#protocol-relative")!)).toBe(true);
    expect(click(doc.querySelector("#mailto")!)).toBe(true);
    expect(mocks.openEmailLink.mock.calls).toEqual([
      ["https://example.com/path"],
      ["mailto:person@example.com?subject=Hello"],
    ]);
  });

  it("blocks unsupported schemes and keeps the iframe sandboxed without scripts", () => {
    const { doc, iframe } = renderFrame(
      '<a id="javascript" href="javascript:alert(1)" target="_blank">a</a>' +
        '<a id="file" href="file:///private/item" target="_blank">b</a>' +
        '<a id="data" href="data:text/html,unsafe" target="_blank">c</a>',
    );

    for (const id of ["javascript", "file", "data"]) {
      expect(click(doc.querySelector(`#${id}`)!)).toBe(true);
    }
    expect(mocks.openEmailLink).not.toHaveBeenCalled();
    expect(iframe.getAttribute("sandbox")).toContain("allow-same-origin");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-scripts");
  });

  it("uses an explicitly supplied link callback", () => {
    const onLinkClick = vi.fn();
    const { doc } = renderFrame(
      '<a id="custom-link" href="https://example.com/custom" target="_blank">自定义</a>',
      { onLinkClick },
    );

    expect(click(doc.querySelector("#custom-link")!)).toBe(true);
    expect(onLinkClick).toHaveBeenCalledOnce();
    expect(onLinkClick).toHaveBeenCalledWith("https://example.com/custom");
    expect(mocks.openEmailLink).not.toHaveBeenCalled();
  });
});
