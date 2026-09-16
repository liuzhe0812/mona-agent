import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionInfo, DbConnectionConfig, QueryResult } from "./types";
import { useDbStore } from "./store/dbStore";
import { textLiteral } from "./table-sql";

const mocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
}));

vi.mock("./ipc", () => ({
  dbExecuteQuery: mocks.executeQuery,
}));

import { DatabaseSettingsDialog } from "./DatabaseSettingsDialog";

const config: DbConnectionConfig = {
  id: "connection-1",
  name: "local mysql",
  db_type: "mysql",
  host: "localhost",
  port: 3306,
  username: "test-user",
  password: "",
  database: null,
  use_ssl: false,
  use_ssh_tunnel: false,
  ssh_host: null,
  ssh_port: null,
  ssh_username: null,
  ssh_auth: null,
};

const connection: ConnectionInfo = {
  id: config.id,
  config,
  status: "connected",
  server_version: null,
  error_message: null,
};

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return {
    columns: columns.map((name) => ({
      name,
      data_type: "TEXT",
      nullable: true,
      is_primary_key: false,
      is_auto_increment: false,
    })),
    rows,
    affected_rows: 0,
    execution_time_ms: 1,
    message: null,
  };
}

const charsetResult = result(
  ["Charset", "Description", "Default collation", "Maxlen"],
  [
    [
      { type: "text", value: "utf8mb4" },
      { type: "text", value: "UTF-8 Unicode" },
      { type: "text", value: "utf8mb4_0900_ai_ci" },
      { type: "integer", value: 4 },
    ],
    [
      { type: "text", value: "latin1" },
      { type: "text", value: "cp1252 West European" },
      { type: "text", value: "latin1_swedish_ci" },
      { type: "integer", value: 1 },
    ],
  ],
);

const collationResult = result(
  ["Collation", "Charset", "Id", "Default"],
  [
    [
      { type: "text", value: "utf8mb4_0900_ai_ci" },
      { type: "text", value: "utf8mb4" },
      { type: "integer", value: 255 },
      { type: "text", value: "Yes" },
    ],
    [
      { type: "text", value: "latin1_swedish_ci" },
      { type: "text", value: "latin1" },
      { type: "integer", value: 8 },
      { type: "text", value: "Yes" },
    ],
  ],
);

const schemaResult = result(
  ["DEFAULT_CHARACTER_SET_NAME", "DEFAULT_COLLATION_NAME"],
  [[
    { type: "text", value: "utf8mb4" },
    { type: "text", value: "utf8mb4_0900_ai_ci" },
  ]],
);

function installConnectedStore(overrides: Partial<ConnectionInfo> = {}) {
  useDbStore.setState({
    activeConnections: [{ ...connection, ...overrides }],
    selectedDatabase: "global-selection-that-must-not-win",
  });
}

function installQueryMock() {
  mocks.executeQuery.mockImplementation((_connectionId: string, sql: string) => {
    if (sql === "SHOW CHARACTER SET") return Promise.resolve(charsetResult);
    if (sql === "SHOW COLLATION") return Promise.resolve(collationResult);
    if (sql.includes("information_schema.SCHEMATA")) return Promise.resolve(schemaResult);
    return Promise.resolve(result([], []));
  });
}

describe("DatabaseSettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installConnectedStore();
    installQueryMock();
  });

  it("loads real server options and creates an escaped database only after clicking create", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<DatabaseSettingsDialog connectionId="connection-1" onClose={onClose} onSaved={onSaved} />);

    const create = await screen.findByRole("button", { name: "创建" });
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(mocks.executeQuery.mock.calls.some(([_, sql]) => String(sql).startsWith("CREATE DATABASE"))).toBe(false);

    fireEvent.change(screen.getByRole("textbox", { name: "数据库名称" }), {
      target: { value: "report`db" },
    });
    fireEvent.click(create);

    await waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith(
      "connection-1",
      "CREATE DATABASE `report``db` CHARACTER SET `utf8mb4` COLLATE `utf8mb4_0900_ai_ci`",
    ));
    expect(onSaved).toHaveBeenCalledWith("report`db");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the right-click database target, reads current defaults with a text literal, and links charset to its default collation", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(
      <DatabaseSettingsDialog
        connectionId="connection-1"
        database="target`db"
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    const save = await screen.findByRole("button", { name: "保存" });
    expect(screen.getByRole("textbox", { name: "数据库名称" })).toHaveAttribute("readonly");
    expect(mocks.executeQuery.mock.calls.some(([_, sql]) =>
      String(sql).includes(`SCHEMA_NAME = ${textLiteral("target`db", false)}`))).toBe(true);

    fireEvent.keyDown(screen.getByRole("button", { name: "字符集" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "latin1" }));
    expect(screen.getByRole("button", { name: "排序规则" })).toHaveTextContent("latin1_swedish_ci");

    fireEvent.click(save);
    await waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith(
      "connection-1",
      "ALTER DATABASE `target``db` CHARACTER SET `latin1` COLLATE `latin1_swedish_ci`",
    ));
    expect(onSaved).toHaveBeenCalledWith("target`db");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open and disables submit when metadata loading fails or the write fails", async () => {
    mocks.executeQuery.mockRejectedValueOnce(new Error("metadata unavailable"));
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const { unmount } = render(
      <DatabaseSettingsDialog connectionId="connection-1" onClose={onClose} onSaved={onSaved} />,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("metadata unavailable"));
    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    unmount();

    vi.clearAllMocks();
    installConnectedStore();
    installQueryMock();
    mocks.executeQuery.mockImplementation((_connectionId: string, sql: string) => {
      if (sql === "SHOW CHARACTER SET") return Promise.resolve(charsetResult);
      if (sql === "SHOW COLLATION") return Promise.resolve(collationResult);
      return Promise.reject(new Error("permission denied"));
    });
    const failedClose = vi.fn();
    const failedSaved = vi.fn();
    render(<DatabaseSettingsDialog connectionId="connection-1" onClose={failedClose} onSaved={failedSaved} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "数据库名称" }), { target: { value: "app" } });
    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    expect(failedClose).not.toHaveBeenCalled();
    expect(failedSaved).not.toHaveBeenCalled();
  });

  it("does not allow unsupported or disconnected connections to submit", async () => {
    installConnectedStore({ status: "disconnected", config: { ...config, db_type: "sqlite" } });
    render(<DatabaseSettingsDialog connectionId="connection-1" onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("连接已断开");
    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });
});
