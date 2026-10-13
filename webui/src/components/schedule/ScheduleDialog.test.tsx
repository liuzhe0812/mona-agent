import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ScheduleDialog } from "./ScheduleDialog";
import type { ScheduleItem } from "./types";

const item: ScheduleItem = {
  id: "synced-event", title: "跨时区例会", description: "议程", startAtMs: Date.UTC(2026, 9, 12, 1, 30),
  endAtMs: null, allDay: false, recurrence: "weekly", cronExpr: null, tz: "Asia/Shanghai",
  kind: "personal", aiMessage: null, aiDeliver: true, done: false, enabled: true, color: null,
  sourceModule: null, sourceChatId: null, lastRunAtMs: null, nextRunAtMs: null,
  lastStatus: null, lastError: null, createdAtMs: 1, updatedAtMs: 1,
};

it("editing a synchronized event preserves its recurrence timezone", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<ScheduleDialog open onOpenChange={() => {}} item={item} onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0]).toMatchObject({ title: item.title, tz: "Asia/Shanghai", startAtMs: item.startAtMs });
});

it("a newly saved event records the creating device timezone", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const view = render(<ScheduleDialog open onOpenChange={() => {}} item={null}
    defaultStart={new Date(2026, 9, 12, 9, 30)} onSave={save} />);
  fireEvent.change(view.container.ownerDocument.querySelector('input[placeholder]')!, { target: { value: "新会议" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
});
