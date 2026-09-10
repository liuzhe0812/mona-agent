import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SplitPane } from "@/components/deliver/SplitPane";

describe("SplitPane", () => {
  it("lets the right sidebar replace the conversation while maximized", () => {
    const { rerender } = render(
      <SplitPane
        left={<div>conversation</div>}
        right={<div>overview</div>}
        ratio={0.7}
        onRatioChange={vi.fn()}
        rightVisible
      />,
    );
    expect(screen.getByText("conversation")).toBeInTheDocument();
    expect(screen.getByText("overview")).toBeInTheDocument();

    rerender(
      <SplitPane
        left={<div>conversation</div>}
        right={<div>overview</div>}
        ratio={0.7}
        onRatioChange={vi.fn()}
        rightVisible
        rightMaximized
      />,
    );
    expect(screen.queryByText("conversation")).not.toBeInTheDocument();
    expect(screen.getByText("overview")).toBeInTheDocument();
  });

  it("keeps a stateful right editor mounted while collapsed", () => {
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    function StatefulEditor() {
      useEffect(() => {
        onMount();
        return onUnmount;
      }, []);
      return <div>office editor</div>;
    }
    const { rerender } = render(
      <SplitPane
        left={<div>conversation</div>}
        right={<StatefulEditor />}
        ratio={0.6}
        onRatioChange={vi.fn()}
        rightVisible
        keepRightMounted
      />,
    );
    rerender(
      <SplitPane
        left={<div>conversation</div>}
        right={<StatefulEditor />}
        ratio={0.6}
        onRatioChange={vi.fn()}
        rightVisible={false}
        keepRightMounted
      />,
    );

    expect(screen.getByText("office editor")).toBeInTheDocument();
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();
  });

  it("notifies once when a leftward drag leaves the conversation pane too narrow", () => {
    const onLeftPaneNarrow = vi.fn();
    const { container } = render(
      <SplitPane
        left={<div>conversation</div>}
        right={<div>overview</div>}
        ratio={0.7}
        onRatioChange={vi.fn()}
        onLeftPaneNarrow={onLeftPaneNarrow}
        rightVisible
      />,
    );
    const splitPane = container.firstElementChild as HTMLDivElement;
    vi.spyOn(splitPane, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 1_000,
      bottom: 800,
      width: 1_000,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const divider = container.querySelector(".cursor-col-resize") as HTMLDivElement;
    Object.defineProperty(divider, "setPointerCapture", { value: vi.fn() });

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 700 });
    fireEvent.pointerMove(splitPane, { pointerId: 1, clientX: 480 });
    fireEvent.pointerMove(splitPane, { pointerId: 1, clientX: 420 });

    expect(onLeftPaneNarrow).toHaveBeenCalledOnce();
  });
});
