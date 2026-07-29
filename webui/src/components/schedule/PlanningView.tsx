/** PlanningView — calendar as main workbench with right-side day plan
 * and a slide-in inbox drawer.
 *
 * Layout:
 *   ┌────────────────────┬──────────────┐
 *   │  Month calendar    │  Day plan    │
 *   │  (top bar: inbox,  │  (selected   │
 *   │   new schedule)    │   date)      │
 *   └────────────────────┴──────────────┘
 */

import { useCallback, useState } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import { ScheduleView } from "./ScheduleView";
import { TodoInbox } from "./TodoInbox";

interface PlanningViewProps {
  onInboxCountChange?: (count: number) => void;
}

export function PlanningView({ onInboxCountChange }: PlanningViewProps) {
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);

  const handleCountChange = useCallback(
    (count: number) => {
      setInboxCount(count);
      onInboxCountChange?.(count);
    },
    [onInboxCountChange],
  );

  return (
    <>
      <ScheduleView
        onOpenInbox={() => setInboxOpen(true)}
        inboxCount={inboxCount}
      />
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
            <TodoInbox onCountChange={handleCountChange} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
