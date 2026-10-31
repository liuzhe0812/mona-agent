use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{Attrs, FileAttributes, Handle, OpenFlags, Status, StatusCode};
use tokio_util::sync::CancellationToken;

use crate::terminal::sftp::client::{ensure_remote_dir, upload_file_streaming};

#[tokio::test]
async fn upload_plan_keeps_relative_paths_directories_and_sizes() {
    let source = tempfile::tempdir().unwrap();
    let docs = source.path().join("docs");
    let nested = docs.join("nested");
    std::fs::create_dir_all(nested.join("empty")).unwrap();
    std::fs::write(docs.join("a.txt"), b"abc").unwrap();
    std::fs::write(nested.join("b.txt"), b"hello").unwrap();
    let single = source.path().join("single.bin");
    std::fs::write(&single, [0u8, 1, 2, 3]).unwrap();

    let entries = super::collect_upload_entries(&[
        docs.to_string_lossy().into_owned(),
        single.to_string_lossy().into_owned(),
    ])
    .await
    .unwrap();
    let planned: BTreeMap<_, _> = entries
        .iter()
        .map(|entry| (entry.relative_path.as_str(), (entry.is_dir, entry.size)))
        .collect();
    assert_eq!(entries.len(), planned.len());
    assert_eq!(
        planned,
        BTreeMap::from([
            ("docs", (true, 0)),
            ("docs/a.txt", (false, 3)),
            ("docs/nested", (true, 0)),
            ("docs/nested/b.txt", (false, 5)),
            ("docs/nested/empty", (true, 0)),
            ("single.bin", (false, 4)),
        ])
    );
    for entry in entries {
        let expected = std::fs::canonicalize(source.path().join(&entry.relative_path)).unwrap();
        assert_eq!(entry.local_path, expected);
    }
}

#[tokio::test]
async fn upload_plan_reports_missing_source() {
    let source = tempfile::tempdir().unwrap();
    let valid = source.path().join("valid.txt");
    std::fs::write(&valid, b"data").unwrap();
    let missing = source.path().join("missing.txt");
    let result = super::collect_upload_entries(&[
        valid.to_string_lossy().into_owned(),
        missing.to_string_lossy().into_owned(),
    ])
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn upload_plan_rejects_duplicate_remote_targets() {
    let source = tempfile::tempdir().unwrap();
    let mut files = Vec::new();
    for name in ["first", "second"] {
        let directory = source.path().join(name);
        std::fs::create_dir(&directory).unwrap();
        let file = directory.join("report.txt");
        std::fs::write(&file, name).unwrap();
        files.push(file.to_string_lossy().into_owned());
    }
    assert!(super::collect_upload_entries(&files).await.is_err());
}

#[derive(Default)]
struct RemoteState {
    directories: HashSet<String>,
    files: HashMap<String, Vec<u8>>,
    mkdir_calls: Vec<String>,
    open_calls: Vec<String>,
}

struct Server {
    state: Arc<Mutex<RemoteState>>,
}

fn attributes(mode: u32, size: usize) -> FileAttributes {
    FileAttributes {
        permissions: Some(mode),
        size: Some(size as u64),
        ..FileAttributes::empty()
    }
}

fn success(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".into(),
        language_tag: "en".into(),
    }
}

fn parent(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some(("", _)) | None => "/",
        Some((directory, _)) => directory,
    }
}

impl russh_sftp::server::Handler for Server {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let state = self.state.lock().unwrap();
        let attrs = if state.directories.contains(&path) {
            attributes(0o040755, 0)
        } else if let Some(data) = state.files.get(&path) {
            attributes(0o100644, data.len())
        } else {
            return Err(StatusCode::NoSuchFile);
        };
        Ok(Attrs { id, attrs })
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let mut state = self.state.lock().unwrap();
        state.mkdir_calls.push(path.clone());
        if state.directories.contains(&path)
            || state.files.contains_key(&path)
            || !state.directories.contains(parent(&path))
        {
            return Err(StatusCode::Failure);
        }
        state.directories.insert(path);
        Ok(success(id))
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let mut state = self.state.lock().unwrap();
        state.open_calls.push(filename.clone());
        if !flags.contains(OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
            || !state.directories.contains(parent(&filename))
        {
            return Err(StatusCode::Failure);
        }
        state.files.insert(filename.clone(), Vec::new());
        Ok(Handle {
            id,
            handle: filename,
        })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let mut state = self.state.lock().unwrap();
        let file = state.files.get_mut(&handle).ok_or(StatusCode::NoSuchFile)?;
        let start = offset as usize;
        let end = start + data.len();
        file.resize(file.len().max(end), 0);
        file[start..end].copy_from_slice(&data);
        Ok(success(id))
    }

    async fn close(&mut self, id: u32, _handle: String) -> Result<Status, Self::Error> {
        Ok(success(id))
    }
}

async fn session() -> (SftpSession, Arc<Mutex<RemoteState>>) {
    let (client, server) = tokio::io::duplex(64 * 1024);
    let state = Arc::new(Mutex::new(RemoteState::default()));
    state.lock().unwrap().directories.insert("/".into());
    russh_sftp::server::run(
        server,
        Server {
            state: state.clone(),
        },
    )
    .await;
    (SftpSession::new(client).await.unwrap(), state)
}

#[tokio::test]
async fn mkdir_failure_only_accepts_an_existing_directory() {
    let (sftp, state) = session().await;
    {
        let mut state = state.lock().unwrap();
        state.directories.insert("/existing-dir".into());
        state
            .files
            .insert("/existing-file".into(), b"data".to_vec());
    }

    assert!(ensure_remote_dir(&sftp, "/existing-dir").await.is_ok());
    assert!(ensure_remote_dir(&sftp, "/existing-file").await.is_err());
}

#[tokio::test]
async fn streaming_upload_creates_missing_parents_and_new_file() {
    let (sftp, state) = session().await;
    let source = tempfile::tempdir().unwrap();
    let file = source.path().join("local.txt");
    std::fs::write(&file, b"upload content").unwrap();

    upload_file_streaming(
        &sftp,
        file.to_str().unwrap(),
        "/new/deep/data.txt",
        None,
        None,
        None,
    )
    .await
    .expect("new parents and file should be created");

    let state = state.lock().unwrap();
    assert!(state.directories.contains("/new"));
    assert!(state.directories.contains("/new/deep"));
    assert_eq!(
        state.files.get("/new/deep/data.txt").unwrap().as_slice(),
        b"upload content"
    );
}

#[tokio::test]
async fn already_cancelled_upload_creates_nothing() {
    let (sftp, state) = session().await;
    let source = tempfile::tempdir().unwrap();
    let file = source.path().join("local.txt");
    std::fs::write(&file, b"upload content").unwrap();
    let token = CancellationToken::new();
    token.cancel();

    let result = upload_file_streaming(
        &sftp,
        file.to_str().unwrap(),
        "/new/deep/data.txt",
        None,
        Some(token),
        None,
    )
    .await;

    assert!(result.is_err());
    let state = state.lock().unwrap();
    assert!(state.mkdir_calls.is_empty());
    assert!(state.open_calls.is_empty());
    assert!(state.files.is_empty());
}
