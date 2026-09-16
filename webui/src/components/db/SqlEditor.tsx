import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { sql, MySQL, SQLite } from "@codemirror/lang-sql";
import { autocompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { useDbStore } from "./store/dbStore";
import type { QueryTab } from "./types";
import { clearQueryDraft, getQueryDraft, setQueryDraft } from "./query-draft";
import { buildSqlCompletionSchema } from "./sql-completion";

const EMPTY_TREE: import("./types").DatabaseObject[] = [];

export interface SqlEditorHandle {
  selectedSql: () => string;
  currentSql: () => string;
  insertTable: (identifier: string) => void;
  flush: () => void;
}
export const SqlEditor = forwardRef<SqlEditorHandle, { tab: QueryTab; onHasTextChange?: (hasText: boolean) => void; onSave?: () => void }>(({ tab, onHasTextChange, onSave }, ref) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const dialect = useRef(new Compartment());
  const flushTimer = useRef<number | null>(null);
  const hasTextRef = useRef(Boolean(tab.sql.trim()));
  const lastStoredSql = useRef(tab.sql);
  const connection = useDbStore((s) => s.activeConnections.find((c) => c.id === tab.connectionId));
  const connectionTree = useDbStore((s) => tab.connectionId ? s.connectionTree[tab.connectionId] ?? EMPTY_TREE : EMPTY_TREE);
  const metadataKey = useDbStore((s) => s.queryTabs
    .filter((item) => item.connectionId === tab.connectionId && item.database === tab.database && item.tableName && item.tableInfo)
    .map((item) => `${item.tableName}:${item.tableInfo!.columns.map((column) => `${column.name}:${column.data_type}`).join(",")}`)
    .sort()
    .join("|"));
  const completionSchema = useMemo(() => buildSqlCompletionSchema(connectionTree, useDbStore.getState().queryTabs, tab.connectionId, tab.database), [connectionTree, metadataKey, tab.connectionId, tab.database]);
  const sqlLanguage = useMemo(() => sql({
    dialect: connection?.config.db_type === "sqlite" ? SQLite : MySQL,
    schema: completionSchema,
    defaultSchema: tab.database ?? undefined,
    upperCaseKeywords: true,
  }), [completionSchema, connection?.config.db_type, tab.database]);
  const selectedSql = () => {
    const editor = view.current;
    if (!editor) return tabRef.current.sql;
    const selection = editor.state.selection.main;
    return selection.empty ? editor.state.doc.toString() : editor.state.sliceDoc(selection.from, selection.to);
  };
  const currentSql = useCallback(() => view.current?.state.doc.toString() ?? getQueryDraft(tab.id, tabRef.current.sql), [tab.id]);
  const flush = useCallback(() => {
    if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    flushTimer.current = null;
    const value = currentSql();
    setQueryDraft(tab.id, value);
    const stored = useDbStore.getState().queryTabs.find((item) => item.id === tab.id)?.sql;
    if (stored !== undefined && stored !== value) useDbStore.getState().updateTabSql(tab.id, value);
  }, [currentSql, tab.id]);
  const scheduleFlush = useCallback(() => {
    if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(flush, 500);
  }, [flush]);
  const insertTable = useCallback((identifier: string) => {
    const editor = view.current;
    if (!editor) return;
    const selection = editor.state.selection.main;
    const empty = !editor.state.doc.toString().trim();
    const text = empty ? `SELECT * FROM ${identifier} LIMIT 100;` : identifier;
    editor.dispatch({
      changes: { from: empty ? 0 : selection.from, to: empty ? editor.state.doc.length : selection.to, insert: text },
      selection: { anchor: (empty ? 0 : selection.from) + text.length },
      scrollIntoView: true,
    });
    editor.focus();
  }, []);
  useImperativeHandle(ref, () => ({ selectedSql, currentSql, insertTable, flush }), [currentSql, flush, insertTable]);

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: tabRef.current.sql,
        selection: { anchor: tabRef.current.sql.length },
        extensions: [
          lineNumbers(), highlightActiveLine(), history(),
          dialect.current.of(sqlLanguage),
          autocompletion({ activateOnTyping: true, maxRenderedOptions: 60 }),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.theme({
            "&": { height: "100%", fontSize: "inherit", backgroundColor: "hsl(var(--background))", color: "hsl(var(--foreground))" },
            ".cm-content": { fontFamily: "var(--font-mono, monospace)", padding: "8px 0", caretColor: "hsl(var(--foreground))" },
            ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" },
            ".cm-gutters": { backgroundColor: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))", border: "none" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "hsl(var(--muted) / .5)" },
            ".cm-cursor": { borderLeftColor: "hsl(var(--foreground))" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "hsl(var(--muted))" },
            ".cm-tooltip-autocomplete": { border: "1px solid hsl(var(--border))", borderRadius: "8px", backgroundColor: "hsl(var(--popover))", boxShadow: "0 4px 6px -1px rgb(0 0 0 / .1), 0 2px 4px -2px rgb(0 0 0 / .1)", overflow: "hidden" },
            ".cm-tooltip-autocomplete > ul": { maxHeight: "260px", fontFamily: "var(--font-mono, monospace)", padding: "4px" },
            ".cm-tooltip-autocomplete > ul > li": { minHeight: "30px", padding: "5px 8px", borderRadius: "4px" },
            ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "hsl(var(--info) / .28)", color: "hsl(var(--foreground))" },
            ".cm-completionDetail": { marginLeft: "16px", color: "hsl(var(--muted-foreground))", fontStyle: "normal" },
          }),
          EditorView.contentAttributes.of({ "aria-label": "SQL 编辑器" }),
          EditorView.domEventHandlers({ blur: () => { flush(); return false; } }),
          keymap.of([
            { key: "Mod-Enter", run: () => { flush(); void useDbStore.getState().executeQuery(tabRef.current.id, selectedSql()); return true; } },
            { key: "Mod-s", run: () => { flush(); onSaveRef.current?.(); return true; } },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const value = update.state.doc.toString();
            setQueryDraft(tabRef.current.id, value);
            const hasText = Boolean(value.trim());
            if (hasText !== hasTextRef.current) {
              hasTextRef.current = hasText;
              onHasTextChange?.(hasText);
            }
            scheduleFlush();
          }),
        ],
      }),
    });
    view.current = editor;
    setQueryDraft(tab.id, tabRef.current.sql);
    return () => {
      flush();
      editor.destroy();
      view.current = null;
      clearQueryDraft(tab.id);
    };
  }, [tab.id]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || tab.sql === lastStoredSql.current) return;
    lastStoredSql.current = tab.sql;
    setQueryDraft(tab.id, tab.sql);
    if (editor.state.doc.toString() !== tab.sql) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: tab.sql } });
  }, [tab.sql]);
  useEffect(() => {
    view.current?.dispatch({ effects: dialect.current.reconfigure(sqlLanguage) });
  }, [sqlLanguage]);
  return <div ref={host} className="h-full min-h-0 overflow-hidden text-body" />;
});
SqlEditor.displayName = "SqlEditor";
