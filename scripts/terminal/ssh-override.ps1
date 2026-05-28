# Mona SSH/SFTP Override Functions for PowerShell
# This script overrides ssh and sftp commands in Mona's local shell.
# When Mona is running, these functions intercept ssh/sftp calls to create
# integrated terminal sessions. Otherwise, they fall back to system commands.

function ssh {
    param([Parameter(ValueFromRemainingArguments)]$args)

    # Try to find the system ssh command
    $systemSsh = Get-Command ssh -CommandType Application -ErrorAction SilentlyContinue

    if ($null -ne $systemSsh) {
        & $systemSsh.Path @args
    } else {
        Write-Error "ssh command not found"
    }
}

function sftp {
    param([Parameter(ValueFromRemainingArguments)]$args)

    # Try to find the system sftp command
    $systemSftp = Get-Command sftp -CommandType Application -ErrorAction SilentlyContinue

    if ($null -ne $systemSftp) {
        & $systemSftp.Path @args
    } else {
        Write-Error "sftp command not found"
    }
}
