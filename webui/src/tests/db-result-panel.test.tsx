import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ResultPanel } from "@/components/db/ResultPanel";
import { useDbStore } from "@/components/db/store/dbStore";
import type { QueryTab } from "@/components/db/types";

const tab: QueryTab = {
  id: "tab-1",
  title: "users",
  sql: "select * from users",
  result: {
    columns: [
      {
        name: "id",
        data_type: "INTEGER",
        nullable: false,
        is_primary_key: true,
        is_auto_increment: true,
      },
      {
        name: "name",
        data_type: "TEXT",
        nullable: true,
        is_primary_key: false,
        is_auto_increment: false,
      },
    ],
    rows: [
      [
        { type: "integer", value: 42 },
        { type: "text", value: "Ada" },
      ],
    ],
    affected_rows: 0,
    execution_time_ms: 3,
    message: null,
  },
  isExecuting: false,
  connectionId: null,
  database: null,
  edits: [],
  insertedRows: [],
  tableInfo: null,
  agentChatId: null,
};

describe("ResultPanel table", () => {
  beforeEach(() => {
    useDbStore.setState({ queryTabs: [tab], activeTabId: tab.id });
  });

  it("uses professional density and neutral selection states", () => {
    render(<ResultPanel />);

    expect(screen.getByRole("columnheader", { name: "#" })).toHaveClass(
      "h-9",
      "px-3",
    );
    expect(screen.getByRole("columnheader", { name: /id PK/ })).toHaveClass(
      "h-9",
      "px-3",
      "bg-editor-surface",
    );

    expect(screen.getByRole("table").closest(".bg-editor-surface")).toBeInTheDocument();

    const numberCell = screen.getByText("42").closest("td");
    const textCell = screen.getByText("Ada").closest("td");
    const row = textCell?.closest("tr");
    expect(numberCell).toHaveClass("h-10", "px-3", "text-right");
    expect(textCell).toHaveClass("h-10", "px-3", "text-left");
    expect(row).toHaveClass("h-10", "border-b", "hover:bg-foreground/5");

    fireEvent.click(screen.getByText("Ada"));

    expect(row).toHaveClass("bg-foreground/5");
    expect(textCell).toHaveClass(
      "bg-foreground/5",
      "ring-1",
      "ring-foreground/40",
    );
    expect(textCell).not.toHaveClass("bg-info/20");
    expect(screen.getByRole("columnheader", { name: /name/ })).toHaveClass(
      "bg-foreground/5",
    );
  });

  it("keeps right-click selection available for the context menu", () => {
    render(<ResultPanel />);
    const textCell = screen.getByText("Ada");

    fireEvent.pointerDown(textCell, { button: 2 });

    expect(textCell.closest("td")).toHaveClass("ring-1", "bg-foreground/5");
  });
});
