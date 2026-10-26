#!/bin/sh
set -eu

credential_path="${CREDENTIALS_DIRECTORY:?systemd credentials are unavailable}/relay-api-key"
if [ ! -r "$credential_path" ]; then
    printf '%s\n' "Missing readable relay-api-key credential" >&2
    exit 1
fi

NOTEBOOK_RELAY_API_KEY=$(cat "$credential_path")
if [ -z "$NOTEBOOK_RELAY_API_KEY" ]; then
    printf '%s\n' "The relay-api-key credential is empty" >&2
    exit 1
fi
export NOTEBOOK_RELAY_API_KEY

exec /opt/notebook-relay/.venv/bin/python -m notebook_relay
