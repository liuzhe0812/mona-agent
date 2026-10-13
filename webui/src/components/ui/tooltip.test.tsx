import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";
import { TooltipButton } from "./tooltip";

describe("TooltipButton", () => {
  it("shows a custom hint on focus and keeps the button ref and action", async () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    render(<TooltipButton ref={ref} title="关系图" onClick={onClick}>图标</TooltipButton>);

    const button = screen.getByRole("button", { name: "关系图" });
    expect(ref.current).toBe(button);
    expect(button).not.toHaveAttribute("title");
    fireEvent.focus(button);
    expect(await screen.findByRole("tooltip", { name: "关系图" })).toBeInTheDocument();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("shows the hint for a disabled button without enabling its action", async () => {
    const onClick = vi.fn();
    render(<TooltipButton title="撤销" disabled onClick={onClick}>图标</TooltipButton>);

    const button = screen.getByRole("button", { name: "撤销" });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("title");
    fireEvent.pointerMove(button.parentElement!, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip", { name: "撤销" })).toBeInTheDocument();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("still opens a dropdown when used as its trigger", async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild><TooltipButton title="更多">图标</TooltipButton></DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem onSelect={onSelect}>重命名</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "更多" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
