# Storage Scan Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show useful storage data immediately and preserve an in-progress deep scan while users switch System tabs.

**Architecture:** Reuse `system_get_overview` for live disk capacity. Lift the existing `useStorageScan` instance into `SystemView`, pass it into `StoragePanel`, and keep recursive work on Tokio's blocking pool.

**Tech Stack:** React, TypeScript, Tauri 2, Rust, Vitest

---

### Task 1: Define the frontend behavior with failing tests

**Files:**
- Modify: `webui/src/components/system/SystemView.test.tsx`

- [x] Add a test that renders the Storage tab without invoking `scan_storage` and expects live total, used, and available disk values from `system_get_overview`.
- [x] Add a deferred `scan_storage` mock, switch from Storage to Software and back, and expect the same scan to remain active and later expose its result.
- [x] Run the focused storage tests and observe both new behaviors fail.

### Task 2: Keep scan state and show immediate information

**Files:**
- Modify: `webui/src/components/system/SystemView.tsx`
- Modify: `webui/src/components/system/StoragePanel.tsx`

- [x] Call `useStorageScan()` once in `SystemView` and pass the returned controller to `StoragePanel`.
- [x] Reuse `useSystemOverview()` in `StoragePanel` to render capacity cards and partitions before and during deep scanning.
- [x] Keep the existing completed result view and label progress coverage as scan regions.
- [x] Run the focused storage tests; both pass.

### Task 3: Move recursive work off the async executor

**Files:**
- Modify: `src-tauri/src/system/mod.rs`

- [x] Move the current synchronous scan body into `scan_storage_inner(app)` without changing its result contract.
- [x] Make the Tauri command await `tokio::task::spawn_blocking(move || scan_storage_inner(app))` and convert join failures to a user-visible error.
- [x] Run all Rust tests and the frontend SystemView tests; all 16 Rust and 12 SystemView tests pass.
- [x] Run the TypeScript check and Tauri Vite build; this slice compiles and bundles.
