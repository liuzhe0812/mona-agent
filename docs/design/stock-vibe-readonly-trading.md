# Stock Vibe hosted trading write boundary

This patch is a hosted integration policy. It keeps the standalone Vibe-Trading product behavior intact and applies only when the host starts the native runtime with `VIBE_TRADING_HOSTED=1`.

`ToolRegistry.execute()` is the common native Agent dispatch point. The seven direct broker writer tools are marked as online broker writes and omitted while the hosted registry is built. The dispatch check also rejects a marked tool if another path registers it later. Trading account, positions, orders, and history reads remain available. The profile selector rejects a write-capable live profile and ignores an older persisted selection of one in favor of the local paper profile; a live profile explicitly marked read-only remains selectable.

Remote broker MCP tools pass through the existing broker classifier. A curated WRITE classification overrides a server's `readOnlyHint`; tools classified UNKNOWN also fail closed. Hosted mode keeps only READ tools. MCP servers that do not match a broker key or URL host in the native classifier are skipped before remote discovery, so hosted mode does not accept unclassified MCP servers as general-purpose tools. The Vibe-owned MCP server separately refuses tools whose native class is not read-only; direct broker writers remain ineligible for that mirror.

Local backtest, Shadow, research, and Swarm tools are not classified as online broker writes and remain in the registry. The host's private HTTP route allowlist remains a separate boundary and does not expose native live-trading routes.

The integration test builds a controlled source tree and exercises the real native registry, profile store, broker classifier, dispatch guard, and MCP mirror guard in a child interpreter with private HOME and Vibe data roots. It makes no broker calls and uses no credentials. This verifies tool exposure and local refusal paths, not live broker behavior.

The direct writer markers must be maintained when a new broker-writing Agent tool is added. Remote MCP support is limited to brokers recognized by the existing key/URL classifier; adding another broker requires adding its key or URL suffix and curated tool classifications. Standalone Vibe and direct local library callers retain their existing capabilities.

In hosted mode, the native `read_file` tool may also read files under the private `swarm/runs` root so one Swarm worker can review another worker's evidence. This expands only the read allowlist: `allowed_write_roots()` remains unchanged, standalone Vibe roots remain unchanged, and files outside the private read roots continue to be refused.
