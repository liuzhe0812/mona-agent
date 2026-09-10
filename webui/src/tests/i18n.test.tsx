import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { resources } from "@/i18n";

const QUICK_ACTION_KEYS = ["plan", "analyze", "brainstorm", "code", "summarize", "more"];
const IMAGE_QUICK_ACTION_KEYS = ["icon", "sticker", "poster", "product", "portrait", "edit"];
const SETTINGS_NAV_KEYS = [
  "billing",
  "usage",
  "general",
  "resources",
  "appearance",
  "models",
  "providers",
  "image",
  "advanced",
];
const AUTOMATION_KEY_PATHS = [
  "title",
  "loading",
  "loadError",
  "updateError",
  "cancelError",
  "permissionError",
  "computerError",
  "browser.title",
  "browser.description",
  "browser.toggle",
  "computer.title",
  "computer.description",
  "computer.toggle",
  "computer.downloading",
  "computer.progress",
  "cancel",
  "unsupported.title",
  "unsupported.description",
  "authorization.title",
  "authorization.description",
  "authorize",
  "error.title",
  "retry",
  "notInstalled.title",
  "notInstalled.description",
  "download",
  "states.disabled",
  "states.notInstalled",
  "states.downloading",
  "states.pendingAuthorization",
  "states.available",
  "states.error",
];

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

describe("webui i18n", () => {
  it("switches UI copy and document locale through the language switcher", async () => {
    const user = userEvent.setup();

    render(
      <>
        <LanguageSwitcher />
        <ThreadComposer onSend={vi.fn()} />
      </>,
    );

    expect(
      screen.getByPlaceholderText("Type your message…"),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");

    await user.click(screen.getByRole("button", { name: "Change language" }));
    await user.click(screen.getByRole("menuitemradio", { name: /简体中文/i }));

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("zh-CN");
    });
    expect(localStorage.getItem("mona.locale")).toBe("zh-CN");
    expect(screen.getByPlaceholderText("有什么事情，交给Mona吧")).toBeInTheDocument();
  });

  it("updates the composer aria label when the language changes", async () => {
    render(<ThreadComposer onSend={vi.fn()} />);

    await act(async () => {
      const { setAppLanguage } = await import("@/i18n");
      await setAppLanguage("zh-TW");
    });

    expect(screen.getByLabelText("訊息輸入框")).toBeInTheDocument();
  });

  it("keeps welcome quick actions localized for every registered locale", () => {
    for (const resource of Object.values(resources)) {
      const empty = resource.common.thread.empty;
      expect(empty.greeting).toBeTruthy();
      for (const key of QUICK_ACTION_KEYS) {
        const action = empty.quickActions[key as keyof typeof empty.quickActions];
        expect(action.title).toBeTruthy();
        expect(action.prompt).toBeTruthy();
      }
      for (const key of IMAGE_QUICK_ACTION_KEYS) {
        const action = empty.imageQuickActions[key as keyof typeof empty.imageQuickActions];
        expect(action.title).toBeTruthy();
        expect(action.prompt).toBeTruthy();
      }
    }
  });

  it("keeps settings navigation localized for every registered locale", () => {
    for (const resource of Object.values(resources)) {
      const common = resource.common;
      expect(common.app.system.restarting).toBeTruthy();
      expect(common.sidebar.settings).toBeTruthy();
      expect(common.chat.showMore).toBeTruthy();
      expect(common.settings.sidebar.title).toBeTruthy();
      expect(common.settings.backToChat).toBeTruthy();
      for (const key of SETTINGS_NAV_KEYS) {
        expect(common.settings.nav[key as keyof typeof common.settings.nav]).toBeTruthy();
      }
      expect(common.settings.rows.theme).toBeTruthy();
      expect(common.settings.sections.runtimeParameters).toBeTruthy();
      expect(common.settings.status.loading).toBeTruthy();
      expect(common.settings.actions.save).toBeTruthy();
      expect(common.settings.actions.edit).toBeTruthy();
      expect(common.settings.byok.configured).toBeTruthy();
      expect(common.settings.byok.configuredSection).toBeTruthy();
      expect(common.settings.byok.showMore).toBeTruthy();
      expect(common.settings.byok.apiKeyRequired).toBeTruthy();
      expect(common.settings.byok.showApiKey).toBeTruthy();
      expect(common.settings.byok.hideApiKey).toBeTruthy();
      expect(common.settings.byok.configuredKeyHint).toBeTruthy();
      expect(common.settings.shortcuts.messageInput).toBeTruthy();
      expect(common.settings.shortcuts.sendMessage).toBeTruthy();
      expect(common.settings.shortcuts.sendMessageHelp).toBeTruthy();
      expect(common.settings.shortcuts.enterToSend).toBeTruthy();
      expect(common.settings.shortcuts.ctrlEnterToSend).toBeTruthy();
    }
  });

  it("keeps automation settings localized for every registered locale", () => {
    for (const resource of Object.values(resources)) {
      for (const key of AUTOMATION_KEY_PATHS) {
        expect(readPath(resource.common.settings, `automation.${key}`)).toBeTruthy();
      }
    }
  });

  it("keeps Simplified Chinese settings copy localized", () => {
    const settings = resources["zh-CN"].common.settings;

    expect(settings.nav.general).toBe("通用");
    expect(settings.sections.webSearch).toBe("网页搜索");
    expect(settings.byok.tabs.webSearch).toBe("网页搜索");
    expect(settings.shortcuts.messageInput).toBe("消息输入");
    expect(settings.shortcuts.sendMessage).toBe("发送消息");
  });

  it("uses the billing navigation copy for English and Simplified Chinese", () => {
    expect(resources.en.common.settings.nav.general).toBe("General");
    expect(resources.en.common.settings.nav.billing).toBe("Balance & billing");
    expect(resources.en.common.settings.nav.usage).toBe("Usage");
    expect(resources["zh-CN"].common.settings.nav.general).toBe("通用");
    expect(resources["zh-CN"].common.settings.nav.billing).toBe("余额与充值");
    expect(resources["zh-CN"].common.settings.nav.usage).toBe("用量统计");
  });
});
