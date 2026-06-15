#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictCheck {
    Ok,
    ModifiedExternally { remote_mtime: u64, remote_size: u64 },
}

pub fn check_conflict(
    expect_mtime: u64,
    expect_size: u64,
    remote_mtime: u64,
    remote_size: u64,
) -> ConflictCheck {
    // SFTP mtime may be reported in seconds or milliseconds depending on the
    // server. Normalize to seconds to avoid false positives across filesystems.
    let expect_mtime_sec = expect_mtime / 1000;
    let remote_mtime_sec = remote_mtime / 1000;
    if expect_mtime_sec != remote_mtime_sec || expect_size != remote_size {
        ConflictCheck::ModifiedExternally {
            remote_mtime,
            remote_size,
        }
    } else {
        ConflictCheck::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_mtime_and_size_returns_ok() {
        assert_eq!(
            check_conflict(1_700_000_000_000, 100, 1_700_000_000_500, 100),
            ConflictCheck::Ok
        );
    }

    #[test]
    fn different_size_returns_conflict() {
        assert!(
            matches!(
                check_conflict(1_700_000_000_000, 100, 1_700_000_000_500, 200),
                ConflictCheck::ModifiedExternally { .. }
            ),
            "expected conflict when remote size differs"
        );
    }

    #[test]
    fn different_mtime_sec_returns_conflict() {
        assert!(
            matches!(
                check_conflict(1_700_000_000_000, 100, 1_700_000_001_000, 100),
                ConflictCheck::ModifiedExternally { .. }
            ),
            "expected conflict when remote mtime differs by at least one second"
        );
    }
}
