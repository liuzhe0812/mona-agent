import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlEditor } from "./SqlEditor";
import { getQueryDraft } from "./query-draft";
import { useDbStore } from "./store/dbStore";
import { dbConnection, dbTab } from "@/tests/db-fixtures";

describe("SqlEditor draft performance", () => {
  const originalUpdate = useDbStore.getState().updateTabSql;

  beforeEach(() => {
    vi.useFakeTimers();
    const tab = dbTab({ kind: "query", tableName: undefined, tableInfo: null, sql: "" });
    useDbStore.setState({ activeConnections: [dbConnection], queryTabs: [tab], activeTabId: tab.id });
  });

  afterEach(() => {
    useDbStore.setState({ updateTabSql: originalUpdate });
    vi.useRealTimers();
  });

  it("keeps rapid typing local and commits once after the user pauses", () => {
    const update = vi.fn();
    useDbStore.setState({ updateTabSql: update });
    const tab = useDbStore.getState().queryTabs[0];
    render(<SqlEditor tab={tab} />);
    const editor = EditorView.findFromDOM(screen.getByLabelText("SQL 编辑器"));

    act(() => {
      for (let index = 0; index < 200; index += 1) {
        editor.dispatch({ changes: { from: editor.state.doc.length, insert: "x" } });
      }
    });

    expect(getQueryDraft(tab.id)).toHaveLength(200);
    expect(update).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(499));
    expect(update).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(tab.id, "x".repeat(200));
  });

  it("routes Ctrl+S to the query save action", () => {
    const onSave = vi.fn();
    const tab = useDbStore.getState().queryTabs[0];
    render(<SqlEditor tab={tab} onSave={onSave} />);
    fireEvent.keyDown(screen.getByLabelText("SQL 编辑器"), { key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("flushes the current editor value immediately when focus leaves", () => {
    const update = vi.fn();
    useDbStore.setState({ updateTabSql: update });
    const tab = useDbStore.getState().queryTabs[0];
    render(<SqlEditor tab={tab} />);
    const content = screen.getByLabelText("SQL 编辑器");
    const editor = EditorView.findFromDOM(content);
    act(() => editor.dispatch({ changes: { from: 0, insert: "SELECT 1;" } }));
    act(() => content.dispatchEvent(new FocusEvent("blur", { bubbles: true })));
    expect(update).toHaveBeenCalledWith(tab.id, "SELECT 1;");
  });

  it("inserts a selected table at the cursor without executing SQL", () => {
    const tab = dbTab({ kind: "query", tableName: undefined, tableInfo: null, sql: "SELECT * FROM " });
    useDbStore.setState({ queryTabs: [tab], activeTabId: tab.id });
    const execute = vi.fn();
    useDbStore.setState({ executeQuery: execute });
    const ref = createRef<import("./SqlEditor").SqlEditorHandle>();
    render(<SqlEditor ref={ref} tab={tab} />);
    act(() => ref.current?.insertTable('"audit_logs"'));
    expect(ref.current?.currentSql()).toBe('SELECT * FROM "audit_logs"');
    expect(execute).not.toHaveBeenCalled();
  });
});
