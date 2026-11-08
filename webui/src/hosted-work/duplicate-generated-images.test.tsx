import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageBubble } from "@/components/MessageBubble";
import { ConversationFileContext } from "@/components/deliver/ConversationFileContext";
import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import { configureHostedPlatform } from "@/lib/hosted-platform";
import type { DeliveredFile, UIMessage } from "@/lib/types";
import { duplicateGeneratedImageSources } from "./duplicate-generated-images";

const digest = "ec96a0b9d5e1dbee39fee629718786b3923094a99b2f2c780e01722ac1a3b1ab";
const operation = "a170677fabe1fbb6d3f486ab16cd4e06";
const previewPath = `/workspace/.generated-previews/3f627c11f66e2e5484dc48b87f671079/${operation}/${digest}.png`;
const artifactPath = "/workspace/generated/2026-11-08/img_238a1596520d47a0b6ff492564fbd855.png";
const url = `${location.origin}/api/work/desktop/generated-media/${"e".repeat(43)}`;
const preview: DeliveredFile = { path: previewPath, absolute_path: previewPath, name: `image-${operation}.png`,
  size: 10, size_human: "10 B", mime: "image/png", sha256: digest };
const artifact: DeliveredFile = { path: artifactPath.slice("/workspace/".length), absolute_path: artifactPath,
  name: artifactPath.split("/").pop()!, size: 10, size_human: "10 B", mime: "image/png", sha256: digest };
const media = [{ kind: "image" as const, url, name: preview.name }];
const releases: Array<() => void> = [];

afterEach(() => {
  cleanup();
  while (releases.length) releases.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hosted duplicate Markdown images", () => {
  it.each([`sandbox:${artifactPath}`, ` ${artifactPath}`])(
    "hides the verified duplicate %s while keeping the real image visible", async (source) => {
      releases.push(configureHostedPlatform({ apiBase: "/api/work/desktop", token: "test-account" }));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]),
        { headers: { "Content-Type": "image/png" } })));
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:delivered");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
      // ThreadShell removes file cards here but preserves the two original file
      // records for same-message, same-digest duplicate verification.
      const message: UIMessage = { id: "test", role: "assistant", createdAt: 1,
        content: `结果：![红色小猫图标](${source})`, inlineMediaFiles: [preview, artifact], media };
      render(<ConversationFileContext.Provider value={{ sessionKey: `websocket:${"1".repeat(32)}`,
        scope: "shared", download: vi.fn(), onError: vi.fn() }}><MessageBubble message={message} /></ConversationFileContext.Provider>);
      expect(await screen.findByAltText(preview.name)).toHaveAttribute("src", "blob:delivered");
      await screen.findByText("结果：");
      expect(screen.queryByAltText("红色小猫图标")).not.toBeInTheDocument();
    },
  );

  it("requires the same account, original path, delivered preview name and digest", () => {
    expect(duplicateGeneratedImageSources([preview, artifact], media)).toEqual([]);
    releases.push(configureHostedPlatform({ apiBase: "/api/work/desktop", token: "test-account" }));
    expect(duplicateGeneratedImageSources([preview, artifact], media)).toEqual([`sandbox:${artifactPath}`, artifactPath]);
    expect(duplicateGeneratedImageSources([preview, { ...artifact, sha256: "f".repeat(64) }], media)).toEqual([]);
    expect(duplicateGeneratedImageSources([preview, { ...artifact, path: "different.png" }], media)).toEqual([]);
    expect(duplicateGeneratedImageSources([preview, artifact], [{ ...media[0], name: "different.png" }])).toEqual([]);
    expect(duplicateGeneratedImageSources([preview, artifact], [{ ...media[0], url: url.replace(location.origin, "https://other.invalid") }])).toEqual([]);
    expect(duplicateGeneratedImageSources([preview, artifact], [])).toEqual([]);
  });

  it("does not suppress unverified Markdown images, links, code or external URLs", async () => {
    render(<MarkdownTextRenderer duplicateImageSources={[`sandbox:${artifactPath}`, artifactPath]}>{[
      `![duplicate](sandbox:${artifactPath})`,
      `![duplicate-workspace]( ${artifactPath})`,
      `![other](sandbox:/workspace/generated/other.png)`,
      `![other-workspace]( /workspace/generated/other.png)`,
      `![external](https://example.test/other.png)`,
      `[link](sandbox:${artifactPath})`,
      `\`![code](sandbox:${artifactPath})\``,
    ].join("\n\n")}</MarkdownTextRenderer>);
    expect(screen.queryByAltText("duplicate")).not.toBeInTheDocument();
    expect(screen.queryByAltText("duplicate-workspace")).not.toBeInTheDocument();
    expect(screen.getByAltText("other")).toBeInTheDocument();
    expect(screen.getByAltText("other-workspace")).toBeInTheDocument();
    expect(screen.getByAltText("external")).toHaveAttribute("src", "https://example.test/other.png");
    expect(screen.getByText("link")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(`![code](sandbox:${artifactPath})`)).toBeInTheDocument());
  });
});
