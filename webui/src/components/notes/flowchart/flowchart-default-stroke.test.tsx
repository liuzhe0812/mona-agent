/**
 * 默认边框回归测试（FC-P0-02）。
 *
 * 根因：`--border` 的实际值是 HSL 三元组（如 `0 0% 89.8%`），
 * 直接作为 SVG stroke 属性无效，导致新建形状在画布上看不到边框。
 * 修复：默认 stroke 统一使用 `var(--flowchart-node-border)`（已包装 hsl()）。
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { renderFlowchartShape } from "./flowchart-shapes";

describe("默认边框 token", () => {
  it("无自定义 stroke 的矩形使用主题类，不输出无效的 var(--border)", () => {
    const node = renderFlowchartShape("process");
    const { container } = render(<svg>{node}</svg>);
    const rect = container.querySelector("rect");
    expect(rect).not.toBeNull();
    // 主题 token 通过 className 提供（fill-card stroke-border → hsl(var(--border))）
    expect(rect!.getAttribute("class")).toContain("stroke-border");
    // 内联 style 不得包含无效的 var(--border)
    expect(rect!.getAttribute("style") ?? "").not.toContain("var(--border)");
  });

  it("annotation 主线默认 stroke 使用 flowchart token", () => {
    const node = renderFlowchartShape("annotation");
    const { container } = render(<svg>{node}</svg>);
    const path = container.querySelector("path");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("stroke")).toBe("var(--flowchart-node-border)");
  });

  it("annotation 用户自定义 stroke 优先", () => {
    const node = renderFlowchartShape("annotation", { stroke: "#123456" });
    const { container } = render(<svg>{node}</svg>);
    const path = container.querySelector("path");
    expect(path!.getAttribute("stroke")).toBe("#123456");
  });
});
