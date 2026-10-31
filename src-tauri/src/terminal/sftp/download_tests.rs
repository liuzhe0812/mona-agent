use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode,
};
use tokio_util::sync::CancellationToken;

const ROOT: &str = "/repo";
const CONTENT: &[u8] = b"downloaded content\n";

#[derive(Clone, Copy)]
enum LinkTarget {
    Version,
    Root,
    Outside,
    Collision,
}

#[derive(Default)]
struct Calls {
    root_opens: AtomicUsize,
    external_opens: AtomicUsize,
    link_checks: AtomicUsize,
    file_reads: AtomicUsize,
    target_opens: AtomicUsize,
    target_checks: AtomicUsize,
    removed_links: AtomicUsize,
    removed_other: AtomicUsize,
    removed_directories: AtomicUsize,
}

struct Server {
    target: LinkTarget,
    read_directories: HashSet<String>,
    calls: Arc<Calls>,
    fail_after_first_read: bool,
    cancel_after_first_read: Option<CancellationToken>,
}

impl Server {
    fn resolve(&self, path: &str) -> String {
        let mut result = path.to_owned();
        while let Some(suffix) = result.strip_prefix("/repo/current") {
            if !suffix.is_empty() && !suffix.starts_with('/') {
                break;
            }
            let target = match self.target {
                LinkTarget::Version | LinkTarget::Collision => "/repo/1468",
                LinkTarget::Root => "/repo",
                LinkTarget::Outside => "/outside",
            };
            result = format!("{target}{suffix}");
        }
        result
    }

    fn attributes(&self, path: &str) -> Result<FileAttributes, StatusCode> {
        let canonical = self.resolve(path);
        let (permissions, size) = match canonical.as_str() {
            "/repo" | "/repo/1468" | "/repo/1468/empty" | "/outside" => (0o040755, 0),
            "/repo/1468/data.txt" => (0o100644, CONTENT.len() as u64),
            "/outside/secret.txt" => (0o100644, 6),
            "/repo/a:b" => (0o100644, 5),
            "/repo/a?b" => (0o100644, 6),
            _ => return Err(StatusCode::NoSuchFile),
        };
        Ok(FileAttributes {
            permissions: Some(permissions),
            size: Some(size),
            ..FileAttributes::empty()
        })
    }

    fn mark_link_check(&self, path: &str) {
        if path == "/repo/current" {
            self.calls.link_checks.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn mark_open(&self, canonical: &str) {
        if canonical == "/repo" {
            self.calls.root_opens.fetch_add(1, Ordering::Relaxed);
        }
        if canonical == "/outside" || canonical.starts_with("/outside/") {
            self.calls.external_opens.fetch_add(1, Ordering::Relaxed);
        }
        if canonical == "/repo/1468" || canonical.starts_with("/repo/1468/") {
            self.calls.target_opens.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn mark_target_check(&self, path: &str) {
        let canonical = self.resolve(path);
        if canonical == "/repo/1468" || canonical.starts_with("/repo/1468/") {
            self.calls.target_checks.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl russh_sftp::server::Handler for Server {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.mark_link_check(&path);
        self.mark_target_check(&path);
        Ok(Attrs {
            id,
            attrs: self.attributes(&path)?,
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.mark_link_check(&path);
        if path != "/repo/current" {
            self.mark_target_check(&path);
        }
        let attrs = if path == "/repo/current" {
            FileAttributes {
                permissions: Some(0o120777),
                size: Some(4),
                ..FileAttributes::empty()
            }
        } else {
            self.attributes(&path)?
        };
        Ok(Attrs { id, attrs })
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        self.mark_link_check(&path);
        self.mark_target_check(&path);
        self.attributes(&path)?;
        Ok(Name {
            id,
            files: vec![File::dummy(self.resolve(&path))],
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let attrs = self.attributes(&path)?;
        if !attrs.file_type().is_dir() {
            return Err(StatusCode::Failure);
        }
        let canonical = self.resolve(&path);
        self.mark_open(&canonical);
        let handle = format!("d:{canonical}");
        self.read_directories.remove(&handle);
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        if !self.read_directories.insert(handle.clone()) {
            return Err(StatusCode::Eof);
        }
        let files = match handle.as_str() {
            "d:/repo" if matches!(self.target, LinkTarget::Collision) => vec![
                File::new("a:b", self.attributes("/repo/a:b")?),
                File::new("a?b", self.attributes("/repo/a?b")?),
            ],
            "d:/repo" => vec![
                File::new("1468", self.attributes("/repo/1468")?),
                File::new(
                    "current",
                    FileAttributes {
                        permissions: Some(0o120777),
                        size: Some(4),
                        ..FileAttributes::empty()
                    },
                ),
            ],
            "d:/repo/1468" => vec![
                File::new("data.txt", self.attributes("/repo/1468/data.txt")?),
                File::new("empty", self.attributes("/repo/1468/empty")?),
            ],
            "d:/repo/1468/empty" => vec![],
            "d:/outside" => vec![File::new(
                "secret.txt",
                self.attributes("/outside/secret.txt")?,
            )],
            _ => return Err(StatusCode::NoSuchFile),
        };
        if files.is_empty() {
            return Err(StatusCode::Eof);
        }
        Ok(Name { id, files })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        _flags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        self.attributes(&filename)?;
        let canonical = self.resolve(&filename);
        self.mark_open(&canonical);
        Ok(Handle {
            id,
            handle: format!("f:{canonical}"),
        })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let bytes = match handle.as_str() {
            "f:/repo/1468/data.txt" => CONTENT,
            "f:/outside/secret.txt" => b"secret",
            "f:/repo/a:b" => b"first",
            "f:/repo/a?b" => b"second",
            _ => return Err(StatusCode::Failure),
        };
        self.calls.file_reads.fetch_add(1, Ordering::Relaxed);
        if self.fail_after_first_read && offset > 0 {
            return Err(StatusCode::Failure);
        }
        let start = offset as usize;
        if start >= bytes.len() {
            return Err(StatusCode::Eof);
        }
        let end = (start + len as usize).min(bytes.len());
        let end = if self.fail_after_first_read || self.cancel_after_first_read.is_some() {
            end.min(start + 4)
        } else {
            end
        };
        if let Some(token) = &self.cancel_after_first_read {
            token.cancel();
        }
        Ok(Data {
            id,
            data: bytes[start..end].to_vec(),
        })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.read_directories.remove(&handle);
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".into(),
            language_tag: "en".into(),
        })
    }

    async fn remove(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        if path == "/repo/current" {
            self.calls.removed_links.fetch_add(1, Ordering::Relaxed);
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: "Ok".into(),
                language_tag: "en".into(),
            })
        } else {
            self.calls.removed_other.fetch_add(1, Ordering::Relaxed);
            Err(StatusCode::Failure)
        }
    }

    async fn rmdir(&mut self, _id: u32, _path: String) -> Result<Status, Self::Error> {
        self.calls
            .removed_directories
            .fetch_add(1, Ordering::Relaxed);
        Err(StatusCode::Failure)
    }
}

async fn session(target: LinkTarget) -> (SftpSession, Arc<Calls>) {
    session_with_read_behavior(target, false, None).await
}

async fn session_with_read_behavior(
    target: LinkTarget,
    fail_after_first_read: bool,
    cancel_after_first_read: Option<CancellationToken>,
) -> (SftpSession, Arc<Calls>) {
    let (client, server) = tokio::io::duplex(64 * 1024);
    let calls = Arc::new(Calls::default());
    russh_sftp::server::run(
        server,
        Server {
            target,
            read_directories: HashSet::new(),
            calls: calls.clone(),
            fail_after_first_read,
            cancel_after_first_read,
        },
    )
    .await;
    (SftpSession::new(client).await.unwrap(), calls)
}

#[tokio::test]
async fn download_follows_directory_link_inside_selected_root() {
    let (sftp, _) = session(LinkTarget::Version).await;
    let destination = tempfile::tempdir().unwrap();
    super::download_dir_streaming(
        &sftp,
        "test",
        ROOT,
        destination.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .expect("directory symlink to a sibling should download successfully");

    for name in ["1468", "current"] {
        assert_eq!(
            std::fs::read(destination.path().join(name).join("data.txt")).unwrap(),
            CONTENT
        );
        assert!(destination.path().join(name).join("empty").is_dir());
    }
}

#[tokio::test]
async fn download_rejects_directory_link_to_ancestor() {
    let (sftp, calls) = session(LinkTarget::Root).await;
    let destination = tempfile::tempdir().unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        super::download_dir_streaming(
            &sftp,
            "test",
            ROOT,
            destination.path().to_str().unwrap(),
            None,
            None,
        ),
    )
    .await
    .expect("a cyclic link must not make download loop indefinitely");
    assert!(
        result.is_err(),
        "the directory link points back to the root"
    );
    assert!(calls.link_checks.load(Ordering::Relaxed) > 0);
    assert!(
        calls.root_opens.load(Ordering::Relaxed) < 4,
        "the root must not be recursively reopened"
    );
}

#[tokio::test]
async fn download_rejects_directory_link_outside_selected_root() {
    let (sftp, calls) = session(LinkTarget::Outside).await;
    let destination = tempfile::tempdir().unwrap();
    let result = super::download_dir_streaming(
        &sftp,
        "test",
        ROOT,
        destination.path().to_str().unwrap(),
        None,
        None,
    )
    .await;
    assert!(
        result.is_err(),
        "the directory link points outside the root"
    );
    assert!(calls.link_checks.load(Ordering::Relaxed) > 0);
    assert_eq!(calls.external_opens.load(Ordering::Relaxed), 0);
    assert!(!destination
        .path()
        .join("current")
        .join("secret.txt")
        .exists());
}

#[tokio::test]
async fn download_rejects_filename_collisions_before_writing() {
    let (sftp, calls) = session(LinkTarget::Collision).await;
    let destination = tempfile::tempdir().unwrap();
    let result = super::download_dir_streaming(
        &sftp,
        "test",
        ROOT,
        destination.path().to_str().unwrap(),
        None,
        None,
    )
    .await;

    assert!(result.is_err(), "a:b and a?b both become a_b locally");
    assert_eq!(calls.file_reads.load(Ordering::Relaxed), 0);
    assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn removing_directory_link_does_not_touch_target() {
    let (sftp, calls) = session(LinkTarget::Version).await;
    crate::terminal::sftp::client::remove_remote_path(&sftp, "/repo/current", true)
        .await
        .expect("removing a directory link should remove the link only");

    assert!(calls.link_checks.load(Ordering::Relaxed) > 0);
    assert_eq!(calls.removed_links.load(Ordering::Relaxed), 1);
    assert_eq!(calls.removed_other.load(Ordering::Relaxed), 0);
    assert_eq!(calls.removed_directories.load(Ordering::Relaxed), 0);
    assert_eq!(calls.target_opens.load(Ordering::Relaxed), 0);
    assert_eq!(calls.target_checks.load(Ordering::Relaxed), 0);
    assert_eq!(calls.file_reads.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn failed_download_preserves_existing_file_after_partial_read() {
    let (sftp, calls) = session_with_read_behavior(LinkTarget::Version, true, None).await;
    let destination = tempfile::tempdir().unwrap();
    let existing = destination.path().join("data.txt");
    std::fs::write(&existing, b"original content").unwrap();

    let result = crate::terminal::sftp::client::download_file_streaming(
        &sftp,
        "/repo/1468/data.txt",
        existing.to_str().unwrap(),
        None,
        None,
        None,
    )
    .await;

    assert!(result.is_err());
    assert_eq!(calls.file_reads.load(Ordering::Relaxed), 2);
    assert_eq!(std::fs::read(&existing).unwrap(), b"original content");
    assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn cancelled_download_preserves_existing_file_after_partial_read() {
    let token = CancellationToken::new();
    let (sftp, calls) =
        session_with_read_behavior(LinkTarget::Version, false, Some(token.clone())).await;
    let destination = tempfile::tempdir().unwrap();
    let existing = destination.path().join("data.txt");
    std::fs::write(&existing, b"original content").unwrap();

    let result = crate::terminal::sftp::client::download_file_streaming(
        &sftp,
        "/repo/1468/data.txt",
        existing.to_str().unwrap(),
        None,
        Some(token),
        None,
    )
    .await;

    assert!(result.is_err());
    assert_eq!(calls.file_reads.load(Ordering::Relaxed), 1);
    assert_eq!(std::fs::read(&existing).unwrap(), b"original content");
    assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 1);
}
