import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownTable } from "./MarkdownTable";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function restoreProperty(target: object, name: PropertyKey, descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else Reflect.deleteProperty(target, name);
}

afterEach(() => {
  restoreProperty(navigator, "clipboard", clipboardDescriptor);
  restoreProperty(URL, "createObjectURL", createObjectUrlDescriptor);
  restoreProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
  vi.restoreAllMocks();
});

describe("MarkdownTable", () => {
  it("copies the rendered cells as an aligned Markdown table", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);

    render(
      <MarkdownTable aria-label="结果表" node={{ type: "table" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "right" }}>字段|名</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>a|b</td>
            <td>通过</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );

    const table = screen.getByRole("table", { name: "结果表" });
    expect(table).toHaveTextContent("字段|名");
    expect(table).not.toHaveAttribute("node");
    fireEvent.click(screen.getByRole("button", { name: "复制 Markdown" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "| 字段\\|名 | 状态 |\n| ---: | --- |\n| a\\|b | 通过 |",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent("已复制为 Markdown");
  });

  it("downloads escaped CSV and prefixes formula-like cells as text", async () => {
    let downloadedBlob: Blob | null = null;
    let downloadName = "";
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        downloadedBlob = blob;
        return "blob:markdown-table";
      }),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        downloadName = this.download;
      },
    );

    render(
      <MarkdownTable>
        <thead>
          <tr>
            <th>名称</th>
            <th>金额</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>含逗号,和"引号"</td>
            <td>=SUM(1,2)</td>
          </tr>
          <tr>
            <td>普通值</td>
            <td>-1</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );

    fireEvent.click(screen.getByRole("button", { name: "下载 CSV" }));

    expect(downloadName).toBe("table.csv");
    expect(downloadedBlob).not.toBeNull();
    const blob = downloadedBlob;
    if (!blob) throw new Error("CSV Blob was not created");
    await expect(blob.text()).resolves.toBe(
      '\uFEFF"名称","金额"\r\n"含逗号,和""引号""","\'=SUM(1,2)"\r\n"普通值","\'-1"',
    );
    expect(screen.getByRole("status")).toHaveTextContent("CSV 已开始下载");
  });

  it("shows the same table in the preview dialog", async () => {
    render(
      <MarkdownTable>
        <thead>
          <tr>
            <th>名称</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>长表格内容</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );

    fireEvent.click(screen.getByRole("button", { name: "表格预览" }));

    const dialog = await screen.findByRole("dialog", { name: "表格预览" });
    expect(dialog).toHaveTextContent("长表格内容");
    expect(dialog.querySelector("table")).toBeInTheDocument();
  });

  it("shows a visible error when clipboard access fails", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("权限不可用")));

    render(
      <MarkdownTable>
        <thead>
          <tr>
            <th>名称</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>内容</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );

    fireEvent.click(screen.getByRole("button", { name: "复制 Markdown" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("复制失败：权限不可用");
  });
});
