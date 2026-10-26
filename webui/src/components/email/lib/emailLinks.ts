import { openBrowserUrl } from "@/lib/browser-ipc";

export async function openEmailLink(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    switch (parsed.protocol) {
      case "http:":
      case "https:":
        await openBrowserUrl(parsed.href);
        return;
      case "mailto:":
      case "tel:": {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(parsed.href);
        return;
      }
      default:
        throw new Error("Unsupported email link protocol");
    }
  } catch {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message("链接未能打开，请重试", { title: "打开链接失败", kind: "error" });
  }
}
