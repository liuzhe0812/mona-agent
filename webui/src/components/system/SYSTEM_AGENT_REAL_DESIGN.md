# System Agent Real Capability Design

## Scope

Replace the System sidebar preview with a real, read-only AI planning request and a frontend-controlled execution path. The five System tabs remain the only evidence sources and the sidebar remains shared across them.

## Data flow

1. The sidebar concurrently reads overview, software updates, startup items, maintenance history, and an already-completed storage scan.
2. It posts a compact evidence snapshot plus the user goal to the local gateway.
3. The gateway calls the configured LLM provider directly with no tools and validates its JSON against the supplied evidence.
4. The frontend shows only validated actions. The user can deselect actions and explicitly confirm execution.
5. The frontend maps each action to an existing Tauri command, re-reads evidence, and shows the actual result.

## Action boundary

- `storage_clean`: only scan-returned `cleanable` cache IDs.
- `software_update`: only currently returned WinGet update IDs.
- `startup_toggle`: only current startup IDs, with an explicit target enabled state.
- No uninstall, residual deletion, arbitrary command, registry edit, or model-generated command text is executable.

## Failure behavior

No provider, invalid JSON, unavailable gateway, or no evidence produces an explicit error and no executable plan. The UI never substitutes a mock plan.
