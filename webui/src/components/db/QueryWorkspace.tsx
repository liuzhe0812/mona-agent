import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { ResultPanel } from "./ResultPanel";
import { DbToolButton } from "./DbToolButton";
import { useDbStore } from "./store/dbStore";
import type { QueryTab } from "./types";
import { QueryDatabaseSelect } from "./QueryDatabaseSelect";

const EMPTY_DATABASES: string[] = [];

export function QueryWorkspace({ tab }: { tab: QueryTab }) {
  const connection = useDbStore((s) => s.activeConnections.find((item) => item.id === tab.connectionId));
  const databases = useDbStore((s) => tab.connectionId ? s.connectionDatabases[tab.connectionId] ?? EMPTY_DATABASES : EMPTY_DATABASES);
  const editor = useRef<SqlEditorHandle>(null);
  const [hasText, setHasText] = useState(Boolean(tab.sql.trim()));
  const [saveOpen, setSaveOpen] = useState(false);
  const [queryName, setQueryName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const onHasTextChange = useCallback((next: boolean) => setHasText((current) => current === next ? current : next), []);
  const databaseOptions = useMemo(() => tab.database && !databases.includes(tab.database) ? [tab.database, ...databases] : databases, [databases, tab.database]);
  async function saveQuery(name = tab.title) {
    const sql = editor.current?.currentSql() ?? tab.sql;
    editor.current?.flush();
    if (!connection || !tab.database || !sql.trim() || tab.isSaving) return;
    if (!tab.savedQueryId) {
      setQueryName(tab.title === "新查询" ? "" : tab.title);
      setSaveError(null);
      setSaveOpen(true);
      return;
    }
    try {
      await useDbStore.getState().saveQuery(tab.id, name, sql);
    } catch (error) {
      setSaveError(String(error));
    }
  }
  async function saveNamedQuery() {
    const sql = editor.current?.currentSql() ?? tab.sql;
    editor.current?.flush();
    try {
      await useDbStore.getState().saveQuery(tab.id, queryName, sql);
      setSaveOpen(false);
      setSaveError(null);
    } catch (error) {
      setSaveError(String(error));
    }
  }
  return <TooltipProvider delayDuration={250}>
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div role="toolbar" aria-label="查询操作" className="relative z-20 flex h-10 shrink-0 items-center gap-1 overflow-visible border-b border-border px-2">
        <QueryDatabaseSelect databases={databaseOptions} value={tab.database} disabled={!connection || tab.isExecuting || tab.isSaving}
          onSelect={(database) => { editor.current?.flush(); if (tab.connectionId) useDbStore.getState().setQueryTarget(tab.id, tab.connectionId, database); }} />
        <span className="h-4 w-px shrink-0 bg-border" />
        <DbToolButton icon="play" label="执行 SQL（Ctrl+Enter，有选区时执行选中内容）" disabled={!connection || tab.isExecuting || !hasText} onClick={() => { editor.current?.flush(); void useDbStore.getState().executeQuery(tab.id, editor.current?.selectedSql()); }} />
        <DbToolButton icon="save" label={tab.isSaving ? "正在保存查询" : "保存查询（Ctrl+S）"}
          disabled={!connection || !tab.database || !hasText || tab.isSaving} onClick={() => { void saveQuery(); }} />
      </div>
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel defaultSize="50%" minSize="20%"><SqlEditor ref={editor} tab={tab} onHasTextChange={onHasTextChange} onSave={() => { void saveQuery(); }} /></ResizablePanel>
          <ResizableHandle aria-label="调整查询编辑器和结果区高度" className="bg-border/80 transition-colors hover:bg-info/60 active:bg-info" />
          <ResizablePanel defaultSize="50%" minSize="20%"><ResultPanel tab={tab} /></ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border px-3 text-caption text-muted-foreground">
        <span className={connection ? "text-success" : "text-destructive"}>●</span>
        <span>{connection?.config.name ?? "未连接"}{tab.database ? ` · ${tab.database}` : ""}</span>
        <span className="ml-auto">Ctrl+Enter 执行 · Ctrl+S 保存 · UTF-8</span>
      </div>
    </div>
    <Dialog open={saveOpen} onOpenChange={(open) => { if (!tab.isSaving) setSaveOpen(open); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>保存查询</DialogTitle><DialogDescription>{connection?.config.name ?? "未连接"} / {tab.database ?? "未选择数据库"}</DialogDescription></DialogHeader>
        <Input autoFocus aria-label="查询名称" value={queryName} onChange={(event) => setQueryName(event.target.value)} placeholder="输入查询名称" onKeyDown={(event) => { if (event.key === "Enter" && queryName.trim()) void saveNamedQuery(); }} />
        {saveError && <p role="alert" className="text-caption text-destructive">{saveError}</p>}
        <DialogFooter><Button variant="ghost" disabled={tab.isSaving} onClick={() => setSaveOpen(false)}>取消</Button><Button disabled={tab.isSaving || !queryName.trim() || !hasText} onClick={() => { void saveNamedQuery(); }}>{tab.isSaving ? "保存中…" : "保存"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </TooltipProvider>;
}
