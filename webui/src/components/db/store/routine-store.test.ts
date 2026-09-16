import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbConnection } from "@/tests/db-fixtures";
import * as ipc from "../ipc";
import { useDbStore } from "./dbStore";

describe("routine catalog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "dbGetDatabases").mockResolvedValue(["analytics"]);
    vi.spyOn(ipc, "dbGetTables").mockResolvedValue([]);
    vi.spyOn(ipc, "dbGetViews").mockResolvedValue([]);
    vi.spyOn(ipc, "dbGetRoutines").mockResolvedValue([
      { name: "calculate_score", schema: "analytics", object_type: "function", children: [] },
      { name: "sync_data", schema: "analytics", object_type: "procedure", children: [] },
    ]);
    useDbStore.setState({
      activeConnections: [{ ...dbConnection, config: { ...dbConnection.config, db_type: "mysql" } }],
      connectionTree: {},
      connectError: null,
    });
  });

  it("loads MySQL functions and procedures into the real tree folder", async () => {
    await useDbStore.getState().refreshTree(dbConnection.id);
    expect(ipc.dbGetRoutines).toHaveBeenCalledWith(dbConnection.id, "analytics");
    const folder = useDbStore.getState().connectionTree[dbConnection.id][0].children
      .find((item) => item.name === "存储过程/函数");
    expect(folder?.children.map((item) => [item.name, item.object_type])).toEqual([
      ["calculate_score", "function"],
      ["sync_data", "procedure"],
    ]);
    expect(useDbStore.getState().connectionTree[dbConnection.id][0].children.map((item) => item.name)).toEqual([
      "表", "视图", "查询", "存储过程/函数",
    ]);
  });

  it("keeps table and view folders when routine metadata is unavailable", async () => {
    vi.mocked(ipc.dbGetTables).mockResolvedValue([
      { name: "users", schema: "analytics", object_type: "table", children: [] },
    ]);
    vi.mocked(ipc.dbGetRoutines).mockRejectedValue(new Error("permission denied"));
    await useDbStore.getState().refreshTree(dbConnection.id);
    const folders = useDbStore.getState().connectionTree[dbConnection.id][0].children;
    expect(folders.find((item) => item.name === "表")?.children[0].name).toBe("users");
    expect(folders.find((item) => item.name === "存储过程/函数")?.children).toEqual([]);
  });
});
