import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import { MarkdownContext, projectRelativePath } from "./MarkdownContext";
import { normalizeConversationMarkdown } from "./normalize-markdown";
import { DevelopmentTranscript } from "@/components/development/DevelopmentTranscript";
import type { DevMessage, ExecutorId } from "@/lib/development-api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const source = '# 结果\n\n| 名称 | 数值 |\n| :--- | ---: |\n| 成功 | 42 |\n\n公式 $E=mc^2$\n\n```\nconst result = 42;\n```';

describe("shared coding conversation Markdown", () => {
  it.each<ExecutorId>(["mona", "codex", "claude", "codebuddy"])("renders identical rich content for %s", async (authorId) => {
    const message: DevMessage = { id: authorId, authorId, role: "assistant", content: source, toolCalls: [], queued: false, truncated: false };
    const { container } = render(<MarkdownContext.Provider value={{}}><DevelopmentTranscript messages={[message]} events={[]} runs={[]} sessionId="test" /></MarkdownContext.Provider>);
    expect(await screen.findByRole("heading", { name: "结果" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "42" })).toHaveStyle({ textAlign: "right" });
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(screen.getByRole("button", { name: "复制代码" })).toBeVisible();
    expect(container.querySelector("pre code")?.textContent).toContain("const result = 42;");
  });

  it("normalizes formula delimiters and preserves prices, variables and code", () => {
    const input = '价格 $20 and $30；$5-$10；$HOME and $PATH\n\n\\(x^2\\)\n\n\\[\\sum_{i=1}^n i\\]\n\n`$20 and $30`\n\n```sh\necho $HOME $PATH\n```';
    const { container } = render(<MarkdownContext.Provider value={{}}><MarkdownTextRenderer highlightCode={false}>{input}</MarkdownTextRenderer></MarkdownContext.Provider>);
    expect(screen.getByText('价格 $20 and $30；$5-$10；$HOME and $PATH')).toBeVisible();
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("echo $HOME $PATH");
    expect(screen.getByText('$20 and $30', { selector: 'code' })).toBeVisible();
  });

  it("repairs incomplete streamed Markdown only in the display copy", () => {
    const input = '**正在输出\n\n![未完成](https://example.com/';
    expect(normalizeConversationMarkdown(input, true)).not.toContain('![未完成]');
    expect(normalizeConversationMarkdown(input, false)).toBe(input);
    expect(normalizeConversationMarkdown('```py\nprint("$20 and $30")', true)).toContain('print("$20 and $30")');
    expect(normalizeConversationMarkdown('\\[\n    x^2\n\\]', false)).toContain('$$\nx^2\n$$');
    const code = '`\\[`\n\n```text\n$20 and $30\n```\n\n    \\[not math\\]';
    expect(normalizeConversationMarkdown(code, false)).toBe(code);
  });

  it("reads Windows images from the current project and releases their blob URLs", async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-image');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const readMedia = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
    const { unmount } = render(<MarkdownContext.Provider value={{ projectId: 'project-a', rootPath: 'D:/project', readMedia }}><MarkdownTextRenderer>{'![效果](D:/project/assets/result.png)'}</MarkdownTextRenderer></MarkdownContext.Provider>);
    expect(await screen.findByRole('button', { name: '查看图片：效果' })).toBeVisible();
    expect(readMedia).toHaveBeenCalledWith('assets/result.png');
    expect(create).toHaveBeenCalledOnce();
    expect(screen.getByRole('img', { name: '效果' })).toHaveAttribute('src', 'blob:test-image');
    unmount(); expect(revoke).toHaveBeenCalledWith('blob:test-image');
  });

  it("opens file references within the current project and rejects outside paths", async () => {
    const openFile = vi.fn(async () => {});
    render(<MarkdownContext.Provider value={{ rootPath: 'D:/project', openFile }}><MarkdownTextRenderer>{'[源文件](D:/project/src/main.ts:12) 和 [其他项目](D:/other/secret.ts)'}</MarkdownTextRenderer></MarkdownContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: '源文件' }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith('src/main.ts'));
    fireEvent.click(screen.getByRole('button', { name: '其他项目' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('不在当前项目');
    expect(openFile).toHaveBeenCalledOnce();
    expect(projectRelativePath('file:///D:/project/assets/a%20b.png', 'D:/project')).toBe('assets/a b.png');
  });

  it("groups inline pictures into a keyboard-accessible gallery", async () => {
    render(<MarkdownContext.Provider value={{}}><MarkdownTextRenderer>{'![one](https://example.com/one.png)\n![two](https://example.com/two.png)'}</MarkdownTextRenderer></MarkdownContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: '查看图片：one' }));
    expect(await screen.findByText('1 / 2')).toBeVisible();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(await screen.findByText('2 / 2')).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'two' })).toBeVisible();
  });

  it("keeps HTML scripts and unsafe URLs out of the rendered output", async () => {
    const { container } = render(<MarkdownContext.Provider value={{}}><MarkdownTextRenderer>{'<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)\n\n<img src="javascript:alert(1)" onerror="alert(1)" />'}</MarkdownTextRenderer></MarkdownContext.Provider>);
    await act(async () => {});
    expect(container.querySelector('script,[onerror],[href^="javascript:"],[src^="javascript:"]')).toBeNull();
  });
});
