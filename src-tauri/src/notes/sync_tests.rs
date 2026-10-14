use super::*;

fn data(content: &str) -> Value {
    json!({"notebook": "课程", "title": "第一课", "content": content,
        "created_at": "2026-10-13T00:00:00Z", "updated_at": "2026-10-13T00:00:00Z",
        "note_type": "note", "aliases": ["入门"], "favorite": true, "assets": []})
}

fn write_original(root: &Path, id: &str, title: &str, content: &str) -> PathBuf {
    fs::create_dir_all(root.join("课程")).unwrap();
    let path = root.join("课程").join(format!("{title}.md"));
    fs::write(&path, format!("---\nid: {id}\ntitle: {title}\ncontextLevel: none\nagentChatId: local-only\ncreatedAt: 2026-10-13T00:00:00Z\nupdatedAt: 2026-10-13T00:00:00Z\n---\n\n{content}")).unwrap();
    path
}

#[test]
fn portable_roundtrip_retains_body_but_no_local_authority() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    write_original(a.path(), "note-one", "第一课", "# 标题\n\n原始正文\n");
    let index = request_at(a.path(), &json!({"action": "index"})).unwrap();
    let row = &index["items"][0];
    let read = request_at(a.path(), &json!({"action": "read", "vault": index["vault"], "note_id": row["id"], "expected": row["fingerprint"]})).unwrap();
    assert_eq!(read["data"]["content"], "# 标题\n\n原始正文\n");
    assert!(!read.to_string().contains("local-only"));
    assert!(!read.to_string().contains("contextLevel"));
    assert!(apply(b.path(), "imported", &fingerprint(&Value::Null), &read["data"]).unwrap()["applied"].as_bool().unwrap());
    let (_, imported) = scan(b.path()).unwrap().remove("imported").unwrap();
    assert_eq!(projection(b.path(), &imported).unwrap().0, read["data"]);
    assert!(imported.agent_chat_id.is_none());
    assert!(apply(b.path(), "imported", &fingerprint(&Value::Null), &read["data"]).unwrap()["reused"].as_bool().unwrap());
}

#[test]
fn remote_image_titles_are_not_local_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let content = "![图片](https://example.invalid/login.png \"assets/login_page.png\")\n![图片](https://example.invalid/login.png 'assets/login_page.png')";
    write_original(dir.path(), "one", "第一课", content);
    let index = request_at(dir.path(), &json!({"action":"index"})).unwrap();
    assert_eq!(index["items"].as_array().unwrap().len(), 1);
    let row = &index["items"][0];
    let read = request_at(dir.path(), &json!({"action":"read","vault":index["vault"],
        "note_id":row["id"],"expected":row["fingerprint"]})).unwrap();
    assert_eq!(read["data"]["content"], content);
    assert_eq!(read["data"]["assets"], json!([]));
}

#[test]
fn local_markdown_wiki_and_html_destinations_remain_attachments() {
    for content in ["![图片](assets/local.png)", "[附件](../assets/local.png)",
                    "![[assets/local.png]]", "<img src=\"assets/local.png\">",
                    "<IMG SRC = 'assets/local.png'>", "<a href=\"assets/local.png\">附件</a>"] {
        assert_eq!(asset_references(content).unwrap(), HashMap::from([("local.png".into(), "local.png".into())]));
    }
    let dir = tempfile::tempdir().unwrap();
    write_original(dir.path(), "one", "第一课", "![图片](assets/missing.png)");
    assert!(request_at(dir.path(), &json!({"action":"index"})).is_err());
}

#[test]
fn file_revisions_prevent_stale_ui_saves_and_accept_own_confirmed_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_original(dir.path(), "one", "第一课", "original");
    let mut original = parse_note_file(&path, "课程").unwrap();
    let files = HashMap::from([("one".into(), path.clone())]);
    original.content_markdown = "local edit".into();
    assert!(check_local_revisions(&[original.clone()], &files).is_ok());
    fs::write(&path, "remote edit").unwrap();
    assert!(check_local_revisions(&[original.clone()], &files).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "remote edit");
    original.storage_revision = Some(file_revision(&path).unwrap());
    assert!(check_local_revisions(&[original], &files).is_ok());
}

#[test]
fn concurrent_remote_note_does_not_overwrite_local_edit_or_delete_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_original(dir.path(), "one", "第一课", "original");
    let (_, original) = scan(dir.path()).unwrap().remove("one").unwrap();
    let before = fingerprint(&projection(dir.path(), &original).unwrap().0);
    fs::write(&path, fs::read_to_string(&path).unwrap().replace("original", "local changed")).unwrap();
    assert!(apply(dir.path(), "one", &before, &data("remote changed")).is_err());
    assert!(apply(dir.path(), "one", &before, &Value::Null).is_err());
    assert!(fs::read_to_string(path).unwrap().contains("local changed"));
}

#[test]
fn batch_delete_rejects_a_remote_change_before_deleting_any_selected_note() {
    let dir = tempfile::tempdir().unwrap();
    let one = write_original(dir.path(), "one", "A", "first");
    let two = write_original(dir.path(), "two", "B", "second");
    let ids = vec!["one".into(), "two".into()];
    let mut expected = HashMap::from([
        ("one".into(), Some(file_revision(&one).unwrap())),
        ("two".into(), Some(file_revision(&two).unwrap())),
    ]);
    fs::write(&two, fs::read_to_string(&two).unwrap().replace("second", "new remote edit")).unwrap();
    assert!(super::super::delete_note_files(dir.path(), &ids, &expected).is_err());
    assert!(one.is_file());
    assert!(fs::read_to_string(&two).unwrap().contains("new remote edit"));
    expected.insert("two".into(), Some(file_revision(&two).unwrap()));
    super::super::delete_note_files(dir.path(), &ids, &expected).unwrap();
    assert!(!one.exists() && !two.exists());
    super::super::delete_note_files(dir.path(), &ids, &expected).unwrap();
}

#[test]
fn deleting_an_unsaved_note_cannot_delete_a_new_file_with_the_same_id() {
    let dir = tempfile::tempdir().unwrap();
    let ids = vec!["one".into()];
    let expected = HashMap::from([("one".into(), None)]);
    super::super::delete_note_files(dir.path(), &ids, &expected).unwrap();
    let path = write_original(dir.path(), "one", "A", "created after old view");
    assert!(super::super::delete_note_files(dir.path(), &ids, &expected).is_err());
    assert!(path.is_file());
    assert!(super::super::delete_note_files(dir.path(), &ids, &HashMap::new()).is_err());
}

#[test]
fn attachments_stream_verified_bytes_then_allow_note_publication() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = vec![17u8; CHUNK as usize + 3];
    let hash = hex::encode(Sha256::digest(&bytes));
    let name = format!("cloud-{hash}.png");
    let value = json!({"name": name, "sha256": hash, "size": bytes.len(), "offset": 0,
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes[..CHUNK as usize])});
    assert_eq!(asset_write(dir.path(), &value).unwrap()["complete"], false);
    assert_eq!(asset_write(dir.path(), &value).unwrap()["complete"], false);
    let mut note = data(&format!("![图](assets/{name})"));
    note["assets"] = json!([{"name": name, "sha256": hash, "size": bytes.len()}]);
    assert!(apply(dir.path(), "one", &fingerprint(&Value::Null), &note).is_err());
    let last = json!({"offset": CHUNK, "data": base64::engine::general_purpose::STANDARD.encode(&bytes[CHUNK as usize..]),
        "name": name, "sha256": hash, "size": bytes.len()});
    assert_eq!(asset_write(dir.path(), &last).unwrap()["complete"], true);
    assert_eq!(fs::read(dir.path().join("assets").join(&name)).unwrap(), bytes);
    assert_eq!(apply(dir.path(), "one", &fingerprint(&Value::Null), &note).unwrap()["applied"], true);
    let (_, read) = scan(dir.path()).unwrap().remove("one").unwrap();
    assert_eq!(projection(dir.path(), &read).unwrap().0, note);
}

#[test]
fn malformed_and_missing_attachments_never_publish_an_incomplete_note() {
    let dir = tempfile::tempdir().unwrap();
    write_original(dir.path(), "one", "第一课", "![图](assets/missing.png)");
    assert!(request_at(dir.path(), &json!({"action": "index"})).is_err());
    let hash = "a".repeat(64);
    let request = json!({"name": format!("cloud-{hash}.png"), "sha256": hash,
        "size": 3, "offset": 0, "data": "YWJj"});
    assert!(asset_write(dir.path(), &request).is_err());
    assert!(!dir.path().join("assets").join(format!("cloud-{hash}.png")).exists());
    assert!(fs::read_to_string(dir.path().join("课程/第一课.md")).unwrap().contains("missing.png"));
}

#[test]
fn foreign_vault_invalid_paths_and_extra_authority_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    assert!(request_at(dir.path(), &json!({"action": "apply", "vault": "other"})).is_err());
    for name in ["../outside", "/absolute", "C:\\escape", ".mona", "assets", "sessions", "CON"] {
        let mut note = data("body"); note["notebook"] = json!(name);
        assert!(apply(dir.path(), "id", &fingerprint(&Value::Null), &note).is_err(), "{name}");
    }
    let mut value = data("body"); value["permissions"] = json!("all");
    assert!(apply(dir.path(), "id", &fingerprint(&Value::Null), &value).is_err());
}

#[test]
fn duplicate_note_ids_fail_without_sending_a_partial_inventory() {
    let dir = tempfile::tempdir().unwrap();
    write_original(dir.path(), "one", "A", "first");
    write_original(dir.path(), "one", "B", "second");
    assert!(request_at(dir.path(), &json!({"action": "index"})).is_err());
    assert_eq!(fs::read_dir(dir.path().join("课程")).unwrap().count(), 2);
}

#[test]
fn metadata_split_preserves_body_whitespace_and_line_endings() {
    for body in ["", "\n\n# Heading\n\n", "text  \r\n\r\n", "text without final newline", "\n"] {
        let dir = tempfile::tempdir().unwrap();
        let value = data(body);
        apply(dir.path(), "one", &fingerprint(&Value::Null), &value).unwrap();
        let (_, read) = scan(dir.path()).unwrap().remove("one").unwrap();
        assert_eq!(read.content_markdown, body);
        assert_eq!(projection(dir.path(), &read).unwrap().0, value);
    }
    assert_eq!(split_frontmatter("---\r\nid: x\r\n---\r\n\r\n\r\nbody\r\n").1, "\r\nbody\r\n");
}

#[test]
fn ui_save_token_is_bound_to_the_loaded_vault() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let token = root_token(&a.path().canonicalize().unwrap());
    assert!(check_vault_token(a.path(), Some(&token)).is_ok());
    assert!(check_vault_token(b.path(), Some(&token)).is_err());
    assert!(check_vault_token(b.path(), None).is_err());
    assert_eq!(fs::read_dir(b.path()).unwrap().count(), 0);
}

#[test]
fn invalid_staged_attachment_can_be_retried_without_overwriting_user_files() {
    let dir = tempfile::tempdir().unwrap();
    let hash = hex::encode(Sha256::digest(b"correct"));
    let name = format!("cloud-{hash}.png");
    let mut args = json!({"name": name, "sha256": hash, "size": 7, "offset": 0,
        "data": base64::engine::general_purpose::STANDARD.encode(b"corrupt")});
    assert!(asset_write(dir.path(), &args).is_err());
    assert!(!dir.path().join(".mona/cloud-staging").join(&hash).exists());
    args["data"] = json!(base64::engine::general_purpose::STANDARD.encode(b"correct"));
    assert_eq!(asset_write(dir.path(), &args).unwrap()["complete"], true);
    assert_eq!(fs::read(dir.path().join("assets").join(&name)).unwrap(), b"correct");
}

#[test]
fn native_json_matches_the_cross_language_canonical_contract() {
    let value = data("body");
    let canonical_json = "{\"aliases\":[\"入门\"],\"assets\":[],\"content\":\"body\",\"created_at\":\"2026-10-13T00:00:00Z\",\"favorite\":true,\"note_type\":\"note\",\"notebook\":\"课程\",\"title\":\"第一课\",\"updated_at\":\"2026-10-13T00:00:00Z\"}";
    assert_eq!(serde_json::to_string(&canonical(value.clone())).unwrap(), canonical_json);
    assert_eq!(fingerprint(&value), hex::encode(Sha256::digest(canonical_json.as_bytes())));
}
