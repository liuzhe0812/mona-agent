/** PlanningView — calendar as main workbench with right-side day plan
 * and a slide-in inbox drawer.
 *
 * Layout:
 *   ┌────────────────────┬──────────────┐
 *   │  Month calendar    │  Day plan    │
 *   │  (top bar: inbox,  │  (selected   │
 *   │   new schedule)    │   date)      │
 *   └────────────────────┴──────────────┘
 *
 * Inbox badge count is subscribed directly from todoStore in ScheduleView
 * and Sidebar, so this component does not need to propagate counts.
 */

import { useState } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import { ScheduleView } from "./ScheduleView";
import { TodoInbox } from "./TodoInbox";

export function PlanningView() {
  const [inboxOpen, setInboxOpen] = useState(false);

  return (
    <>
      <ScheduleView onOpenInbox={() => setInboxOpen(true)} />
      <Sheet open={inboxOpen} onOpenChange={setInboxOpen}>
        <SheetContent
          side="right"
          showCloseButton
          aria-describedby={undefined}
          className="w-[400px] max-w-[90vw] p-0 sm:max-w-[400px]"
        >
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="text-[14px]">收集箱</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-hidden">
            <TodoInbox />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
