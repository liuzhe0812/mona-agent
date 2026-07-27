# System Agent Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the System module's per-tab mock assistant into one persistent, responsive system-level Agent workspace.

**Architecture:** Keep the existing five panels unchanged. Move the assistant beside the complete left-hand System workspace, keep its state above tab changes, and use a small local state machine to preview the approved diagnose-plan-confirm-verify flow without invoking system mutations.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Vitest, Testing Library

---

### Task 1: Lock the shared-Agent behavior with tests

**Files:**
- Modify: `webui/src/components/system/SystemView.test.tsx`

- [x] Replace the per-tab static-copy assertions with assertions that the Agent title and current task survive tab changes.
- [x] Add a lifecycle test for `等待目标 → 正在检查 → 方案待确认 → 正在执行 → 验证完成`.
- [x] Add an assertion that an Agent evidence-source button switches the left panel to its corresponding tab.
- [x] Run `npm test -- --run src/components/system/SystemView.test.tsx` from `webui`; expect the new assertions to fail before implementation.

### Task 2: Correct the System module layout boundary

**Files:**
- Modify: `webui/src/components/system/SystemView.tsx`

- [x] Make the left header, tabs, and active panel one column and the Agent its sibling column.
- [x] Dock the 360 px Agent only at 1440 px and above; keep the main content capped at 1160 px.
- [x] Pass a check-request signal and tab-navigation callback to the shared Agent.

### Task 3: Replace the mock assistant with the Agent workspace

**Files:**
- Modify: `webui/src/components/system/SystemAssistant.tsx`
- Modify: `webui/src/components/system/mockData.ts`

- [x] Render one persistent Agent header, goal, evidence sources, selectable plan, confirmation action, and fixed composer.
- [x] Add a contained drawer and floating launcher below 1440 px; use a full-width drawer on small screens.
- [x] Keep the preview honest: label it as an interaction preview and report that no real system changes occurred.
- [x] Remove the obsolete `assistantCopy` data made unused by this change.

### Task 4: Verify the frontend

**Files:**
- Test: `webui/src/components/system/SystemView.test.tsx`

- [x] Run `npm test -- --run src/components/system/SystemView.test.tsx`; expect all System tests to pass.
- [x] Run `npm run build`; expect TypeScript and Vite to complete successfully.
- [x] Review the changed paths and confirm every edited source file stays inside the System module.
