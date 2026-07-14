# Storage Scan Interaction Design

## Decision

The Storage tab shows live partition capacity immediately from the existing system overview command. Directory sizes and cleanup candidates remain an explicit deep scan because they require recursive disk I/O.

The deep-scan controller lives in `SystemView`, so changing among the five System tabs does not destroy its progress or result. State lasts only for the current System page session; no historical scan rows are persisted.

## Scan behavior

- Opening Storage performs no recursive scan.
- Starting a deep scan keeps live disk information visible and shows scan progress below it.
- Switching tabs keeps the scan listener and pending result alive.
- Returning to Storage shows the current progress or completed result.
- Recursive filesystem work runs through Tokio's blocking pool rather than on an async executor thread.
- Existing progress counts are described as scan regions, not individual directories.

## Verification

Frontend tests cover immediate disk information and state retention across tab switches. Rust tests and compilation cover the unchanged scan result contract after moving the synchronous traversal into a blocking task.
