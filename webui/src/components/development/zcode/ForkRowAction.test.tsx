import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "./primitives/tooltip";
import { ForkRowAction } from "./ForkRowAction";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("ignores repeated clicks while the fork request is pending", async () => {
  const pending = deferred<void>();
  const onFork = vi.fn((_messageId: string, _requestId: string) => pending.promise);
  const view = render(<TooltipProvider><ForkRowAction messageId="message-1" onFork={onFork} onError={vi.fn()} /></TooltipProvider>);
  const button = screen.getByRole("button", { name: "Fork" });

  fireEvent.click(button);
  fireEvent.click(button);

  expect(onFork).toHaveBeenCalledOnce();
  const [messageId, requestId] = onFork.mock.calls[0];
  expect(messageId).toBe("message-1");
  expect(requestId).toMatch(/^fork_[\da-f]{32}$/i);
  expect(button).toBeDisabled();

  await act(async () => { pending.resolve(); await pending.promise; });
  await waitFor(() => expect(view.getByRole("button", { name: "Fork" })).toBeEnabled());
});

it("reports a failure and reuses the request id when retried", async () => {
  const cause = new Error("fork failed");
  const onFork = vi.fn((_messageId: string, _requestId: string) => Promise.resolve())
    .mockRejectedValueOnce(cause).mockResolvedValueOnce(undefined);
  const onError = vi.fn();
  render(<TooltipProvider><ForkRowAction messageId="message-1" onFork={onFork} onError={onError} /></TooltipProvider>);
  const button = screen.getByRole("button", { name: "Fork" });

  fireEvent.click(button);
  await waitFor(() => expect(onError).toHaveBeenCalledWith(cause));
  expect(button).toBeEnabled();

  fireEvent.click(button);
  await waitFor(() => expect(onFork).toHaveBeenCalledTimes(2));
  expect(onFork.mock.calls[0][1]).toBe(onFork.mock.calls[1][1]);
  expect(onError).toHaveBeenCalledOnce();
});
