# System Tabs Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Storage, Software, Startup, and Maintenance tabs with prototype-aligned layouts and verifiable Windows data while preserving the shared Agent sidebar.

**Architecture:** Reuse the existing System hooks and Tauri commands. Extend only the missing result fields and commands, keep destructive filesystem work behind backend allowlists and explicit confirmation, and derive Maintenance from already persisted System operations.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Tauri 2, Rust, rusqlite, Vitest

---

### Task 1: Lock the four-tab contract

**Files:**
- Modify: `webui/src/components/system/SystemView.test.tsx`
- Modify: `src-tauri/src/system/mod.rs`
- Modify: `src-tauri/src/system/startup.rs`

- [x] Add frontend assertions for all Storage prototype panels, real software failures, scheduled startup rows, and real Maintenance events.
- [x] Add Rust tests for file-type categorization, cleanup allowlisting, registry startup ID parsing, and maintenance event mapping.
- [x] Run the focused tests and verify the new assertions fail for missing behavior.

### Task 2: Complete Storage

**Files:**
- Modify: `src-tauri/src/system/mod.rs`
- Modify: `webui/src/components/system/useSystemData.ts`
- Modify: `webui/src/components/system/StoragePanel.tsx`

- [x] Aggregate file types in the existing scan pass and return cleanability metadata.
- [x] Add a backend-approved cleanup command that records released bytes without deleting outside known targets.
- [x] Render the four-card, three-panel, two-panel prototype structure in every scan state.
- [x] Run the focused Storage tests until green.

### Task 3: Complete Software and Startup

**Files:**
- Modify: `src-tauri/src/system/software.rs`
- Modify: `src-tauri/src/system/startup.rs`
- Modify: `webui/src/components/system/useSystemData.ts`
- Modify: `webui/src/components/system/SoftwarePanel.tsx`
- Modify: `webui/src/components/system/StartupPanel.tsx`

- [x] Return unresolved software failure details and render them beside the update workflow.
- [x] Replace the uninstall selector with a fixed installed-software table while retaining confirmation and residual review.
- [x] Correct registry startup ID handling, add scheduled-task discovery/toggling, and use the existing batch command.
- [x] Run focused Software and Startup tests until green.

### Task 4: Replace Maintenance mock data

**Files:**
- Create: `src-tauri/src/system/maintenance.rs`
- Modify: `src-tauri/src/system/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `webui/src/components/system/useSystemData.ts`
- Modify: `webui/src/components/system/MaintenancePanel.tsx`
- Modify: `webui/src/components/system/mockData.ts`

- [x] Query startup, software, and cleanup operation history into one typed result.
- [x] Render real metrics, filtering, search, details, and startup recovery.
- [x] Remove obsolete System mock maintenance and storage data.
- [x] Run focused Maintenance tests until green.

### Task 5: Verify delivery

**Files:**
- Test: `webui/src/components/system/SystemView.test.tsx`
- Test: `src-tauri/src/system/*.rs`

- [x] Run focused frontend tests, Rust tests, TypeScript checking, and the Tauri Vite build.
- [x] Inspect the responsive layout contract and verify the shared Agent sidebar is unchanged.
- [x] Review the diff and confirm every edited source path belongs to the System module, except required Tauri command registration.
