import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailAccount, EmailFolder } from "@/components/email/lib/types";
import type { EmailScheduleConfig } from "@/lib/tauri";

const mocks = vi.hoisted(() => ({
  licenseActive: true,
  readEmailScheduleConfig: vi.fn(),
  writeEmailScheduleConfig: vi.fn(),
  listAccounts: vi.fn(),
  getFolders: vi.fn(),
}));

vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => ({ licenseActive: mocks.licenseActive }),
}));

vi.mock("@/lib/tauri", () => ({
  readEmailScheduleConfig: mocks.readEmailScheduleConfig,
  writeEmailScheduleConfig: mocks.writeEmailScheduleConfig,
}));

vi.mock("@/components/email/lib/emailApi", () => ({
  listAccounts: mocks.listAccounts,
  getFolders: mocks.getFolders,
}));

import { EmailExtractionSettingsDialog } from "./EmailExtractionSettingsDialog";

const accounts = [
  { id: "work", displayName: "工作邮箱", fromAddress: "work@example.com" },
  { id: "personal", displayName: "个人邮箱", fromAddress: "me@example.com" },
] as EmailAccount[];

const folders: Record<string, EmailFolder[]> = {
  work: [
    { name: "INBOX", delimiter: "/", hasChildren: false, flags: "" },
    { name: "Archive", delimiter: "/", hasChildren: false, flags: "" },
    { name: "Junk", delimiter: "/", hasChildren: false, flags: "" },
    { name: "Trash", delimiter: "/", hasChildren: false, flags: "" },
    { name: "Drafts", delimiter: "/", hasChildren: false, flags: "" },
  ],
  personal: [
    { name: "INBOX", delimiter: "/", hasChildren: false, flags: "" },
    { name: "Archive", delimiter: "/", hasChildren: false, flags: "" },
    { name: "Spam", delimiter: "/", hasChildren: false, flags: "" },
    { name: "Deleted Messages", delimiter: "/", hasChildren: false, flags: "" },
  ],
};

const initialConfig: EmailScheduleConfig = {
  enabled: true,
  folders: ["work:INBOX", "personal:Archive"],
  createMode: "confirm",
  leadMinutes: 15,
  skipSenders: ["blocked@example.com"],
  parseTimeoutSeconds: 73,
};

function makeProps() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onOpenSubscribe: vi.fn(),
    onAddEmailAccount: vi.fn(),
    onOpenEmail: vi.fn(),
  };
}

function renderSettings(props = makeProps()) {
  return render(<EmailExtractionSettingsDialog {...props} />);
}

describe("EmailExtractionSettingsDialog", () => {
  beforeEach(() => {
    mocks.licenseActive = true;
    mocks.readEmailScheduleConfig.mockReset().mockResolvedValue(initialConfig);
    mocks.writeEmailScheduleConfig.mockReset().mockResolvedValue(undefined);
    mocks.listAccounts.mockReset().mockResolvedValue(accounts);
    mocks.getFolders.mockReset().mockImplementation(async (accountId: string) => folders[accountId] ?? []);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads each account's selectable folders and preserves the other account and parser settings on save", async () => {
    renderSettings();

    const work = await screen.findByRole("group", { name: "工作邮箱" });
    const personal = screen.getByRole("group", { name: "个人邮箱" });
    expect(mocks.readEmailScheduleConfig).toHaveBeenCalledOnce();
    expect(mocks.listAccounts).toHaveBeenCalledOnce();
    expect(mocks.getFolders).toHaveBeenCalledWith("work");
    expect(mocks.getFolders).toHaveBeenCalledWith("personal");
    expect(within(work).getByRole("checkbox", { name: "收件箱" })).toBeChecked();
    expect(within(work).getByRole("checkbox", { name: "归档" })).not.toBeChecked();
    expect(within(personal).getByRole("checkbox", { name: "归档" })).toBeChecked();
    expect(within(work).queryByRole("checkbox", { name: "垃圾邮件" })).not.toBeInTheDocument();
    expect(within(work).queryByRole("checkbox", { name: "回收站" })).not.toBeInTheDocument();
    expect(within(work).queryByRole("checkbox", { name: "草稿箱" })).not.toBeInTheDocument();

    fireEvent.click(within(work).getByRole("checkbox", { name: "归档" }));
    fireEvent.change(screen.getByLabelText("提前提醒（分钟）"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.writeEmailScheduleConfig).toHaveBeenCalledOnce());
    expect(mocks.writeEmailScheduleConfig).toHaveBeenCalledWith({
      ...initialConfig,
      folders: ["work:INBOX", "personal:Archive", "work:Archive"],
      leadMinutes: 30,
    });
  });

  it("discards edits on close and reloads the saved config when reopened", async () => {
    const props = makeProps();
    const reopenedConfig = { ...initialConfig, leadMinutes: 45 };
    mocks.readEmailScheduleConfig
      .mockResolvedValueOnce(initialConfig)
      .mockResolvedValueOnce(reopenedConfig);
    const view = renderSettings(props);

    const leadInput = await screen.findByLabelText("提前提醒（分钟）");
    expect(leadInput).toHaveValue(15);
    fireEvent.change(leadInput, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.writeEmailScheduleConfig).not.toHaveBeenCalled();

    view.rerender(<EmailExtractionSettingsDialog {...props} open={false} />);
    view.rerender(<EmailExtractionSettingsDialog {...props} open />);

    await waitFor(() => expect(mocks.readEmailScheduleConfig).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("提前提醒（分钟）")).toHaveValue(45);
    expect(mocks.writeEmailScheduleConfig).not.toHaveBeenCalled();
  });

  it("shows a generic save error and keeps the edited draft available", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.writeEmailScheduleConfig.mockRejectedValue(new Error("private backend detail"));
    renderSettings();

    fireEvent.change(await screen.findByLabelText("提前提醒（分钟）"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const alert = await screen.findByRole("alertdialog");
    expect(within(alert).getByText("保存邮件提取设置失败")).toBeInTheDocument();
    expect(within(alert).getByText("设置未能确认保存，请重试。")).toBeInTheDocument();
    expect(within(alert).queryByText("private backend detail")).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "知道了" }));
    expect(await screen.findByLabelText("提前提醒（分钟）")).toHaveValue(25);
    expect(mocks.writeEmailScheduleConfig).toHaveBeenCalledOnce();
  });

  it("offers to add an email account when none are connected", async () => {
    const props = makeProps();
    mocks.listAccounts.mockResolvedValue([]);
    renderSettings(props);

    fireEvent.click(await screen.findByRole("button", { name: "添加邮箱" }));

    expect(props.onAddEmailAccount).toHaveBeenCalledOnce();
    expect(mocks.getFolders).not.toHaveBeenCalled();
    expect(mocks.writeEmailScheduleConfig).not.toHaveBeenCalled();
  });

  it("offers Pro upgrade without reading or writing email config for an unlicensed user", () => {
    mocks.licenseActive = false;
    const props = makeProps();
    renderSettings(props);

    fireEvent.click(screen.getByRole("button", { name: "升级 Pro" }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onOpenSubscribe).toHaveBeenCalledOnce();
    expect(mocks.readEmailScheduleConfig).not.toHaveBeenCalled();
    expect(mocks.listAccounts).not.toHaveBeenCalled();
    expect(mocks.writeEmailScheduleConfig).not.toHaveBeenCalled();
  });
});
