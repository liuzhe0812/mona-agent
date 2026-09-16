import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const files = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => files);
import { DatabaseTransferDialog } from "./DatabaseTransferDialog";
import * as ipc from "./ipc";
import { useDbStore } from "./store/dbStore";
import { dbConnection } from "@/tests/db-fixtures";

beforeEach(() => {
  vi.restoreAllMocks(); files.open.mockReset(); files.save.mockReset();
  useDbStore.setState({ activeConnections: [{ ...dbConnection, config: { ...dbConnection.config, db_type: "mysql" } }], queryTabs: [], selectedDatabase: "different_db" });
});

describe("database import/export", () => {
  it("exports structure only using the chosen file and frozen database target", async () => {
    files.save.mockResolvedValue("C:/exports/schema.sql");
    const backup = vi.spyOn(ipc, "dbBackupDatabase").mockResolvedValue();
    render(<DatabaseTransferDialog connectionId={dbConnection.id} database="analytics" mode="export" exportMode="structure" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    await screen.findByText("C:/exports/schema.sql");
    fireEvent.click(screen.getByRole("button", { name: "导出", exact: true }));
    await waitFor(() => expect(backup).toHaveBeenCalledWith(dbConnection.id, "analytics", "C:/exports/schema.sql", true, false));
    expect(await screen.findByRole("status")).toHaveTextContent("导出完成");
  });
  it("does not execute import when file selection is canceled", async () => {
    files.open.mockResolvedValue(null);
    const restore = vi.spyOn(ipc, "dbRestoreDatabase");
    render(<DatabaseTransferDialog connectionId={dbConnection.id} database="analytics" mode="import" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    await waitFor(() => expect(files.open).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "导入", exact: true })).toBeDisabled();
    expect(restore).not.toHaveBeenCalled();
  });
  it("requires the import button and keeps the dialog open on failure", async () => {
    files.open.mockResolvedValue("C:/exports/backup.sql");
    const restore = vi.spyOn(ipc, "dbRestoreDatabase").mockRejectedValue(new Error("SQL import failed"));
    render(<DatabaseTransferDialog connectionId={dbConnection.id} database="analytics" mode="import" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    await screen.findByText("C:/exports/backup.sql");
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "导入", exact: true }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(dbConnection.id, "analytics", "C:/exports/backup.sql"));
    expect(await screen.findByText(/SQL import failed/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
