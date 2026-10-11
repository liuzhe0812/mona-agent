import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DevelopmentPermissionSelector } from "./DevelopmentPermissionSelector";

it("selects a permission mode and locks out repeated changes while saving", async () => {
  let finish!: () => void;
  const onChange = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<DevelopmentPermissionSelector mode="ask" onChange={onChange} />);

  fireEvent.pointerDown(screen.getByRole("button", { name: "权限模式：请求批准" }), { button: 0, ctrlKey: false });
  const automatic = await screen.findByRole("menuitem", { name: "自动审批" });
  fireEvent.click(automatic);
  fireEvent.click(automatic);

  await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  expect(onChange).toHaveBeenCalledWith("auto");
  expect(screen.getByRole("button", { name: "权限模式：请求批准" })).toBeDisabled();

  finish();
  await waitFor(() => expect(screen.getByRole("button", { name: "权限模式：请求批准" })).not.toBeDisabled());
});

it("shows read-only state without offering permission changes", () => {
  render(<DevelopmentPermissionSelector mode="ask" readonly onChange={vi.fn()} />);

  const control = screen.getByRole("button", { name: "权限模式：只读" });
  expect(control).toBeDisabled();
  expect(control).toHaveTextContent("只读");
  fireEvent.click(control);
  expect(screen.queryByRole("menuitem")).toBeNull();
});
