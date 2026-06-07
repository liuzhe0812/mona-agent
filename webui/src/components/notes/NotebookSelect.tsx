import { BookOpen, Check, ChevronDown, Database, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { Notebook } from "./notes-data";

interface NotebookSelectProps {
  notebooks: Notebook[];
  activeNotebook: Notebook;
  onSelect: (id: string) => void;
  onCreateNotebook?: () => void;
  onRenameNotebook?: () => void;
  onToggleKnowledgeBase?: (enabled: boolean) => void;
  onDeleteNotebook?: () => void;
}

export function NotebookSelect({
  notebooks,
  activeNotebook,
  onSelect,
  onCreateNotebook,
  onRenameNotebook,
  onToggleKnowledgeBase,
  onDeleteNotebook,
}: NotebookSelectProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-8 w-[188px] justify-start gap-2 rounded-lg border-border/70 bg-background px-2.5 text-[12.5px] font-medium text-foreground/86 shadow-none"
        >
          <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="min-w-0 truncate">{activeNotebook.name}</span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="px-2 py-1.5 text-[12px] text-muted-foreground">
          选择笔记本
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {notebooks.map((notebook) => (
          <DropdownMenuItem
            key={notebook.id}
            onSelect={() => onSelect(notebook.id)}
            className="items-center gap-2 px-2 py-2"
          >
            <span
              className={cn(
                "grid h-5 w-5 shrink-0 place-items-center rounded-md border border-border/70",
                notebook.id === activeNotebook.id && "border-[#6aa7ff]/45 bg-[#6aa7ff]/10",
              )}
            >
              {notebook.id === activeNotebook.id ? (
                <Check className="h-3.5 w-3.5 text-[#3d82e7]" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
              {notebook.name}
            </span>
            {notebook.knowledgeBaseEnabled ? (
              <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : null}
          </DropdownMenuItem>
        ))}
        {onCreateNotebook ? (
          <>
            <DropdownMenuSeparator />
            {onRenameNotebook ? (
              <DropdownMenuItem onSelect={onRenameNotebook} className="gap-2 px-2 py-2">
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[12.5px] font-medium text-foreground/88">重命名当前笔记本</span>
              </DropdownMenuItem>
            ) : null}
            {onToggleKnowledgeBase ? (
              <DropdownMenuCheckboxItem
                checked={activeNotebook.knowledgeBaseEnabled}
                onCheckedChange={(checked) => onToggleKnowledgeBase(Boolean(checked))}
                className="py-2 text-[12.5px] font-medium text-foreground/88"
              >
                建为知识库
              </DropdownMenuCheckboxItem>
            ) : null}
            {onDeleteNotebook ? (
              <DropdownMenuItem
                onSelect={onDeleteNotebook}
                disabled={activeNotebook.id === "default"}
                className="gap-2 px-2 py-2 text-destructive focus:text-destructive data-[disabled]:opacity-50 data-[disabled]:text-muted-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="text-[12.5px] font-medium">删除当前笔记本</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onCreateNotebook} className="gap-2 px-2 py-2">
              <span className="grid h-5 w-5 place-items-center rounded-md border border-border/70 bg-muted/30">
                <Plus className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
              <span className="text-[12.5px] font-medium text-foreground/88">新建笔记本</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
