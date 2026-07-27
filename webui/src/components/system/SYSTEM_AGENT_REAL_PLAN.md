# System Agent Real Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the System sidebar generate and execute a validated, evidence-backed maintenance plan.

**Architecture:** The gateway invokes the configured LLM without tools, validates every action against the supplied evidence, and returns structured plan data. The System frontend gathers evidence, invokes only fixed existing Tauri commands, then rechecks state.

**Tech Stack:** React, TypeScript, Tauri, Python aiohttp, Mona LLM provider, Vitest, pytest.

---

### Task 1: Validate LLM plans on the gateway

- [ ] Add a failing Python test for accepting only evidence-backed cleanup, update, and startup actions.
- [ ] Add the smallest plan normalizer and direct no-tools provider call.
- [ ] Add the gateway route and run the focused Python test.

### Task 2: Collect and execute System actions in the frontend

- [ ] Add failing frontend tests for evidence collection, plan rendering, and fixed command execution.
- [ ] Add System-only API helpers with a closed action-to-command mapping.
- [ ] Run the focused frontend test.

### Task 3: Replace the preview UI

- [ ] Replace timeout stages and fixed action cards with real request, selection, execution, and verification states.
- [ ] Pass the shared storage scan into the sidebar and retain cross-tab navigation.
- [ ] Run TypeScript checking and the Tauri build.
