import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/hooks/useTheme";
import { DevelopmentFileEditor } from "./DevelopmentFileEditor";

afterEach(cleanup);
describe("development file syntax colors", () => {
  it("colors TypeScript and HTML without changing editable source, and follows theme changes", async () => {
    const onChange = vi.fn(); const onSave = vi.fn();
    const source = 'const title: string = "你好";\n';
    const show = (path: string, value: string, theme: "light" | "dark") => <ThemeProvider theme={theme}>
      <DevelopmentFileEditor path={path} value={value} onChange={onChange} onSave={onSave} />
    </ThemeProvider>;
    const view = render(show("example.ts", source, "light"));
    const preview = view.container.querySelector("pre")!;
    await waitFor(() => expect(preview.querySelectorAll("span").length).toBeGreaterThan(3));
    expect(preview).toHaveStyle({ visibility: "visible" });
    expect(new Set([...preview.querySelectorAll("span")].map((span) => span.style.color)).size).toBeGreaterThan(2);
    expect(preview.textContent).toBe(`${source}\n`);
    expect(screen.getByRole("textbox", { name: "项目文件编辑器" })).toHaveValue(source);
    const lightColors = [...preview.querySelectorAll("span")].map((span) => span.style.color);
    view.rerender(show("example.ts", source, "dark"));
    await waitFor(() => expect(preview).toHaveStyle({ visibility: "visible" }));
    expect([...preview.querySelectorAll("span")].map((span) => span.style.color)).not.toEqual(lightColors);
    const html = '<div class="title">你好</div>';
    view.rerender(show("index.html", html, "dark"));
    await waitFor(() => expect(preview).toHaveStyle({ visibility: "visible" }));
    expect(preview.textContent).toBe(`${html}\n`);
    expect(preview.querySelector("div")).toBeNull();
    expect(new Set([...preview.querySelectorAll("span")].map((span) => span.style.color)).size).toBeGreaterThan(2);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
  it("updates syntax after a same-length edit in the middle of a file and keeps both scroll axes aligned", async () => {
    const onChange = vi.fn(); const onSave = vi.fn();
    const before = `${"// prefix\n".repeat(20)}const middle = 1;\n${"// suffix\n".repeat(20)}`;
    const after = before.replace("middle = 1", "middle = 2");
    const view = render(<DevelopmentFileEditor path="file.ts" value={before} onChange={onChange} onSave={onSave} />);
    const preview = view.container.querySelector("pre")!;
    await waitFor(() => expect(preview).toHaveStyle({ visibility: "visible" }));
    view.rerender(<DevelopmentFileEditor path="file.ts" value={after} onChange={onChange} onSave={onSave} />);
    await waitFor(() => expect(preview).toHaveStyle({ visibility: "visible" }));
    expect(preview.textContent).toBe(`${after}\n`);
    const editor = screen.getByRole("textbox", { name: "项目文件编辑器" });
    Object.defineProperties(editor, { clientWidth: { value: 500 }, clientHeight: { value: 400 } });
    editor.scrollTop = 100; editor.scrollLeft = 70; fireEvent.scroll(editor);
    expect(preview.scrollTop).toBe(100); expect(preview.scrollLeft).toBe(70);
    expect(preview).toHaveStyle({ width: "500px", height: "400px" });
  });
  it("keeps plain text editable and routes Ctrl/Cmd+S to explicit saving", () => {
    const onChange = vi.fn(); const onSave = vi.fn();
    const view = render(<DevelopmentFileEditor path="notes.txt" value="plain text" onChange={onChange} onSave={onSave} />);
    const editor = screen.getByRole("textbox", { name: "项目文件编辑器" });
    expect(editor).toHaveValue("plain text");
    expect(view.container.querySelector("pre")).toHaveStyle({ visibility: "hidden" });
    expect(editor.style.color).not.toBe("transparent");
    fireEvent.change(editor, { target: { value: "my edit" } });
    expect(onChange).toHaveBeenCalledWith("my edit");
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    expect(onSave).toHaveBeenCalledTimes(2);
  });
});
