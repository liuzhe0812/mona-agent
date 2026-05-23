# CLI Reference

| Command | Description |
|---------|-------------|
| `mona onboard` | Initialize config & workspace at `~/.mona/` |
| `mona onboard --wizard` | Launch the interactive onboarding wizard |
| `mona onboard -c <config> -w <workspace>` | Initialize or refresh a specific instance config and workspace |
| `mona agent -m "..."` | Chat with the agent |
| `mona agent -w <workspace>` | Chat against a specific workspace |
| `mona agent -w <workspace> -c <config>` | Chat against a specific workspace/config |
| `mona agent` | Interactive chat mode |
| `mona agent --no-markdown` | Show plain-text replies |
| `mona agent --logs` | Show runtime logs during chat |
| `mona serve` | Start the OpenAI-compatible API |
| `mona gateway` | Start the gateway |
| `mona status` | Show status |
| `mona provider login openai-codex` | OAuth login for providers |
| `mona channels login <channel>` | Authenticate a channel interactively |
| `mona channels status` | Show channel status |

Interactive mode exits: `exit`, `quit`, `/exit`, `/quit`, `:q`, or `Ctrl+D`.
