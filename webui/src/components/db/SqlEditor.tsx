import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { sql, MySQL, SQLite } from "@codemirror/lang-sql";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { useDbStore } from "./store/dbStore";
import type { QueryTab } from "./types";

export interface SqlEditorHandle { selectedSql: () => string }
export const SqlEditor = forwardRef<SqlEditorHandle, { tab: QueryTab }>(({ tab }, ref) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const dialect = useRef(new Compartment());
  const connection = useDbStore((s) => s.activeConnections.find((c) => c.id === tab.connectionId));
  const selectedSql = () => {
    const editor = view.current;
    if (!editor) return tabRef.current.sql;
    const selection = editor.state.selection.main;
    return selection.empty ? editor.state.doc.toString() : editor.state.sliceDoc(selection.from, selection.to);
  };
  useImperativeHandle(ref, () => ({ selectedSql }));

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: tabRef.current.sql,
        extensions: [
          lineNumbers(), highlightActiveLine(), history(),
          dialect.current.of(sql({ dialect: connection?.config.db_type === "sqlite" ? SQLite : MySQL })),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.theme({
            "&": { height: "100%", fontSize: "inherit", backgroundColor: "hsl(var(--background))", color: "hsl(var(--foreground))" },
            ".cm-content": { fontFamily: "var(--font-mono, monospace)", padding: "8px 0", caretColor: "hsl(var(--foreground))" },
            ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" },
            ".cm-gutters": { backgroundColor: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))", border: "none" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "hsl(var(--muted) / .5)" },
            ".cm-cursor": { borderLeftColor: "hsl(var(--foreground))" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "hsl(var(--muted))" },
          }),
          EditorView.contentAttributes.of({ "aria-label": "SQL 编辑器" }),
          keymap.of([{ key: "Mod-Enter", run: () => { void useDbStore.getState().executeQuery(tabRef.current.id, selectedSql()); return true; } }, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) useDbStore.getState().updateTabSql(tabRef.current.id, update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [tab.id]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== tab.sql) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: tab.sql } });
  }, [tab.sql]);
  useEffect(() => {
    view.current?.dispatch({ effects: dialect.current.reconfigure(sql({ dialect: connection?.config.db_type === "sqlite" ? SQLite : MySQL })) });
  }, [connection?.config.db_type]);
  return <div ref={host} className="h-full min-h-0 overflow-hidden text-caption" />;
});
SqlEditor.displayName = "SqlEditor";
