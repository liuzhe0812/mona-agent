import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CodeBlock } from "@/components/CodeBlock";
import { ThemeProvider } from "@/hooks/useTheme";

function renderCodeBlock(children: ReactNode) {
  return render(<ThemeProvider theme="light">{children}</ThemeProvider>);
}

function installClipboard(writeText: (text: string) => Promise<void>) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  return () => {
    if (originalDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  };
}

describe("CodeBlock rendering", () => {
  it("handles language-less fences while the real async highlighter loads", async () => {
    const { container } = renderCodeBlock(
      <>
        <CodeBlock code="plain code without a language" />
        <CodeBlock language="javascript" code="const highlightedValue = 1;" />
      </>,
    );

    await waitFor(() => expect(container.querySelector(".token")).not.toBeNull());

    expect(screen.getByText("plain code without a language")).toBeInTheDocument();
    expect(container.querySelector("code.language-text")).not.toBeNull();
    expect(container.textContent).toContain("const highlightedValue = 1;");
  });

  it("keeps the existing default wrapping and controls when conversation mode is omitted", () => {
    renderCodeBlock(<CodeBlock language="ts" code="const value = 1;" highlight={false} />);

    expect(screen.getByText("const value = 1;").closest("pre")).toHaveClass("whitespace-pre-wrap");
    expect(screen.queryByRole("button", { name: "自动换行" })).not.toBeInTheDocument();
  });

  it("starts with wrapping disabled and applies the toggle to the plain fallback", async () => {
    const user = userEvent.setup();
    const { container } = renderCodeBlock(
      <CodeBlock conversation language="ts" code="const value = 'long';" highlight={false} />,
    );
    const toggle = screen.getByRole("button", { name: "自动换行" });
    const pre = container.querySelector("pre");

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(pre).toHaveClass("whitespace-pre");
    expect(pre).not.toHaveClass("whitespace-pre-wrap");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(pre).toHaveClass("whitespace-pre-wrap", "break-words");
  });

  it("applies the default-off wrapping choice to the real highlighted renderer", async () => {
    const user = userEvent.setup();
    const { container } = renderCodeBlock(
      <CodeBlock conversation language="javascript" code="const value = 1;" />,
    );

    await waitFor(() => expect(container.querySelector(".token")).not.toBeNull());
    expect(container.querySelector("pre code")).toHaveStyle({ whiteSpace: "pre" });

    await user.click(screen.getByRole("button", { name: "自动换行" }));

    await waitFor(() => {
      expect(container.querySelector("pre code")).toHaveStyle({ whiteSpace: "pre-wrap" });
    });
  });

  it("shows Chinese success and error feedback for copy actions", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined);
    const restoreClipboard = installClipboard(writeText);

    try {
      const { rerender } = renderCodeBlock(
        <CodeBlock conversation language="ts" code="const value = 1;" highlight={false} />,
      );

      await user.click(screen.getByRole("button", { name: "复制代码" }));
      expect(writeText).toHaveBeenCalledWith("const value = 1;");
      expect(await screen.findByText("已复制")).toBeInTheDocument();

      writeText.mockRejectedValueOnce(new Error("permission denied"));
      rerender(
        <ThemeProvider theme="light">
          <CodeBlock conversation language="ts" code="const value = 1;" highlight={false} />
        </ThemeProvider>,
      );

      await user.click(screen.getByRole("button", { name: "代码已复制" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("复制失败，请检查剪贴板权限。");
    } finally {
      restoreClipboard();
    }
  });
});
