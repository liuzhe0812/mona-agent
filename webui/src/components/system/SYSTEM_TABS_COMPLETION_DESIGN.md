# System Tabs Completion Design

## Scope

Only the System module changes. The shared Mona Agent sidebar and its responsive docking behavior stay unchanged.

## Product decisions

- Keep the prototype's dense dashboard structure: metric cards first, primary data panels second, executable actions last.
- Render only values returned by Windows, WinGet, the registry, filesystem scans, event logs, or Mona's local operation database.
- Replace unsupported prototype fields instead of fabricating them: directory growth becomes file count; exact update download size remains unavailable; maintenance comparison becomes recorded execution detail.
- Preserve storage scan state while switching tabs and keep scan data only for the current System page session.

## Tabs

### Storage

- Always show total, used, available, and safely releasable capacity cards.
- Keep the partition, space distribution, file-type distribution, largest-directory, and safe-cleanup panels visible before, during, and after scanning.
- Collect file-type totals during the existing directory traversal; do not run a second scan.
- Clean only backend-approved cache/temp targets after an explicit UI confirmation. Unsupported or privileged targets remain visible but disabled with a reason.

### Software

- Keep WinGet updates and registry-installed applications as the only sources.
- Expose persistent unresolved operation failures with their real message and action.
- Use a fixed installed-software table for uninstall selection and retain the second confirmation plus conservative residual review.
- Do not claim exact download size or total application footprint when Windows does not provide it.

### Startup

- Scan Run registry entries, Startup folders, and logon/startup scheduled tasks.
- Keep fixed columns, ellipsis, native tooltips, signature information, reversible switches, batch operations, boot history, and change history.
- Label first-seen data as Mona discovery time rather than application installation time.

### Maintenance

- Replace all mock events and totals with a unified read model over startup changes, software operations, and storage cleanup operations.
- Provide real filtering, search, event detail, and recovery for reversible startup changes.
- Show failure counts instead of an unsupported generic "pending verification" number.

## Verification

- Frontend tests assert prototype panel structure and command wiring.
- Rust tests cover file classification, cleanup target validation, startup ID/task parsing, and maintenance aggregation.
- TypeScript checking, focused frontend tests, Rust tests, and the Tauri Vite build must pass; unrelated existing project failures are reported separately.
