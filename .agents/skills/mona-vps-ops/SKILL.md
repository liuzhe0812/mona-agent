---
name: mona-vps-ops
description: "Inspect, deploy, update, and diagnose Mona's One API and model-gateway services on the configured VPS. Use for explicit requests involving the Mona VPS, One API, upstream channels, or its production containers."
---

# Mona VPS Operations

Operate only this target unless the user explicitly provides another one:

- Host: `47.117.69.105`
- User: `root`
- Port: use the user-supplied port; otherwise use SSH's default port.

## Credentials

- Never write, repeat, log, commit, or place passwords, API keys, database DSNs, or private keys in this skill, shell history, command arguments, files, or final responses.
- Prefer an SSH key or an OS credential store. A secret supplied in the current conversation may be used only for that explicitly authorized operation and must not be persisted.
- Do not disclose environment-variable values or run commands that dump container environments.

## Operating boundary

- Treat this as production. First establish the target, task, current branch/container state, and whether the request is read-only or mutating.
- Read-only inspection is allowed when the user asks to inspect, check, diagnose, or report status.
- Restarting, updating images, changing One API channels/keys, editing reverse-proxy configuration, changing databases, rotating credentials, or deleting data require explicit confirmation immediately before the action.
- Never run `docker system prune`, `docker compose down -v`, destructive database commands, or unbounded log/file deletion unless the user explicitly names the exact target and approves it.

## First inspection

Do not assume a container name or Compose project. Start with compact, read-only checks:

```sh
hostnamectl
uptime
df -h
free -h
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker compose ls
ss -ltnp
```

For a One API issue, identify its actual container, image, listening port, mounted volumes, and database mode before proposing a change. Read only the recent relevant logs; avoid broad log dumps that can contain prompts or credentials.

## One API guidance

- Keep the One API management UI and its management token private. Prefer binding the container to loopback or a Docker-only network, then expose it only through an authenticated reverse proxy.
- Verify HTTPS, the administrator password, persistent volumes, database backups, container restart policy, and upstream-channel health before considering it production-ready.
- Multiple upstream keys under one provider account can share one RPM/TPM quota. Add an independent quota bucket or request a provider limit increase for real capacity; do not create accounts or keys to bypass provider limits.
- For streaming model responses, preserve streaming through the reverse proxy; inspect buffering and long-read-timeout settings before modifying them.

## Change procedure

1. Report the exact target, risk, and rollback path.
2. Obtain explicit confirmation for the mutation.
3. Back up the identified configuration/database according to the actual deployment before an update or schema-affecting change.
4. Make the smallest change.
5. Verify container health, One API's intended endpoint, and relevant logs.
6. Report changed files/containers, checks run, and anything not verified.

## Capacity and incidents

- For text-only proxying, observe concurrent streams, CPU, memory, bandwidth, file descriptors, upstream 429 rate, and request latency. The upstream provider's RPM/TPM is usually the first bottleneck, not VPS CPU.
- On upstream `429`, honor retry timing and identify whether the affected keys share a quota bucket. Do not blindly retry every configured key.
- On `401` or invalid credentials, disable only the affected channel after approval if that is a requested remediation; report the provider and channel identifier without exposing the secret.
