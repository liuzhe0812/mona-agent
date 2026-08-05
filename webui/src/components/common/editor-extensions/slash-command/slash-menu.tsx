import { useCallback, useEffect, useMemo, useState, forwardRef, useImperativeHandle, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { type SlashCommandItem, suggestionItems, filterItems } from "./suggestion";
import { cn } from "@/lib/utils";

interface SlashMenuProps {
  editor: Editor;
  clientRect?: DOMRect | null;
  query: string;
}

export interface SlashMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const SlashMenu = forwardRef<SlashMenuRef, SlashMenuProps>(({ editor, query }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const items = useMemo(() => filterItems(suggestionItems, query), [query]);

  // 按分组组织
  const groupedItems = useMemo(() => {
    const groups: Record<string, SlashCommandItem[]> = {};
    items.forEach((item) => {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item);
    });
    return Object.entries(groups);
  }, [items]);

  const flatItems = useMemo(() => groupedItems.flatMap(([, items]) => items), [groupedItems]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(flatItems.length - 1, 0)));
  }, [flatItems.length]);

  useEffect(() => {
    const selectedRef = itemRefs.current[selectedIndex];
    if (selectedRef) {
      selectedRef.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [selectedIndex]);

  const selectItem = useCallback(
    (item: SlashCommandItem | undefined) => {
      if (!item) return;
      const { from, to } = editor.state.selection;
      const tr = editor.state.doc;
      let slashStart = from;
      for (let i = from - 1; i >= Math.max(0, from - 20); i--) {
        const node = tr.nodeAt(i);
        if (node && node.text && node.text.endsWith("/")) {
          slashStart = i;
          break;
        }
        if (node && node.text && !node.text.includes("/")) break;
      }
      editor.chain().focus().deleteRange({ from: slashStart, to }).run();
      item.command({ editor, range: { from: slashStart, to } });
    },
    [editor],
  );

  const upHandler = useCallback(() => {
    if (flatItems.length === 0) return;
    setSelectedIndex((prev) => (prev + flatItems.length - 1) % flatItems.length);
  }, [flatItems.length]);

  const downHandler = useCallback(() => {
    if (flatItems.length === 0) return;
    setSelectedIndex((prev) => (prev + 1) % flatItems.length);
  }, [flatItems.length]);

  const enterHandler = useCallback(() => {
    selectItem(flatItems[selectedIndex]);
  }, [selectItem, flatItems, selectedIndex]);

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === "ArrowUp") { upHandler(); return true; }
        if (event.key === "ArrowDown") { downHandler(); return true; }
        if (event.key === "Enter") { enterHandler(); return true; }
        return false;
      },
    }),
    [upHandler, downHandler, enterHandler],
  );

  if (items.length === 0) return null;

  let runningIndex = -1;

  return (
    <div className="max-h-72 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg scrollbar-thin">
      {groupedItems.map(([group, groupItems]) => (
        <div key={group} className="mb-1">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {group}
          </div>
          {groupItems.map((item) => {
            runningIndex += 1;
            const flatIndex = runningIndex;
            const isSelected = flatIndex === selectedIndex;
            return (
              <button
                key={item.title}
                ref={(el) => { itemRefs.current[flatIndex] = el; }}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                  isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
                onClick={() => selectItem(item)}
                onMouseEnter={() => setSelectedIndex(flatIndex)}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground">
                  {item.icon}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-foreground">{item.title}</span>
                  {item.description && (
                    <span className="truncate text-[10px] text-muted-foreground">{item.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
});

SlashMenu.displayName = "SlashMenu";
