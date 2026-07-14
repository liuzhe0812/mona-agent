# Software Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Software tab's fabricated values with real WinGet and registry data, persistent operation failures, and conservative post-uninstall residual review.

**Architecture:** Keep WinGet as the only installer/uninstaller and the Windows uninstall registry as the installed-software source. Persist only operation outcomes in the existing `SystemState` SQLite connection. Treat registry sizes as partial estimates and residual paths as review candidates, never as automatically safe deletions.

**Tech Stack:** Rust, Tauri 2, rusqlite, Windows registry, React, TypeScript, Vitest

---

### Task 1: Make backend parsing and operation history trustworthy

**Files:**
- Modify: `src-tauri/src/system/software.rs`

- [x] Add a parser test containing Chinese names and verify `id`, current version, and target version.
- [x] Add an in-memory SQLite test proving a later successful retry removes an earlier failure from the unresolved count.
- [x] Run the focused tests and observe them fail before implementation.
- [x] Parse WinGet rows from the right-hand columns instead of UTF-8 byte positions.
- [x] Run WinGet with `Command::output()` inside `spawn_blocking`, preserving exit code and stderr without pipe deadlock.
- [x] Persist `package_id`, `name`, `action`, `success`, `exit_code`, and bounded message text in `software_operations`.

### Task 2: Expose honest installed-size and residual data

**Files:**
- Modify: `src-tauri/src/system/software.rs`

- [x] Read optional registry `EstimatedSize` and `InstallLocation` values.
- [x] Return `knownSizeBytes`, `knownSizeCount`, installed software, and unresolved failure count from `system_check_updates`.
- [x] After a successful Mona-initiated uninstall, inspect only the recorded install directory and exact-name AppData directories.
- [x] Return residual candidates with path, measured bytes, category, and explicit confirmation requirement; do not add deletion.
- [x] Run `cargo test system::software`; all software tests pass.

### Task 3: Connect the Software tab to the backend

**Files:**
- Modify: `webui/src/components/system/useSystemData.ts`
- Modify: `webui/src/components/system/SoftwarePanel.tsx`
- Modify: `webui/src/components/system/mockData.ts`
- Modify: `webui/src/components/system/SystemView.test.tsx`

- [x] Add failing tests for real update rendering, known-size coverage, sequential updates, and confirmed uninstall residual display.
- [x] Run the focused SystemView tests and observe the new assertions fail before implementation.
- [x] Add one `useSoftwareManagement` hook for check, sequential upgrade, uninstall, refresh, and operation result state.
- [x] Remove package-size, expected-download, exact-total-size, fixed failure, and fixed Adobe residual copy.
- [x] Label publisher-backed entries `常规更新` and missing-publisher entries `未评估`; do not claim `低风险` or guaranteed restart requirements.
- [x] Require an inline second confirmation before uninstall and display returned residual candidates without deleting them.

### Task 4: Verify the complete slice

**Files:**
- Test: `src-tauri/src/system/software.rs`
- Test: `webui/src/components/system/SystemView.test.tsx`

- [x] Run all Rust tests; 16 tests pass.
- [x] Run `npm test -- src/components/system/SystemView.test.tsx`; 9 System tests pass.
- [x] Run TypeScript checking with the unrelated unused-local rule disabled and run the Tauri Vite build successfully. The strict project build remains blocked by pre-existing `LoginDialog.tsx` unused state.
- [x] Confirm edited source files remain under `src-tauri/src/system` or `webui/src/components/system`.
