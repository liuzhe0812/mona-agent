---
name: "db-dev"
description: "Database module development guide for Mona. Invoke when developing, debugging, or adding features to the database client module (db/)."
---

# Database Module Development Guide

## CellValue Serialization (CRITICAL)

`CellValue` in `src-tauri/src/db/types.rs` uses **custom Serialize/Deserialize**, NOT derive macros.

**Why**: Rust `#[serde(rename_all = "snake_case")]` produces `{"integer": 42}`, but frontend expects discriminated union `{ type: "integer", value: 42 }`. Manual impl ensures exact match.

**Rule**: If you add a new CellValue variant, you MUST update all three places:
1. Manual `Serialize`/`Deserialize` impl in `types.rs`
2. TypeScript type in `webui/src/components/db/types.ts`
3. `displayCellValue()` helper in `webui/src/components/db/types.ts`

## Tauri IPC Parameter Naming

All IPC functions in `ipc.ts` pass args with **snake_case keys** matching Rust parameter names. Tauri's default deserializer accepts this directly.

**Rule**: When adding a new Tauri Command, ensure the JS `invoke()` args keys exactly match the Rust function parameter names (snake_case).

## Dual Driver Rules

- **SQLite**: `rusqlite` — synchronous ops via `std::sync::Mutex<Connection>`
- **MySQL**: `sqlx` — async ops via `MySqlPool`

**Rule**: Every new method in `ConnectionManager` must handle both `DbHandle::Sqlite` and `DbHandle::Mysql` variants. SQLite methods are sync (lock mutex), MySQL methods are async (use pool).

## Layout Rules

- `DbClientView` root: MUST have `overflow-hidden`, middle column MUST have `min-h-0 min-w-0`
- `DashboardView`/`UsersView`: MUST be wrapped in `flex min-h-0 flex-1 flex-col overflow-hidden` to coexist with status bar
- `App.tsx`: When adding new view types to `ShellView`, MUST add to the `invisible pointer-events-none` condition, otherwise chat input box shows through

## Pitfalls

1. **CellValue serialization mismatch** — #1 cause of "data returns but UI shows nothing". Always verify JSON shape matches TypeScript types.

2. **`rusqlite::Statement` has no `column()` method** — Use `column_name(i)` for names, `row.get_ref(i)` for type inference after first `next()`.

3. **`sqlx::query_scalar` doesn't work with `SHOW STATUS LIKE`** — Returns (Variable_name, Value) tuple. Use `query_as::<_, (String, String)>()` then parse `row.1`.

4. **`SHOW CREATE TABLE` DDL is in column index 1** — Column 0 is the table name. Use `row.try_get_unchecked::<String, _>(1)`.

5. **MySQL `mysql.user` table varies by version** — Don't assume columns like `GRANT_OPTION` exist. Use safe minimal queries.

6. **Flex layout overflow** — Without `min-h-0` on flex children, content won't shrink and will overflow. Always add `min-h-0` to flex-1 containers that need to scroll.

7. **selectTable must auto-query** — Clicking a table must create/switch a query tab and execute `SELECT * FROM table LIMIT 100`, not just load metadata.
