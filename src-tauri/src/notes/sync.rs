//! Portable note data stays under the native Notes owner's path and write lock.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use serde_json::json;

const MAX_NOTE: u64 = 2 * 1024 * 1024;
const MAX_ASSET: u64 = 10 * 1024 * 1024;
const CHUNK: u64 = 256 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Asset { name: String, sha256: String, size: u64 }

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PortableNote {
    notebook: String,
    title: String,
    content: String,
    created_at: String,
    updated_at: String,
    note_type: String,
    aliases: Vec<String>,
    favorite: bool,
    assets: Vec<Asset>,
}

pub(super) fn file_revision(path: &Path) -> Result<String, String> {
    fs::read(path).map(|bytes| hex::encode(Sha256::digest(bytes)))
        .map_err(|_| "笔记文件暂时无法读取，请稍后重试。".into())
}

fn hex_id(value: &str, size: usize) -> bool {
    value.len() == size && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn component(value: &str) -> bool {
    !value.is_empty() && value.len() <= 240 && value != "." && value != ".."
        && !value.ends_with(['.', ' ']) && !value.starts_with('.')
        && !value.chars().any(|c| c.is_control() || "/\\<>:\"|?*".contains(c))
        && !matches!(value.split('.').next().unwrap_or("").to_uppercase().as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9" |
            "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9")
}

fn linked(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() { return true; }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}

fn checked(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let base = root.canonicalize().map_err(|_| "笔记仓库尚未就绪。")?;
    let mut path = base.clone();
    for part in relative.components() {
        let std::path::Component::Normal(name) = part else { return Err("笔记路径无效。".into()); };
        path.push(name);
        let info = fs::symlink_metadata(&path).map_err(|_| "关联笔记或附件缺失，未同步不完整内容。")?;
        if linked(&info) { return Err("笔记或附件包含链接，未自动同步。".into()); }
    }
    if !path.canonicalize().map_err(|_| "笔记路径无法核对。")?.starts_with(&base) {
        return Err("笔记文件不属于当前仓库。".into());
    }
    Ok(path)
}

fn ensure_dir(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut current = PathBuf::new();
    for part in relative.components() {
        let std::path::Component::Normal(name) = part else { return Err("笔记目录无效。".into()); };
        current.push(name);
        let path = root.join(&current);
        if !path.exists() { fs::create_dir(&path).map_err(|_| "笔记目录无法创建。")?; }
        checked(root, &current)?;
    }
    Ok(root.join(relative))
}

pub(super) fn check_local_revisions(notes: &[OperationNote], files: &HashMap<String, PathBuf>) -> Result<(), String> {
    for note in notes {
        if let Some(path) = files.get(&note.id) {
            let actual = file_revision(path)?;
            if note.storage_revision.as_deref() != Some(&actual)
                && fs::read_to_string(path).ok().as_deref() != Some(&serialize_note_to_file(note)) {
                return Err("笔记已在其他窗口或设备更新，请刷新后保留并合并当前修改。".into());
            }
        } else if note.storage_revision.is_some() {
            return Err("笔记已被删除或移动，请刷新后保留当前修改。".into());
        }
    }
    Ok(())
}

pub(super) fn check_delete_revisions(
    root: &Path, ids: &[String], expected: &HashMap<String, Option<String>>,
    files: &HashMap<String, PathBuf>,
) -> Result<(), String> {
    let unique: HashSet<_> = ids.iter().collect();
    if ids.len() > 10_000 || unique.len() != ids.len() || expected.len() != ids.len()
        || ids.iter().any(|id| id.is_empty() || id.len() > 512 || id.chars().any(char::is_control)
            || !expected.contains_key(id)) {
        return Err("删除范围无效，请重新选择笔记。".into());
    }
    for id in ids {
        if expected[id].as_deref().is_some_and(|value| !hex_id(value, 64)) {
            return Err("笔记版本无效，请刷新后重试删除。".into());
        }
        if let Some(path) = files.get(id) {
            let relative = path.strip_prefix(root).map_err(|_| "笔记不属于当前仓库。")?;
            let current = file_revision(&checked(root, relative)?)?;
            if expected[id].as_deref() != Some(current.as_str()) {
                return Err("笔记已在其他窗口或设备更新，未删除任何选中笔记；请刷新后重新确认。".into());
            }
        }
    }
    Ok(())
}

fn read_bytes(root: &Path, relative: &Path, max: u64) -> Result<Vec<u8>, String> {
    let path = checked(root, relative)?;
    let info = fs::metadata(&path).map_err(|_| "笔记文件无法读取。")?;
    if !info.is_file() || info.len() > max { return Err("笔记或附件超过单项同步大小，原文未截断。".into()); }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|_| "笔记文件无法读取。")?.take(max + 1).read_to_end(&mut bytes)
        .map_err(|_| "笔记文件读取未完成。")?;
    if bytes.len() as u64 > max { return Err("笔记文件在读取时发生变化，请重试。".into()); }
    Ok(bytes)
}

fn canonical(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted: std::collections::BTreeMap<_, _> = object.into_iter().collect();
            Value::Object(sorted.into_iter().map(|(k, v)| (k, canonical(v))).collect())
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        other => other,
    }
}

fn fingerprint(value: &Value) -> String {
    hex::encode(Sha256::digest(serde_json::to_vec(&canonical(value.clone())).unwrap()))
}

fn asset_name(hash: &str, source: &str) -> Result<String, String> {
    let ext = source.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !component(source) || ext.is_empty() || ext.len() > 12 || !ext.bytes().all(|b| b.is_ascii_alphanumeric())
        || matches!(ext.as_str(), "pem" | "key" | "p12" | "pfx" | "env") {
        return Err("附件文件名或类型不在同步范围内。".into());
    }
    Ok(format!("cloud-{hash}.{ext}"))
}

fn asset_references(markdown: &str) -> Result<HashMap<String, String>, String> {
    let mut refs = HashMap::new();
    for (start, _) in markdown.match_indices("assets/") {
        let head = &markdown[..start];
        let html_target = head.ends_with(['\"', '\''])
            && head[..head.len() - 1].trim_end().strip_suffix('=')
                .and_then(|prefix| prefix.split_whitespace().next_back())
                .is_some_and(|attribute| attribute.eq_ignore_ascii_case("src") || attribute.eq_ignore_ascii_case("href"));
        if !head.ends_with('(') && !head.ends_with("(../") && !head.ends_with("(./") && !head.ends_with("[[") && !html_target { continue; }
        let raw = markdown[start + 7..].split([')', '\"', '\'', ']', '<', '>', '\r', '\n']).next().unwrap_or("").trim();
        let mut bytes = Vec::new();
        let mut source = raw.as_bytes().iter().copied();
        while let Some(byte) = source.next() {
            if byte == b'%' {
                let a = source.next().and_then(|b| (b as char).to_digit(16)).ok_or("附件链接编码无效。")?;
                let b = source.next().and_then(|b| (b as char).to_digit(16)).ok_or("附件链接编码无效。")?;
                bytes.push((a * 16 + b) as u8);
            } else { bytes.push(byte); }
        }
        let name = String::from_utf8(bytes).map_err(|_| "附件链接编码无效。")?;
        if !component(&name) { return Err("附件链接超出笔记资源范围。".into()); }
        refs.insert(raw.to_string(), name);
    }
    Ok(refs)
}

fn projection(root: &Path, note: &OperationNote) -> Result<(Value, HashMap<String, String>), String> {
    let refs = asset_references(&note.content_markdown)?;
    if refs.len() > 128 { return Err("单篇笔记关联附件过多，未截断内容。".into()); }
    let mut sources = HashMap::new();
    let mut content = note.content_markdown.clone();
    let mut assets = Vec::new();
    let mut names: Vec<_> = refs.into_iter().collect();
    names.sort_by_key(|(literal, _)| std::cmp::Reverse(literal.len()));
    for (literal, source) in names {
        if !component(&source) { return Err("笔记附件路径无效。".into()); }
        let bytes = read_bytes(root, &Path::new("assets").join(&source), MAX_ASSET)?;
        let hash = hex::encode(Sha256::digest(&bytes));
        let name = asset_name(&hash, &source)?;
        content = content.replace(&format!("assets/{literal}"), &format!("assets/{name}"));
        if !sources.contains_key(&name) {
            assets.push(Asset { name: name.clone(), sha256: hash, size: bytes.len() as u64 });
            sources.insert(name, source);
        }
    }
    assets.sort_by(|a, b| a.name.cmp(&b.name));
    let data = PortableNote { notebook: note.notebook_id.clone(), title: note.title.clone(),
        content, created_at: note.created_at.clone(), updated_at: note.updated_at.clone(),
        note_type: note.note_type.clone(), aliases: note.aliases.clone(), favorite: note.favorite, assets };
    validate(&data)?;
    Ok((serde_json::to_value(data).map_err(|_| "笔记数据无法编码。")?, sources))
}

fn validate(data: &PortableNote) -> Result<(), String> {
    if (!data.notebook.is_empty() && (!component(&data.notebook) || !is_notebook_folder(&data.notebook)))
        || data.title.is_empty() || data.title.len() > 4096 || data.title.chars().any(char::is_control)
        || data.content.len() as u64 > MAX_NOTE || data.assets.len() > 128 || data.aliases.len() > 100
        || data.aliases.iter().any(|a| a.len() > 1024 || a.chars().any(char::is_control))
        || data.created_at.len() > 64 || data.updated_at.len() > 64
        || data.created_at.chars().any(char::is_control) || data.updated_at.chars().any(char::is_control)
        || !matches!(data.note_type.as_str(), "note" | "moc" | "daily" | "template" | "agent-experience" | "flowchart" | "mindmap" | "diagram") {
        return Err("笔记同步内容格式无效，未改动本地笔记。".into());
    }
    let mut names = HashSet::new();
    for asset in &data.assets {
        if !hex_id(&asset.sha256, 64) || asset.size > MAX_ASSET || !names.insert(asset.name.clone())
            || asset_name(&asset.sha256, &asset.name)? != asset.name {
            return Err("笔记附件描述无效。".into());
        }
    }
    let refs: HashSet<_> = asset_references(&data.content)?.into_values().collect();
    if refs != names { return Err("笔记附件尚未全部包含，未保存不完整内容。".into()); }
    Ok(())
}

fn scan(root: &Path) -> Result<HashMap<String, (PathBuf, OperationNote)>, String> {
    let mut folders = vec![PathBuf::new()];
    for entry in fs::read_dir(root).map_err(|_| "笔记仓库无法读取，未将其视为空仓库。")? {
        let entry = entry.map_err(|_| "笔记目录读取未完成。")?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_notebook_folder(&name) && linked(&fs::symlink_metadata(entry.path()).map_err(|_| "笔记目录状态无法核对。")?) {
            return Err("笔记分类包含链接，未将其作为空分类同步。".into());
        }
        if is_notebook_folder(&name) && entry.path().is_dir() {
            checked(root, Path::new(&name))?;
            folders.push(PathBuf::from(name));
        }
    }
    let mut notes = HashMap::new();
    let mut total = 0usize;
    for folder in folders {
        for entry in fs::read_dir(root.join(&folder)).map_err(|_| "笔记分类无法读取。")? {
            let entry = entry.map_err(|_| "笔记列表读取未完成。")?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("md") { continue; }
            let relative = folder.join(entry.file_name());
            let bytes = read_bytes(root, &relative, MAX_NOTE + 65536)?;
            total += bytes.len();
            if notes.len() >= 10_000 || total > 64 * 1024 * 1024 { return Err("笔记仓库超过本轮扫描大小，未遗漏原文。".into()); }
            let note = parse_note_file(&root.join(&relative), folder.to_str().ok_or("笔记分类名无效。")?)?;
            if note.storage_revision.as_deref() != Some(hex::encode(Sha256::digest(&bytes)).as_str()) {
                return Err("笔记在读取时发生变化，请稍后重试。".into());
            }
            if note.id.is_empty() || note.id.len() > 512 || note.id.chars().any(char::is_control)
                || notes.insert(note.id.clone(), (relative, note)).is_some() {
                return Err("笔记存在重复或无效标识，请先核对仓库。".into());
            }
        }
    }
    Ok(notes)
}

pub(super) fn root_token(root: &Path) -> String {
    hex::encode(Sha256::digest(root.to_string_lossy().as_bytes()))
}

pub(super) fn check_vault_token(root: &Path, expected: Option<&str>) -> Result<(), String> {
    let root = root.canonicalize().map_err(|_| "笔记仓库无法核对，请重新打开。")?;
    if expected != Some(root_token(&root).as_str()) {
        return Err("笔记仓库已变化，请重新打开仓库；未将旧编辑写入其他位置。".into());
    }
    Ok(())
}

fn atomic_note(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("笔记保存目录无效。")?)
        .map_err(|_| "无法暂存笔记。")?;
    file.write_all(bytes).and_then(|_| file.as_file().sync_all()).map_err(|_| "笔记写入未完成。")?;
    file.persist(path).map_err(|_| "笔记保存未完成，原内容已保留。")?;
    Ok(())
}

fn apply(root: &Path, id: &str, expected: &str, value: &Value) -> Result<Value, String> {
    if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) || !hex_id(expected, 64) {
        return Err("笔记同步目标无效。".into());
    }
    let data: Option<PortableNote> = serde_json::from_value(value.clone()).map_err(|_| "笔记内容格式无效。")?;
    if let Some(data) = &data { validate(data)?; }
    let mut notes = scan(root)?;
    let existing = notes.remove(id);
    let before = existing.as_ref().map(|(_, n)| projection(root, n).map(|p| p.0)).transpose()?.unwrap_or(Value::Null);
    if before == *value { return Ok(json!({"applied": true, "reused": true})); }
    if fingerprint(&before) != expected { return Err("本地笔记已变化，已保留修改并等待重新同步。".into()); }
    let Some(data) = data else {
        if let Some((path, _)) = existing { fs::remove_file(root.join(path)).map_err(|_| "笔记删除未完成。")?; }
        return Ok(json!({"applied": true, "reused": false}));
    };
    for asset in &data.assets {
        let bytes = read_bytes(root, &Path::new("assets").join(&asset.name), MAX_ASSET)?;
        if bytes.len() as u64 != asset.size || hex::encode(Sha256::digest(bytes)) != asset.sha256 {
            return Err("笔记附件校验失败，未保存不完整笔记。".into());
        }
    }
    let mut note = existing.as_ref().map(|(_, n)| n.clone()).unwrap_or_else(|| OperationNote {
        id: id.into(), notebook_id: String::new(), title: String::new(), preview: String::new(),
        created_at: String::new(), updated_at: String::new(), source: NoteSource { kind: "manual".into(), label: "同步笔记".into() },
        content_markdown: String::new(), content_json: None, plain_text: None, agent_chat_id: None,
        origin_chat_id: None, applied_agent_message_ids: vec![], context_level: default_context_level(),
        note_type: default_note_type(), aliases: vec![], favorite: false, storage_revision: None,
    });
    note.notebook_id = data.notebook;
    note.title = data.title;
    note.content_markdown = data.content;
    note.created_at = data.created_at;
    note.updated_at = data.updated_at;
    note.note_type = data.note_type;
    note.aliases = data.aliases;
    note.favorite = data.favorite;
    note.content_json = None;
    let folder = root.join(&note.notebook_id);
    if !folder.exists() { fs::create_dir(&folder).map_err(|_| "无法创建笔记分类。")?; }
    if !note.notebook_id.is_empty() { checked(root, Path::new(&note.notebook_id))?; }
    let target = match &existing {
        Some((path, _)) if path.parent() == Some(Path::new(&note.notebook_id)) => root.join(path),
        _ => folder.join(format!("{}_{}.md", sanitize_filename(&note.title), &hex::encode(Sha256::digest(id.as_bytes()))[..12])),
    };
    if target.exists() && existing.as_ref().map(|(p, _)| root.join(p)) != Some(target.clone()) {
        return Err("笔记保存位置已被占用，未覆盖其他笔记。".into());
    }
    let bytes = serialize_note_to_file(&note);
    if let Some((old, _)) = &existing {
        if root.join(old) != target {
            fs::rename(root.join(old), &target).map_err(|_| "笔记分类移动未完成。")?;
        }
    }
    atomic_note(&target, bytes.as_bytes())?;
    Ok(json!({"applied": true, "reused": false}))
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args[key].as_str().ok_or_else(|| "笔记同步参数缺失。".into())
}

fn asset_write(root: &Path, args: &Value) -> Result<Value, String> {
    let name = text(args, "name")?;
    let hash = text(args, "sha256")?;
    let total = args["size"].as_u64().filter(|n| *n <= MAX_ASSET).ok_or("附件大小无效。")?;
    let offset = args["offset"].as_u64().filter(|n| *n <= total).ok_or("附件偏移无效。")?;
    if !hex_id(hash, 64) || asset_name(hash, name)? != name { return Err("附件标识无效。".into()); }
    let encoded = text(args, "data")?;
    if encoded.len() as u64 > CHUNK * 4 / 3 + 8 { return Err("附件分片过大。".into()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "附件分片无效。")?;
    if bytes.len() as u64 > CHUNK || offset + bytes.len() as u64 > total { return Err("附件分片大小无效。".into()); }
    let assets = ensure_dir(root, Path::new("assets"))?;
    let target = assets.join(name);
    if target.exists() {
        let existing = read_bytes(root, &Path::new("assets").join(name), MAX_ASSET)?;
        if existing.len() as u64 != total || hex::encode(Sha256::digest(existing)) != hash { return Err("本地同名附件已改变，未覆盖。".into()); }
        return Ok(json!({"received": total, "complete": true}));
    }
    let stage_dir = ensure_dir(root, Path::new(".mona/cloud-staging"))?;
    let stage = stage_dir.join(hash);
    if stage.exists() { checked(root, &Path::new(".mona/cloud-staging").join(hash))?; }
    let mut file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&stage)
        .map_err(|_| "附件暂存无法打开。")?;
    let length = file.metadata().map_err(|_| "附件暂存状态无法读取。")?.len();
    if length > total || offset > length { return Err("附件分片顺序已变化，请重新同步。".into()); }
    file.seek(SeekFrom::Start(offset)).map_err(|_| "附件偏移无法定位。")?;
    if offset < length {
        let mut previous = vec![0; bytes.len()];
        file.read_exact(&mut previous).map_err(|_| "附件重试范围无效。")?;
        if previous != bytes { return Err("附件重试内容不同，未覆盖。".into()); }
    } else {
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "附件分片未保存。")?;
    }
    let received = file.metadata().map_err(|_| "附件状态无法读取。")?.len();
    drop(file);
    if received == total {
        let all = read_bytes(root, &Path::new(".mona/cloud-staging").join(hash), MAX_ASSET)?;
        if hex::encode(Sha256::digest(all)) != hash {
            fs::remove_file(&stage).map_err(|_| "损坏的附件暂存无法清理，请稍后重试。")?;
            return Err("附件内容校验失败，原有文件保持不变，请重试下载。".into());
        }
        fs::rename(&stage, &target).map_err(|_| "附件保存未完成。")?;
    }
    Ok(json!({"received": received, "complete": received == total}))
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;

pub(crate) fn request(args: &Value) -> Result<Value, String> {
    let _guard = super::STORE_LOCK.lock().map_err(|_| "笔记存储正在恢复，请重试。")?;
    let root = read_vault_path().ok_or("请先在笔记中选择本机笔记仓库。")?.canonicalize()
        .map_err(|_| "笔记仓库不可用，未将其视为空仓库。")?;
    request_at(&root, args)
}

fn request_at(root: &Path, args: &Value) -> Result<Value, String> {
    let token = root_token(root);
    let action = text(args, "action")?;
    if action != "index" && args["vault"].as_str() != Some(&token) { return Err("笔记仓库已变化，请重新确认同步范围。".into()); }
    match action {
        "index" => {
            let mut items = Vec::new();
            for (id, (_, note)) in scan(root)? {
                let (data, _) = projection(root, &note)?;
                items.push(json!({"id": id, "fingerprint": fingerprint(&data)}));
            }
            items.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
            Ok(json!({"vault": token, "items": items}))
        }
        "read" | "asset_read" => {
            let id = text(args, "note_id")?;
            let notes = scan(root)?;
            let (_, note) = notes.get(id).ok_or("笔记已删除，请重新同步。")?;
            let (data, sources) = projection(root, note)?;
            if args["expected"].as_str() != Some(fingerprint(&data).as_str()) { return Err("笔记已变化，请重新同步。".into()); }
            if action == "read" { return Ok(json!({"data": data, "fingerprint": fingerprint(&data)})); }
            let name = text(args, "name")?;
            let source = sources.get(name).ok_or("该附件不属于已确认的笔记。")?;
            let bytes = read_bytes(root, &Path::new("assets").join(source), MAX_ASSET)?;
            let offset = args["offset"].as_u64().filter(|n| *n <= bytes.len() as u64).ok_or("附件读取位置无效。")? as usize;
            let end = (offset + CHUNK as usize).min(bytes.len());
            Ok(json!({"data": base64::engine::general_purpose::STANDARD.encode(&bytes[offset..end]), "next": end, "complete": end == bytes.len()}))
        }
        "asset_write" => asset_write(root, args),
        "apply" => apply(root, text(args, "note_id")?, text(args, "expected")?, &args["data"]),
        _ => Err("不支持的笔记同步操作。".into()),
    }
}
