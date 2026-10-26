import { describe, expect, it } from "vitest";
import { guessContentType, uint8ToBase64 } from "./fileBytes";

describe("uint8ToBase64", () => {
  it("与标准 base64 一致", () => {
    expect(uint8ToBase64(new Uint8Array([0, 1, 2]))).toBe("AAEC");
    expect(uint8ToBase64(new Uint8Array([0xfd, 0xfe, 0xff]))).toBe("/f7/");
    expect(uint8ToBase64(new Uint8Array([]))).toBe("");
  });

  it("大文件不再爆栈（原实现用 Spread 会 RangeError）", () => {
    const bytes = new Uint8Array(300 * 1024).fill(0xff);
    const result = uint8ToBase64(bytes);
    expect(result.length).toBe(Math.ceil(bytes.length / 3) * 4);
    expect(result.startsWith("////")).toBe(true);
  });
});

describe("guessContentType", () => {
  it("按扩展名推断常见类型", () => {
    expect(guessContentType("报告.PDF")).toBe("application/pdf");
    expect(guessContentType("a.b.zip")).toBe("application/zip");
    expect(guessContentType("pic.jpeg")).toBe("image/jpeg");
    expect(guessContentType("setup.exe")).toBe(
      "application/vnd.microsoft.portable-executable",
    );
  });

  it("未知类型回退 octet-stream", () => {
    expect(guessContentType("unknown.zzz")).toBe("application/octet-stream");
    expect(guessContentType("noext")).toBe("application/octet-stream");
  });
});
