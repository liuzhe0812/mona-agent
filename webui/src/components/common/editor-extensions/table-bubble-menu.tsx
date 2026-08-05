import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { CellSelection } from "@tiptap/pm/tables";
import {
  Table2,
  Rows3,
  Columns3,
  Combine,
  Split,
  Trash2,
  ArrowUpToLine,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  AlignLeft,
  AlignCenter,
  AlignRight,
} from "lucide-react";

interface Props {
  editor: Editor | null;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}

interface MenuState {
  visible: boolean;
  top: number;
  left: number;
}

export function TableBubbleMenu({ editor, wrapperRef }: Props) {
  const [menuState, setMenuState] = useState<MenuState>({ visible: false, top: 0, left: 0 });
  const [canMerge, setCanMerge] = useState(false);
  const [canSplit, setCanSplit] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenu = useCallback(() => {
    if (!editor) {
      setMenuState((s) => ({ ...s, visible: false }));
      return;
    }
    const inTable = editor.isActive("table");
    if (!inTable) {
      setMenuState((s) => ({ ...s, visible: false }));
      return;
    }
    // 只在选中单元格（CellSelection）时显示，文字选区不显示
    const { selection } = editor.state;
    const isCellSelection = selection instanceof CellSelection;
    if (!isCellSelection) {
      setMenuState((s) => ({ ...s, visible: false }));
      return;
    }

    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const { from, to } = selection;
    try {
      const startCoords = editor.view.coordsAtPos(from);
      const endCoords = editor.view.coordsAtPos(to);
      const rect = wrapper.getBoundingClientRect();
      const menuWidth = menuRef.current?.offsetWidth || 280;
      const menuHeight = menuRef.current?.offsetHeight || 40;

      // 选区顶部（两端中较小的 top）
      const selectionTop = Math.min(startCoords.top, endCoords.top);
      // 选区水平中心
      const selectionCenterX = (startCoords.left + endCoords.left) / 2;

      let left = selectionCenterX - rect.left + wrapper.scrollLeft - menuWidth / 2;
      let top = selectionTop - rect.top + wrapper.scrollTop - menuHeight - 8;

      // 水平边界限制
      if (left < 4) left = 4;
      if (left + menuWidth > rect.width - 4) {
        left = Math.max(4, rect.width - menuWidth - 4);
      }
      // 上方空间不足时翻到选区下方
      if (top < 4) {
        const selectionBottom = Math.max(startCoords.bottom, endCoords.bottom);
        top = selectionBottom - rect.top + wrapper.scrollTop + 8;
      }

      setMenuState({ visible: true, top, left });
      try { setCanMerge(editor.can().mergeCells()); } catch { setCanMerge(false); }
      try { setCanSplit(editor.can().splitCell()); } catch { setCanSplit(false); }
    } catch {
      setMenuState((s) => ({ ...s, visible: false }));
    }
  }, [editor, wrapperRef]);

  useEffect(() => {
    if (!editor) return;
    editor.on("selectionUpdate", updateMenu);
    editor.on("focus", updateMenu);
    return () => {
      editor.off("selectionUpdate", updateMenu);
      editor.off("focus", updateMenu);
    };
  }, [editor, updateMenu]);

  useEffect(() => {
    if (!editor) return;
    const handleBlur = () => {
      setTimeout(() => {
        if (!editor.isFocused) {
          setMenuState((s) => ({ ...s, visible: false }));
        }
      }, 150);
    };
    editor.on("blur", handleBlur);
    return () => {
      editor.off("blur", handleBlur);
    };
  }, [editor]);

  const run = useCallback(
    (command: () => void) => {
      command();
      // keep menu visible and refresh capabilities after next paint
      requestAnimationFrame(() => updateMenu());
    },
    [updateMenu]
  );

  if (!menuState.visible) return null;

  return (
    <div
      ref={menuRef}
      className="absolute z-50 flex items-center gap-1 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ top: menuState.top, left: menuState.left }}
    >
      <TableButton label="上方插入行" icon={<ArrowUpToLine className="h-4 w-4" />} onClick={() => run(() => editor?.chain().focus().addRowBefore().run())} />
      <TableButton label="下方插入行" icon={<ArrowDownToLine className="h-4 w-4" />} onClick={() => run(() => editor?.chain().focus().addRowAfter().run())} />
      <TableButton label="左侧插入列" icon={<ArrowLeftToLine className="h-4 w-4" />} onClick={() => run(() => editor?.chain().focus().addColumnBefore().run())} />
      <TableButton label="右侧插入列" icon={<ArrowRightToLine className="h-4 w-4" />} onClick={() => run(() => editor?.chain().focus().addColumnAfter().run())} />

      <ToolbarSeparator />

      <TableButton label="删除行" icon={<Rows3 className="h-4 w-4" />} onClick={() => run(() => editor?.chain().focus().deleteRow().run())} />
      <TableButton label="删除列" icon={<Columns3 className="h-4 w-4" />} onClick={() => run(() => editor?.chain().focus().deleteColumn().run())} />

      <ToolbarSeparator />

      {/* 文字对齐 */}
      <TableButton
        label="左对齐"
        icon={<AlignLeft className="h-4 w-4" />}
        active={editor?.isActive({ textAlign: "left" }) ?? false}
        onClick={() => run(() => editor?.chain().focus().setTextAlign("left").run())}
      />
      <TableButton
        label="居中对齐"
        icon={<AlignCenter className="h-4 w-4" />}
        active={editor?.isActive({ textAlign: "center" }) ?? false}
        onClick={() => run(() => editor?.chain().focus().setTextAlign("center").run())}
      />
      <TableButton
        label="右对齐"
        icon={<AlignRight className="h-4 w-4" />}
        active={editor?.isActive({ textAlign: "right" }) ?? false}
        onClick={() => run(() => editor?.chain().focus().setTextAlign("right").run())}
      />

      {canMerge || canSplit ? <ToolbarSeparator /> : null}
      {canMerge ? <TableButton label="合并单元格" icon={<Combine className="h-4 w-4" />} onClick={() => run(() => editor?.chain().focus().mergeCells().run())} /> : null}
      {canSplit ? <TableButton label="拆分单元格" icon={<Split className="h-4 w-4" />} onClick={() => run(() => editor?.chain().focus().splitCell().run())} /> : null}

      <ToolbarSeparator />

      <TableButton label="切换表头行" icon={<Table2 className="h-4 w-4" />} onClick={() => run(() => editor?.chain().focus().toggleHeaderRow().run())} />
      <TableButton label="删除表格" icon={<Trash2 className="h-4 w-4 text-destructive" />} destructive onClick={() => run(() => editor?.chain().focus().deleteTable().run())} />
    </div>
  );
}

function ToolbarSeparator() {
  return <div className="mx-0.5 h-5 w-px bg-border/70" />;
}

function TableButton({
  label,
  icon,
  onClick,
  active = false,
  destructive = false,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        destructive
          ? "text-destructive hover:bg-destructive/10"
          : active
            ? "bg-accent text-foreground"
            : "text-foreground/82 hover:bg-accent hover:text-foreground"
      }`}
    >
      {icon}
    </button>
  );
}
