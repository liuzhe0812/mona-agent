---
name: my
description: Inspect the agent's runtime state and diagnose configuration or usage questions. When enabled, modify runtime settings or store temporary scratchpad notes.
short_description: Inspect runtime model, settings, usage, or tool failures.
---

# Self-Awareness

Use `my` to inspect the current model, settings, token usage, and configuration when diagnosing a failure. Call `check` without a key for an overview, or with a key or dot path for a specific value:

```text
my(action="check", key="model")
my(action="check", key="_last_usage.prompt_tokens")
```

`web_config` and `exec_config` are readable but cannot be modified.

## Optional changes

`my` is read-only by default. The `set` action requires `tools.my.allow_set` to be enabled. Changes are in memory and reset on restart. `max_iterations` must be between 1 and 100; `model` must be a non-empty string. Warn the user before a change that could cause instability, such as changing the model.

When enabled, `set` can also store scratchpad notes under a key, which `check` can later retrieve. Notes can survive across turns but are lost on restart; they are not persistent memory. Do not store credentials or other sensitive data there.

`my` cannot read or write `USER.md`. Use memory tools for long-term memory.

For additional examples, read [references/examples.md](references/examples.md).
