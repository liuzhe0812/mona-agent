import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLicense = vi.hoisted(() => ({ loggedIn: false, licenseInfo: null }));
const isTauriMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/components/email/store/emailStore", () => ({
  useEmailStore: (selector: (state: { totalUnreadCount: number }) => unknown) =>
    selector({ totalUnreadCount: 0 }),
}));
vi.mock("@/components/schedule/todoStore", () => ({
  useTodoStore: (selector: (state: { inboxCount: number }) => unknown) =>
    selector({ inboxCount: 0 }),
}));
vi.mock("@/hooks/useLicense", () => ({ useLicense: () => mockLicense }));
vi.mock("@/lib/tauri", () => ({ isTauri: isTauriMock }));

import { AppRail } from "./AppRail";
import { MODULE_DEFS } from "@/components/Sidebar";

const MODULE_KEYS = [
  "note",
  "doc",
  "email",
  "schedule",
  "db",
  "system",
  "profile",
  "stock",
  "development",
] as const;

type RailProps = Parameters<typeof AppRail>[0];

function modulesInOrder(
  orderedKeys: readonly string[],
  hiddenKeys: readonly string[] = [],
): NonNullable<RailProps["modules"]> {
  return MODULE_DEFS.map((definition, index) => {
    const key = definition.key;
    const position = orderedKeys.indexOf(key);
    return {
      key,
      visible: position >= 0 && !hiddenKeys.includes(key),
      order: position >= 0 ? position : orderedKeys.length + index,
    };
  }) as NonNullable<RailProps["modules"]>;
}

function railProps(extra: Partial<RailProps> = {}): RailProps {
  const noop = () => {};
  return {
    activeView: "chat",
    onGoHome: noop,
    onOpenMessages: noop,
    onOpenNote: noop,
    onOpenDoc: noop,
    onOpenSSH: noop,
    onOpenDb: noop,
    onOpenEmail: noop,
    onOpenSchedule: noop,
    onOpenSystem: noop,
    onOpenProfile: noop,
    onOpenStock: noop,
    onOpenSettings: noop,
    ...extra,
  };
}

function renderRail(extra: Partial<RailProps> = {}) {
  return render(<AppRail {...railProps(extra)} />);
}

function dispatchKeyDown(
  init: KeyboardEventInit,
  options: { preventDefault?: boolean; altGraph?: boolean } = {},
) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, "getModifierState", {
    value: (modifier: string) => {
      if (modifier === "AltGraph") return options.altGraph ?? false;
      if (modifier === "Alt") return event.altKey;
      if (modifier === "Control") return event.ctrlKey;
      if (modifier === "Meta") return event.metaKey;
      if (modifier === "Shift") return event.shiftKey;
      return false;
    },
  });
  if (options.preventDefault) event.preventDefault();
  window.dispatchEvent(event);
}

function pressAltShortcut(key: string) {
  dispatchKeyDown({ key: "Alt", code: "AltLeft", altKey: true });
  dispatchKeyDown({ key, code: `Digit${key}`, altKey: true });
  fireEvent.keyUp(window, { key: "Alt", code: "AltLeft", altKey: false });
}

async function advanceTimers(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("AppRail keyboard shortcuts", () => {
  beforeEach(() => {
    mockLicense.loggedIn = false;
    mockLicense.licenseInfo = null;
    isTauriMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("maps shortcuts to the current ordered, visible, available modules", () => {
    const onOpenMessages = vi.fn();
    const onGoHome = vi.fn();
    const onOpenDevelopment = vi.fn();
    const onOpenNote = vi.fn();
    const onOpenDb = vi.fn();
    const onOpenStock = vi.fn();

    renderRail({
      onOpenMessages,
      onGoHome,
      onOpenDevelopment,
      onOpenNote,
      onOpenDb,
      onOpenStock,
      modules: modulesInOrder(["db", "stock", "development", "note"], ["db"]),
      moduleAvailability: { stock: false },
    });

    pressAltShortcut("1");
    pressAltShortcut("2");
    pressAltShortcut("3");
    pressAltShortcut("4");

    expect(onOpenMessages).toHaveBeenCalledOnce();
    expect(onGoHome).not.toHaveBeenCalled();
    expect(onOpenDevelopment).toHaveBeenCalledOnce();
    expect(onOpenNote).toHaveBeenCalledOnce();
    expect(onOpenDb).not.toHaveBeenCalled();
    expect(onOpenStock).not.toHaveBeenCalled();
  });

  it("uses a modules prop update immediately and assigns Alt+0 to item ten", () => {
    const onOpenMessages = vi.fn();
    const onOpenNote = vi.fn();
    const onOpenStock = vi.fn();
    const onOpenDevelopment = vi.fn();
    const props = railProps({
      onOpenMessages,
      onOpenNote,
      onOpenStock,
      onOpenDevelopment,
      modules: modulesInOrder(["note"]),
    });
    const view = render(<AppRail {...props} />);

    pressAltShortcut("2");
    expect(onOpenNote).toHaveBeenCalledOnce();

    view.rerender(
      <AppRail {...props} modules={modulesInOrder(MODULE_KEYS)} />,
    );
    pressAltShortcut("9");
    pressAltShortcut("0");

    expect(onOpenStock).toHaveBeenCalledOnce();
    expect(onOpenDevelopment).toHaveBeenCalledOnce();
  });

  it("does not count Windows-only modules on macOS", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    const onOpenSystem = vi.fn();
    const onOpenNote = vi.fn();

    renderRail({
      onOpenSystem,
      onOpenNote,
      modules: modulesInOrder(["system", "note"]),
    });

    pressAltShortcut("2");

    expect(onOpenNote).toHaveBeenCalledOnce();
    expect(onOpenSystem).not.toHaveBeenCalled();
  });

  it("replaces navigation labels in place after holding Alt for 500ms without a tooltip", async () => {
    vi.useFakeTimers();
    renderRail();
    const sessions = screen.getByRole("button", { name: "Sessions", exact: true });
    const notes = screen.getByRole("button", { name: "Notes", exact: true });
    expect(within(sessions).getByText("Sessions")).toBeVisible();

    dispatchKeyDown({ key: "Alt", code: "AltLeft", altKey: true });
    await advanceTimers(499);
    expect(within(sessions).getByText("Sessions")).toBeVisible();

    dispatchKeyDown({ key: "Alt", code: "AltLeft", altKey: true, repeat: true });
    await advanceTimers(1);
    expect(within(sessions).getByText("Alt+1")).toBeVisible();
    expect(within(sessions).queryByText("Sessions")).not.toBeInTheDocument();
    expect(within(notes).getByText(notes.getAttribute("aria-keyshortcuts")!)).toBeVisible();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sessions", exact: true })).toBe(sessions);
  });

  it.each(["keyup", "blur"] as const)("cancels a short Alt hold on %s", async (release) => {
    vi.useFakeTimers();
    renderRail();

    dispatchKeyDown({ key: "Alt", code: "AltLeft", altKey: true });
    await advanceTimers(250);
    if (release === "keyup") {
      fireEvent.keyUp(window, { key: "Alt", code: "AltLeft", altKey: false });
    } else {
      fireEvent.blur(window);
    }
    await advanceTimers(300);

    const sessions = screen.getByRole("button", { name: "Sessions", exact: true });
    expect(within(sessions).getByText("Sessions")).toBeVisible();
    expect(within(sessions).queryByText("Alt+1")).not.toBeInTheDocument();
  });

  it.each(["keyup", "blur", "visibilitychange"] as const)("restores menu labels after %s", async (release) => {
    vi.useFakeTimers();
    renderRail();
    const sessions = screen.getByRole("button", { name: "Sessions", exact: true });
    dispatchKeyDown({ key: "Alt", code: "AltLeft", altKey: true });
    await advanceTimers(500);
    expect(within(sessions).getByText("Alt+1")).toBeVisible();

    if (release === "keyup") {
      fireEvent.keyUp(window, { key: "Alt", code: "AltLeft", altKey: false });
    } else if (release === "blur") {
      fireEvent.blur(window);
    } else {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      fireEvent(document, new Event("visibilitychange"));
    }

    expect(within(sessions).getByText("Sessions")).toBeVisible();
    expect(within(sessions).queryByText("Alt+1")).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "Ctrl+Alt",
      alt: { key: "Alt", altKey: true, ctrlKey: true },
      shortcut: { key: "1", altKey: true, ctrlKey: true },
    },
    {
      name: "Shift+Alt",
      alt: { key: "Alt", altKey: true, shiftKey: true },
      shortcut: { key: "1", altKey: true, shiftKey: true },
    },
    {
      name: "Meta+Alt",
      alt: { key: "Alt", altKey: true, metaKey: true },
      shortcut: { key: "1", altKey: true, metaKey: true },
    },
    {
      name: "AltGraph",
      alt: { key: "AltGraph", altKey: true, ctrlKey: true },
      shortcut: { key: "1", altKey: true, ctrlKey: true },
      altGraph: true,
    },
    {
      name: "IME composition",
      alt: { key: "Alt", altKey: true, isComposing: true },
      shortcut: { key: "1", altKey: true, isComposing: true },
    },
    {
      name: "default-prevented events",
      alt: { key: "Alt", altKey: true },
      shortcut: { key: "1", altKey: true },
      preventDefault: true,
    },
  ])("ignores $name without navigation or shortcut hints", async (testCase) => {
    vi.useFakeTimers();
    const onOpenMessages = vi.fn();
    renderRail({ onOpenMessages });

    dispatchKeyDown(testCase.alt, {
      altGraph: testCase.altGraph,
      preventDefault: testCase.preventDefault,
    });
    dispatchKeyDown(testCase.shortcut, {
      altGraph: testCase.altGraph,
      preventDefault: testCase.preventDefault,
    });
    await advanceTimers(500);

    expect(onOpenMessages).not.toHaveBeenCalled();
    const sessions = screen.getByRole("button", { name: "Sessions", exact: true });
    expect(within(sessions).getByText("Sessions")).toBeVisible();
    expect(within(sessions).queryByText("Alt+1")).not.toBeInTheDocument();
  });
});
