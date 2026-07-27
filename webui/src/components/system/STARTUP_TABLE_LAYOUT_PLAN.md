# Startup Table Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every startup table column stable when application names are long.

**Architecture:** Use native fixed table layout and a `colgroup`. Keep the name on one line with CSS ellipsis and expose the complete value through the native `title` tooltip.

**Tech Stack:** React, TypeScript, Tailwind CSS, Vitest

---

### Task 1: Constrain the startup application table

**Files:**
- Modify: `webui/src/components/system/StartupPanel.tsx`
- Test: `webui/src/components/system/SystemView.test.tsx`

- [x] Add a long startup application name to the test fixture and assert the table uses `table-fixed`, the name cell uses `truncate`, and its `title` contains the full name.
- [x] Run the focused test and observe the missing tooltip assertion fail.
- [x] Add a `colgroup` with fixed widths and render name, publisher, and source inside single-line truncated elements.
- [x] Run the focused SystemView tests and the TypeScript check; expect both to pass.
