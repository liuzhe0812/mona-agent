import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { DesktopLogin } from "./DesktopLogin";

it("asks the user to trust an unknown desktop host key", () => {
  const trust = vi.fn();
  render(
    <DesktopLogin
      onLogin={vi.fn()}
      hostKey={{
        type: "unknown",
        fingerprint: "SHA256:test-fingerprint",
        expectedFingerprint: "",
      }}
      onTrustHostKey={trust}
    />,
  );

  expect(screen.getByText("SHA256:test-fingerprint")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "信任并连接" }));
  expect(trust).toHaveBeenCalledOnce();
});
