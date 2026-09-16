import { describe, expect, it } from "vitest";
import type { ProfileArtifact } from "@/lib/profile-api";
import { artifactCategory } from "./profile-categories";

describe("artifact categories", () => {
  it.each([
    [null, "方案.PPTX", "文档"],
    ["application/octet-stream", "数据.xlsx", "文档"],
    [null, "app.tsx", "代码"],
    ["text/css", "样式", "代码"],
    ["image/png", "截图", "图像"],
    ["audio/mpeg", "录音", "音频"],
    [null, "演示.mp4", "视频"],
    ["application/zip", "打包成果", "压缩包"],
    ["application/octet-stream", "未命名", null],
  ])("classifies %s / %s as %s", (mime, title, expected) => {
    expect(artifactCategory({ mime, title, artifact_ref: {} } as ProfileArtifact)).toBe(expected);
  });

  it("uses the source filename when the display title has no extension", () => {
    expect(artifactCategory({ mime: null, title: "数据", artifact_ref: { relative_path: "成果/数据.xlsx" } } as ProfileArtifact)).toBe("文档");
  });
});
