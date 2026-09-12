import { describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { dbGetTableSummaries } from "@/components/db/ipc";

describe("database catalog IPC", () => {
  it("sends the selected connection and database using the Rust command's camel-case arguments", async () => {
    await dbGetTableSummaries("connection-2", "业务库");
    expect(invoke).toHaveBeenCalledWith("db_get_table_summaries", { connectionId: "connection-2", database: "业务库" });
  });
});
