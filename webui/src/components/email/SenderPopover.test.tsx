import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openComposeWindow: vi.fn(),
  searchContacts: vi.fn(),
  updateContact: vi.fn(),
  setState: vi.fn(),
  loadContacts: vi.fn(),
}));

vi.mock("./lib/emailApi", () => ({ openComposeWindow: mocks.openComposeWindow }));
vi.mock("./contacts/lib/contactsApi", () => ({
  searchContacts: mocks.searchContacts,
  updateContact: mocks.updateContact,
}));
vi.mock("./store/emailStore", () => ({
  useEmailStore: {
    setState: mocks.setState,
    getState: () => ({ loadContacts: mocks.loadContacts }),
  },
}));

import { SenderPopover } from "./SenderPopover";

describe("SenderPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchContacts.mockResolvedValue([{ id: "contact-1", accountId: "mail-1", source: "manual", displayName: "support", email: "support@os-easy.com", updatedAt: 1 }]);
    mocks.updateContact.mockResolvedValue(undefined);
    mocks.loadContacts.mockResolvedValue(undefined);
  });

  it("allows selecting contact text and editing the contact", async () => {
    render(<SenderPopover displayName="support" email="support@os-easy.com" accountId="mail-1" inContacts />);

    fireEvent.click(screen.getByRole("button", { name: "support" }));
    const popup = document.querySelector("[data-sender-popup]") as HTMLElement;
    expect(within(popup).getByText("support")).toHaveClass("select-text");
    expect(within(popup).getByText("support@os-easy.com")).toHaveClass("select-text");

    fireEvent.click(within(popup).getByRole("button", { name: "编辑" }));
    const nameInput = await screen.findByDisplayValue("support");
    const emailInput = screen.getByDisplayValue("support@os-easy.com");
    fireEvent.change(nameInput, { target: { value: "客户支持" } });
    fireEvent.change(emailInput, { target: { value: "help@os-easy.com" } });
    fireEvent.click(within(popup).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.updateContact).toHaveBeenCalledWith("contact-1", {
      displayName: "客户支持",
      email: "help@os-easy.com",
    }));
    expect(mocks.setState).toHaveBeenCalledWith({ contactsLoaded: false });
    expect(mocks.loadContacts).toHaveBeenCalled();
  });
});
