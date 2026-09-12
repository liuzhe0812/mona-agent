import { useRef } from "react";
import { Select } from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { ResultPanel } from "./ResultPanel";
import { DbToolButton } from "./DbToolButton";
import { useDbStore } from "./store/dbStore";
import type { QueryTab } from "./types";

export function QueryWorkspace({ tab }: { tab: QueryTab }) {
  const connections = useDbStore((s) => s.activeConnections);
  const tree = useDbStore((s) => s.connectionTree);
  const editor = useRef<SqlEditorHandle>(null);
  const connection = connections.find((c) => c.id === tab.connectionId);
  const databases = tab.connectionId ? tree[tab.connectionId] ?? [] : [];
  async function saveSql() {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({ defaultPath: "query.sql", filters: [{ name: "SQL", extensions: ["sql"] }] });
      if (path) await writeTextFile(path, tab.sql);
    } catch (error) { useDbStore.getState().patchTab(tab.id, { error: `保存 SQL 失败：${String(error)}` }); }
  }
  return <TooltipProvider delayDuration={250}>
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div role="toolbar" aria-label="查询操作" className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-2">
        <Select aria-label="查询连接" className="h-7 w-36 shrink-0 text-caption" value={tab.connectionId ?? ""} disabled={tab.isExecuting}
          options={connections.map((c) => ({ value: c.id, label: c.config.name }))} placeholder="选择连接"
          onValueChange={(id) => useDbStore.getState().setQueryTarget(tab.id, id, tree[id]?.[0]?.name ?? null)} />
        <Select aria-label="查询数据库" className="h-7 w-36 shrink-0 text-caption" value={tab.database ?? ""} disabled={tab.isExecuting}
          options={databases.map((db) => ({ value: db.name, label: db.name }))} placeholder="选择数据库"
          onValueChange={(database) => tab.connectionId && useDbStore.getState().setQueryTarget(tab.id, tab.connectionId, database)} />
        <span className="h-4 w-px shrink-0 bg-border" />
        <DbToolButton icon="play" label="执行 SQL（Ctrl+Enter，有选区时执行选中内容）" disabled={!connection || tab.isExecuting || !tab.sql.trim()} onClick={() => { void useDbStore.getState().executeQuery(tab.id, editor.current?.selectedSql()); }} />
        <DbToolButton icon="save" label="保存 SQL 文件" disabled={!tab.sql.trim()} onClick={() => { void saveSql(); }} />
      </div>
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel defaultSize="50%" minSize="20%"><SqlEditor ref={editor} tab={tab} /></ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="50%" minSize="20%"><ResultPanel tab={tab} /></ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border px-3 text-caption text-muted-foreground">
        <span className={connection ? "text-success" : "text-destructive"}>●</span>
        <span>{connection?.config.name ?? "未连接"}{tab.database ? ` · ${tab.database}` : ""}</span>
        <span className="ml-auto">Ctrl+Enter 执行 · UTF-8</span>
      </div>
    </div>
  </TooltipProvider>;
}
