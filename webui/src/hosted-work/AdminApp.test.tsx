import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApp } from "./AdminApp";

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("hosted model administration", () => {
  it("asks for administrator login without making a request if there is no session", () => {
    render(<AdminApp />);
    expect(screen.getByRole("link", { name: "前往管理员登录" })).toHaveAttribute("href", "/admin");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the website administrator session and preserves it if access is denied", async () => {
    sessionStorage.setItem("mona-website-session-v1", JSON.stringify({ token: "website-session", user: { id: "admin" } }));
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    }));
    render(<AdminApp />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("没有管理权限")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "前往管理员登录" })).toHaveAttribute("href", "/admin");
    expect(sessionStorage.getItem("mona-website-session-v1")).toContain("website-session");
    expect(fetch).toHaveBeenCalledWith("/api/work/admin/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer website-session" }), credentials: "omit",
    }));
    expect(document.querySelector("main")).toHaveClass("h-full", "overflow-y-auto");
  });
});
