import { useRef, useEffect } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { sql } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { useDbStore } from "./store/dbStore";

const customTheme = EditorView.theme({
  "&": {
    fontSize: "13px",
    lineHeight: "1.6",
    height: "100%",
  },
  ".cm-content": {
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
    padding: "12px 14px",
    caretColor: "hsl(210, 80%, 55%)",
  },
  ".cm-focused": {
    outline: "none",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "none",
    color: "hsl(0, 0%, 60%)",
    fontSize: "11px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
  },
  ".cm-cursor": {
    borderLeftColor: "hsl(210, 80%, 55%)",
    borderLeftWidth: "2px",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "hsl(210, 80%, 55%, 0.2) !important",
  },
});

export function SqlEditor() {
  const activeTabId = useDbStore((s) => s.activeTabId);
  const queryTabs = useDbStore((s) => s.queryTabs);
  const updateTabSql = useDbStore((s) => s.updateTabSql);
  const executeQuery = useDbStore((s) => s.executeQuery);
  const activeTab = queryTabs.find((t) => t.id === activeTabId);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const tabIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;

    const state = EditorState.create({
      doc: activeTab?.sql ?? "",
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        sql(),
        customTheme,
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const tabId = tabIdRef.current;
            if (tabId) {
              updateTabSql(tabId, update.state.doc.toString());
            }
          }
        }),
        keymap.of([
          {
            key: "Ctrl-Enter",
            run: () => {
              const tabId = tabIdRef.current;
              if (tabId) executeQuery(tabId);
              return true;
            },
          },
          {
            key: "Cmd-Enter",
            run: () => {
              const tabId = tabIdRef.current;
              if (tabId) executeQuery(tabId);
              return true;
            },
          },
        ]),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;
    tabIdRef.current = activeTabId ?? null;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activeTabId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !activeTab) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc !== activeTab.sql) {
      view.dispatch({
        changes: {
          from: 0,
          to: currentDoc.length,
          insert: activeTab.sql,
        },
      });
    }
  }, [activeTab?.sql]);

  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        选择或新建一个查询标签
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={editorRef} className="flex-1 overflow-hidden" />
      <div className="flex items-center justify-between border-t border-border bg-card px-3.5 py-1 text-[11px] text-muted-foreground">
        <span>Ctrl+Enter 执行</span>
        <span>UTF-8 | SQL</span>
      </div>
    </div>
  );
}
