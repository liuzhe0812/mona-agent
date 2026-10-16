import { describe, expect, it } from "vitest";
import {
  createStandaloneWidgetHtml,
  createWidgetSrcDoc,
  isAllowedVisualizerCdnUrl,
  isTrustedVisualizerMessage,
  sanitizeForIframe,
  sanitizeForStreaming,
} from "./widget-sandbox";

describe("visualizer iframe sandbox", () => {
  it("accepts only exact HTTPS CDN hosts without credentials or nonstandard ports", () => {
    expect(isAllowedVisualizerCdnUrl("https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.min.js")).toBe(true);
    expect(isAllowedVisualizerCdnUrl("https://cdn.jsdelivr.net/npm/d3@7")).toBe(true);
    expect(isAllowedVisualizerCdnUrl("http://unpkg.com/library.js")).toBe(false);
    expect(isAllowedVisualizerCdnUrl("https://sub.unpkg.com/library.js")).toBe(false);
    expect(isAllowedVisualizerCdnUrl("https://unpkg.com.attacker.example/library.js")).toBe(false);
    expect(isAllowedVisualizerCdnUrl("https://user@unpkg.com/library.js")).toBe(false);
    expect(isAllowedVisualizerCdnUrl("https://unpkg.com:8443/library.js")).toBe(false);
  });

  it("preserves final interaction handlers inside the sandbox while removing embedded browsing contexts", () => {
    const source = [
      '<div onclick="steal()">body</div>',
      '<form action="https://outside.example"><button>submit</button></form>',
      '<iframe><script>badFrame()</script><b>fallback</b></iframe>',
      '<object data="https://outside.example/file"></object><embed src="https://outside.example/a">',
      '<base href="https://outside.example"><meta http-equiv="refresh"><link rel="stylesheet">',
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.min.js"></script>',
      '<script src="https://cdnjs.cloudflare.com.evil.test/chart.js">badExternal()</script>',
      '<script>finalCode()</script>',
      '<script type="application/json">{"visible":true}</script>',
      '<a href="javascript:alert(1)">unsafe link</a><a href="https://example.test/docs">safe link</a>',
    ].join("");

    const safe = sanitizeForIframe(source);
    expect(safe).toContain('<div onclick="steal()">body</div>');
    expect(safe).toContain("https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.min.js");
    expect(safe).toContain("finalCode()");
    expect(safe).toContain('{"visible":true}');
    expect(safe).toContain('data-mona-link="https://example.test/docs"');
    expect(safe).not.toMatch(/<\/?(?:form|iframe|object|embed|base|meta|link)\b/i);
    expect(safe).not.toContain("badFrame()");
    expect(safe).not.toContain("badExternal()");
    expect(safe).not.toContain("javascript:");
  });

  it("keeps data scripts in stream previews but drops executable scripts and incomplete tails", () => {
    const source = [
      '<div onmouseover="bad()">ready</div>',
      '<script>neverRun()</script>',
      '<script type="application/json">{"ok":true}</script>',
      '<iframe><b>never show</b></iframe>',
      '<style>.ready { color: red; }</style>',
      '<style>.unfinished { color:',
    ].join("");

    const safe = sanitizeForStreaming(source);
    expect(safe).toContain("ready");
    expect(safe).toContain('{"ok":true}');
    expect(safe).toContain(".ready { color: red; }");
    expect(safe).not.toContain("neverRun()");
    expect(safe).not.toContain("never show");
    expect(safe).not.toContain("unfinished");
    expect(safe).not.toMatch(/\bonmouseover\s*=/i);
    expect(sanitizeForStreaming("<div>complete</div><span class=\"partial\"")).toBe("<div>complete</div>");
  });

  it("keeps widget source out of the stable srcDoc and applies the restrictive CSP", () => {
    const first = createWidgetSrcDoc("channel-a");
    const second = createWidgetSrcDoc("channel-a");
    expect(first).toBe(second);
    expect(first).toContain("default-src 'none'");
    expect(first).toContain("script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com");
    expect(first).toContain("img-src data: blob:");
    expect(first).toContain("frame-src 'none'");
    expect(first).toContain("object-src 'none'");
    expect(first).toContain("base-uri 'none'");
    expect(first).toContain("form-action 'none'");
    expect(first).not.toContain("<svg");
    expect(first.indexOf('id="widget-root"')).toBeLessThan(first.indexOf("window.sendPrompt"));
    const exported = createStandaloneWidgetHtml("<svg><script>safeFinalScript()</script><circle onload=\"bad()\" /></svg>");
    expect(exported).toContain("safeFinalScript()");
    expect(exported).toContain("onload=");
  });

  it("requires both the iframe window source and the per-frame token", () => {
    const sourceWindow = window;
    const otherWindow = {} as Window;
    const frame = { contentWindow: sourceWindow } as HTMLIFrameElement;
    expect(isTrustedVisualizerMessage({ source: sourceWindow, data: { channel: "secret" } }, frame, "secret")).toBe(true);
    expect(isTrustedVisualizerMessage({ source: otherWindow, data: { channel: "secret" } }, frame, "secret")).toBe(false);
    expect(isTrustedVisualizerMessage({ source: sourceWindow, data: { channel: "wrong" } }, frame, "secret")).toBe(false);
    expect(isTrustedVisualizerMessage({ source: sourceWindow, data: null }, frame, "secret")).toBe(false);
  });
});
