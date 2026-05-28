#!/usr/bin/env bash
# Mona SSH/SFTP Override Functions for Bash/Zsh
# This script overrides ssh and sftp commands in Mona's local shell.
# When Mona is running, these functions intercept ssh/sftp calls to create
# integrated terminal sessions. Otherwise, they fall back to system commands.

ssh() {
    command ssh "$@"
}

sftp() {
    command sftp "$@"
}
