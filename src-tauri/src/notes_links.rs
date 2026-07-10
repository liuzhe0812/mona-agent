//! Bidirectional link scanning, links.json cache, backlinks, mentions,
//! rename sync, and MOC listing for the notes vault.
//!
//! Scans .md files (one level deep, matching `notes::scan_vault`) and parses
//! `[[wiki link]]` / `![[embed]]` references. Results are cached at
//! `<vault>/.mona/links.json` and exposed via Tauri commands.

use crate::notes::{self, OperationNote};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Public types (returned by Tauri commands)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkNode {
    pub id: String,
    pub title: String,
    pub path: String,
    pub aliases: Vec<String>,
    pub note_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEdge {
    pub source: String,
    /// Raw target as written in `[[target]]` (before alias `|` split, after
    /// `#anchor` split).
    pub target_title: String,
    /// Resolved note id if the target matches a known note title or alias.
    pub resolved_target: Option<String>,
    /// "link" or "embed".
    pub kind: String,
    /// Anchor after `#` (heading or `^block-id`), if any.
    pub anchor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkGraph {
    pub nodes: Vec<LinkNode>,
    pub edges: Vec<LinkEdge>,
    pub last_scan_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkItem {
    pub note_id: String,
    pub title: String,
    pub path: String,
    pub snippet: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionItem {
    pub note_id: String,
    pub title: String,
    pub path: String,
    pub snippet: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub updated_files: usize,
    pub updated_links: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MocItem {
    pub id: String,
    pub title: String,
    pub path: String,
    pub outgoing_count: usize,
    pub incoming_count: usize,
}

// ---------------------------------------------------------------------------
// Cache file format
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedGraph {
    version: u32,
    nodes: Vec<LinkNode>,
    edges: Vec<LinkEdge>,
    last_scan_at: i64,
}

const CACHE_VERSION: u32 = 2;

fn links_cache_path(vault: &Path) -> PathBuf {
    vault.join(".mona").join("links.json")
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ScannedNote {
    note: OperationNote,
    relative_path: String,
    absolute_path: PathBuf,
    /// Raw markdown body (without frontmatter) used for link extraction.
    body: String,
}

/// Scan all .md files one level deep (matching `notes::scan_vault`).
fn scan_vault_links(vault: &Path) -> Vec<ScannedNote> {
    let mut out: Vec<ScannedNote> = Vec::new();
    let push = |path: &Path, notebook: &str, out: &mut Vec<ScannedNote>| {
        if let Ok(note) = notes::parse_note_file(path, notebook) {
            let relative = path
                .strip_prefix(vault)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            // parse_note_file already returns body without frontmatter.
            let body = note.content_markdown.clone();
            out.push(ScannedNote {
                note,
                relative_path: relative,
                absolute_path: path.to_path_buf(),
                body,
            });
        }
    };

    // Root-level .md files.
    if let Ok(entries) = fs::read_dir(vault) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("md") {
                push(&p, "", &mut out);
            }
        }
    }

    // 1-level subdirectory .md files.
    if let Ok(entries) = fs::read_dir(vault) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let name = match p.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !notes::is_notebook_folder(&name) {
                continue;
            }
            if let Ok(md_entries) = fs::read_dir(&p) {
                for md_entry in md_entries.flatten() {
                    let md_path = md_entry.path();
                    if md_path.extension().and_then(|e| e.to_str()) == Some("md") {
                        push(&md_path, &name, &mut out);
                    }
                }
            }
        }
    }

    out
}

// ---------------------------------------------------------------------------
// Wiki link parsing (manual, no regex dependency)
// ---------------------------------------------------------------------------

struct WikiLinkRef {
    target: String,
    anchor: Option<String>,
    is_embed: bool,
    /// Byte offset of the `[[` start, used to compute line numbers.
    start_byte: usize,
}

/// Extract `[[target]]` and `![[target]]` references from markdown content.
/// Skips fenced code blocks (``` ... ```).
fn extract_wiki_links(content: &str) -> Vec<WikiLinkRef> {
    let mut links = Vec::new();
    let mut in_fence = false;
    let mut byte_offset = 0usize;

    // Use split_inclusive to preserve exact byte lengths (handles \r\n on Windows).
    for line_with_sep in content.split_inclusive('\n') {
        let line_with_sep_len = line_with_sep.len();
        let line = line_with_sep.trim_end_matches(['\n', '\r']);

        // Detect fenced code block toggles at line start.
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            byte_offset += line_with_sep_len;
            continue;
        }
        if in_fence {
            byte_offset += line_with_sep_len;
            continue;
        }

        let mut rest = line;
        let mut rest_offset = byte_offset;
        while let Some(open_pos) = rest.find("[[") {
            let before = &rest[..open_pos];
            let is_embed = before.ends_with('!');
            let marker_len = if is_embed { 3 } else { 2 };
            let marker_start = rest_offset + open_pos + (if is_embed { 1 } else { 0 });
            let inner = &rest[open_pos + (if is_embed { 1 } else { 0 }) + 2..];

            let close_pos = match inner.find("]]") {
                Some(p) => p,
                None => break,
            };

            let raw = &inner[..close_pos];
            let (target_with_alias, anchor) = match raw.find('#') {
                Some(pos) => (&raw[..pos], Some(raw[pos + 1..].to_string())),
                None => (raw, None),
            };
            let target = match target_with_alias.find('|') {
                Some(pos) => target_with_alias[..pos].trim().to_string(),
                None => target_with_alias.trim().to_string(),
            };
            if !target.is_empty() {
                links.push(WikiLinkRef {
                    target,
                    anchor,
                    is_embed,
                    start_byte: marker_start,
                });
            }
            let consumed = open_pos + marker_len + close_pos + 2;
            rest = &rest[consumed..];
            rest_offset += consumed;
        }
        byte_offset += line_with_sep_len;
    }

    links
}

/// Compute 1-based line number for a byte offset in `content`.
fn line_number(content: &str, byte_offset: usize) -> usize {
    let byte_offset = floor_char_boundary(content, byte_offset.min(content.len()));
    let prefix = &content[..byte_offset];
    prefix.matches('\n').count() + 1
}

/// Build a short snippet (±48 chars) around a byte offset.
fn snippet_around(content: &str, byte_offset: usize, length: usize) -> String {
    let start = byte_offset.saturating_sub(48);
    let end = (byte_offset + length + 48).min(content.len());
    // Floor to char boundary.
    let start = floor_char_boundary(content, start);
    let end = ceil_char_boundary(content, end);
    let mut s = String::new();
    if start > 0 {
        s.push_str("...");
    }
    s.push_str(&content[start..end]);
    if end < content.len() {
        s.push_str("...");
    }
    s.replace('\n', " ")
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(idx) && idx > 0 {
        idx -= 1;
    }
    idx
}

fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

// ---------------------------------------------------------------------------
// Title → note id resolution
// ---------------------------------------------------------------------------

/// Build a map from lowercased title/alias → note id for link resolution.
fn build_title_index(scanned: &[ScannedNote]) -> HashMap<String, String> {
    let mut idx: HashMap<String, String> = HashMap::new();
    for sn in scanned {
        let title_lc = sn.note.title.trim().to_lowercase();
        if !title_lc.is_empty() {
            idx.entry(title_lc).or_insert_with(|| sn.note.id.clone());
        }
        for alias in &sn.note.aliases {
            let a = alias.trim().to_lowercase();
            if !a.is_empty() {
                idx.entry(a).or_insert_with(|| sn.note.id.clone());
            }
        }
    }
    idx
}

// ---------------------------------------------------------------------------
// Build graph
// ---------------------------------------------------------------------------

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn build_graph(vault: &Path) -> LinkGraph {
    let t0 = std::time::Instant::now();
    let scanned = scan_vault_links(vault);
    log::info!("[graph] scan_vault_links: {} notes, {:?}", scanned.len(), t0.elapsed());
    let title_index = build_title_index(&scanned);

    let nodes: Vec<LinkNode> = scanned
        .iter()
        .map(|sn| LinkNode {
            id: sn.note.id.clone(),
            title: sn.note.title.clone(),
            path: sn.relative_path.clone(),
            aliases: sn.note.aliases.clone(),
            note_type: sn.note.note_type.clone(),
        })
        .collect();

    let mut edges: Vec<LinkEdge> = Vec::new();
    for sn in &scanned {
        let refs = extract_wiki_links(&sn.body);
        for r in refs {
            let resolved = title_index.get(&r.target.to_lowercase()).cloned();
            edges.push(LinkEdge {
                source: sn.note.id.clone(),
                target_title: r.target.clone(),
                resolved_target: resolved,
                kind: if r.is_embed { "embed".to_string() } else { "link".to_string() },
                anchor: r.anchor,
            });
        }
    }

    LinkGraph {
        nodes,
        edges,
        last_scan_at: now_unix(),
    }
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

fn load_cached_graph(vault: &Path) -> Option<LinkGraph> {
    let path = links_cache_path(vault);
    let content = fs::read_to_string(&path).ok()?;
    let cached: CachedGraph = serde_json::from_str(&content).ok()?;
    if cached.version != CACHE_VERSION {
        return None;
    }
    Some(LinkGraph {
        nodes: cached.nodes,
        edges: cached.edges,
        last_scan_at: cached.last_scan_at,
    })
}

fn save_cached_graph(vault: &Path, graph: &LinkGraph) -> Result<(), String> {
    let dir = vault.join(".mona");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create .mona dir: {}", e))?;
    let cached = CachedGraph {
        version: CACHE_VERSION,
        nodes: graph.nodes.clone(),
        edges: graph.edges.clone(),
        last_scan_at: graph.last_scan_at.clone(),
    };
    let json = serde_json::to_string(&cached)
        .map_err(|e| format!("Failed to serialize links.json: {}", e))?;
    fs::write(links_cache_path(vault), json)
        .map_err(|e| format!("Failed to write links.json: {}", e))
}

fn file_mtime(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

fn vault_mtime_newer_than(vault: &Path, threshold: i64) -> bool {
    let mut check = |path: &Path| {
        if let Some(mtime) = file_mtime(path) {
            if mtime > threshold {
                return Some(true);
            }
        }
        None
    };

    if let Ok(entries) = fs::read_dir(vault) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("md") {
                if check(&p).is_some() {
                    return true;
                }
            }
            if !p.is_dir() {
                continue;
            }
            let name = match p.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if !notes::is_notebook_folder(name) {
                continue;
            }
            if let Ok(md_entries) = fs::read_dir(&p) {
                for md_entry in md_entries.flatten() {
                    let md_path = md_entry.path();
                    if md_path.extension().and_then(|e| e.to_str()) == Some("md") {
                        if check(&md_path).is_some() {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

/// Get the current graph, rebuilding from disk if no cache exists or cache is stale.
fn current_graph() -> Result<LinkGraph, String> {
    let start = std::time::Instant::now();
    let vault = notes::read_vault_path().ok_or_else(|| "No vault configured".to_string())?;
    log::info!("[graph] current_graph start, vault={:?}", vault);
    if let Some(cached) = load_cached_graph(&vault) {
        let stale = vault_mtime_newer_than(&vault, cached.last_scan_at);
        log::info!("[graph] cache stale={} threshold={}", stale, cached.last_scan_at);
        if !stale {
            log::info!("[graph] loaded from cache, {} nodes, elapsed {:?}", cached.nodes.len(), start.elapsed());
            return Ok(cached);
        }
        log::info!("[graph] cache stale, rebuilding...");
    } else {
        log::info!("[graph] no cache, building...");
    }
    let graph = build_graph(&vault);
    log::info!("[graph] built {} nodes {} edges, elapsed {:?}", graph.nodes.len(), graph.edges.len(), start.elapsed());
    save_cached_graph(&vault, &graph)?;
    log::info!("[graph] saved, total elapsed {:?}", start.elapsed());
    Ok(graph)
}

// ---------------------------------------------------------------------------
// Mentions (plain-text occurrences not wrapped in [[ ]])
// ---------------------------------------------------------------------------

fn find_plain_mentions(
    scanned: &[ScannedNote],
    query: &str,
    exclude_id: &str,
) -> Vec<MentionItem> {
    let q = query.trim();
    if q.is_empty() || q.len() < 2 {
        return Vec::new();
    }
    let q_lc = q.to_lowercase();
    let mut out = Vec::new();
    for sn in scanned {
        if sn.note.id == exclude_id {
            continue;
        }
        // to_lowercase may change byte length for some Unicode chars, so all
        // byte-offset operations below must use body_lc, never sn.body.
        let body_lc = sn.body.to_lowercase();
        let mut from = 0;
        while let Some(pos) = body_lc[from..].find(&q_lc) {
            let abs_pos = from + pos;
            // Skip if inside `[[...]]` or `![[...]]`.
            if !is_inside_wiki_link(&body_lc, abs_pos) {
                let line = line_number(&body_lc, abs_pos);
                let snippet = snippet_around(&body_lc, abs_pos, q_lc.len());
                out.push(MentionItem {
                    note_id: sn.note.id.clone(),
                    title: sn.note.title.clone(),
                    path: sn.relative_path.clone(),
                    snippet,
                    line,
                });
            }
            from = abs_pos + q_lc.len();
        }
    }
    out
}

/// Return true if the byte at `offset` is inside a `[[...]]` or `![[...]]`
/// region. Uses a simple forward scan from line start.
fn is_inside_wiki_link(content: &str, offset: usize) -> bool {
    let offset = floor_char_boundary(content, offset.min(content.len()));
    // Walk backwards to find the most recent unclosed `[[` on the same line.
    let line_start = content[..offset].rfind('\n').map(|p| p + 1).unwrap_or(0);
    let line_prefix = &content[line_start..offset];
    let mut depth = 0i32;
    let mut rest = line_prefix;
    while !rest.is_empty() {
        if rest.starts_with("![[") {
            depth += 1;
            rest = &rest[3..];
        } else if rest.starts_with("[[") {
            depth += 1;
            rest = &rest[2..];
        } else if rest.starts_with("]]") {
            if depth > 0 {
                depth -= 1;
            }
            rest = &rest[2..];
        } else {
            // Advance one character (not one byte) to stay on char boundary.
            let step = rest
                .char_indices()
                .nth(1)
                .map(|(i, _)| i)
                .unwrap_or(rest.len());
            rest = &rest[step..];
        }
    }
    depth > 0
}

// ---------------------------------------------------------------------------
// Rename sync
// ---------------------------------------------------------------------------

/// Replace `[[old...]]` and `![[old...]]` with `[[new...]]` / `![[new...]]`
/// across all .md files in the vault. Only exact title matches are replaced
/// (the part before `#`, `|`, or `]]`).
fn rename_sync(old_title: &str, new_title: &str) -> Result<RenameResult, String> {
    let vault = notes::read_vault_path().ok_or_else(|| "No vault configured".to_string())?;
    let scanned = scan_vault_links(&vault);
    let mut updated_files = 0usize;
    let mut updated_links = 0usize;

    for sn in &scanned {
        let original = fs::read_to_string(&sn.absolute_path)
            .map_err(|e| format!("Failed to read {}: {}", sn.absolute_path.display(), e))?;
        let (updated, count) = replace_wiki_target(&original, old_title, new_title);
        if count > 0 {
            fs::write(&sn.absolute_path, &updated)
                .map_err(|e| format!("Failed to write {}: {}", sn.absolute_path.display(), e))?;
            updated_files += 1;
            updated_links += count;
        }
    }

    // Invalidate cache so next call rescans.
    let cache_path = links_cache_path(&vault);
    let _ = fs::remove_file(cache_path);

    Ok(RenameResult {
        updated_files,
        updated_links,
    })
}

/// Replace `[[old...]]` and `![[old...]]` target prefixes in `content`.
/// Returns (new_content, replacement_count).
fn replace_wiki_target(content: &str, old: &str, new: &str) -> (String, usize) {
    let mut result = String::with_capacity(content.len());
    let mut count = 0usize;
    let mut i = 0;
    let bytes = content.as_bytes();
    let old_lc = old.to_lowercase();

    while i < bytes.len() {
        let (is_embed, target_start) = if content[i..].starts_with("![[") {
            (true, i + 3)
        } else if content[i..].starts_with("[[") {
            (false, i + 2)
        } else {
            // Copy one byte and advance.
            let ch_end = next_char_boundary(content, i);
            result.push_str(&content[i..ch_end]);
            i = ch_end;
            continue;
        };

        // Find closing `]]`.
        let close_rel = content[target_start..].find("]]");
        let close = match close_rel {
            Some(p) => target_start + p,
            None => {
                // Unterminated link; copy as-is and advance.
                let ch_end = next_char_boundary(content, i);
                result.push_str(&content[i..ch_end]);
                i = ch_end;
                continue;
            }
        };

        let raw = &content[target_start..close];
        // Split off anchor (#) and alias (|).
        let (target_part, _rest) = match raw.find('#') {
            Some(p) => (&raw[..p], &raw[p..]),
            None => (raw, ""),
        };
        let (target, _alias_part) = match target_part.find('|') {
            Some(p) => (&target_part[..p], &target_part[p..]),
            None => (target_part, ""),
        };

        if target.trim().eq_ignore_ascii_case(&old_lc) {
            // Reconstruct: prefix + [[ or ![[ + new + rest + ]]
            if is_embed {
                result.push_str("![[" );
            } else {
                result.push_str("[[");
            }
            result.push_str(new);
            // Append the part after the original target (anchor + alias + closing).
            let after_target = &content[target_start + target.len()..close + 2];
            result.push_str(after_target);
            count += 1;
        } else {
            // Copy the whole `[[...]]` or `![[...]]` verbatim.
            result.push_str(&content[i..close + 2]);
        }
        i = close + 2;
    }

    (result, count)
}

fn next_char_boundary(s: &str, idx: usize) -> usize {
    let mut next = idx + 1;
    while next < s.len() && !s.is_char_boundary(next) {
        next += 1;
    }
    if next >= s.len() {
        s.len()
    } else {
        next
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn notes_links_get_graph() -> Result<LinkGraph, String> {
    log::info!("[graph] notes_links_get_graph invoked");
    let result = tauri::async_runtime::spawn_blocking(current_graph).await;
    match result {
        Ok(Ok(graph)) => {
            log::info!("[graph] notes_links_get_graph success: {} nodes", graph.nodes.len());
            Ok(graph)
        }
        Ok(Err(e)) => {
            log::error!("[graph] notes_links_get_graph error: {}", e);
            Err(e)
        }
        Err(e) => {
            log::error!("[graph] notes_links_get_graph join error: {}", e);
            Err(format!("Graph build task failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn notes_links_get_backlinks(note_id: String) -> Result<Vec<BacklinkItem>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let vault = notes::read_vault_path().ok_or_else(|| "No vault configured".to_string())?;
        let scanned = scan_vault_links(&vault);
        let mut out = Vec::new();
        for sn in &scanned {
            if sn.note.id == note_id {
                continue;
            }
            let refs = extract_wiki_links(&sn.body);
            for r in refs {
                // A backlink exists if this note links to `note_id`. We resolve by
                // title/alias match against the target note.
                let target_note = scanned.iter().find(|s| s.note.id == note_id);
                if let Some(target) = target_note {
                    let is_match = r.target.eq_ignore_ascii_case(&target.note.title)
                        || target
                            .note
                            .aliases
                            .iter()
                            .any(|a| a.eq_ignore_ascii_case(&r.target));
                    if is_match {
                        let line = line_number(&sn.body, r.start_byte);
                        let snippet = snippet_around(&sn.body, r.start_byte, r.target.len() + 4);
                        out.push(BacklinkItem {
                            note_id: sn.note.id.clone(),
                            title: sn.note.title.clone(),
                            path: sn.relative_path.clone(),
                            snippet,
                            line,
                        });
                    }
                }
            }
        }
        Ok(out)
    })
    .await;
    match result {
        Ok(inner) => inner,
        Err(e) => Err(format!("Backlinks scan task failed: {}", e)),
    }
}

#[tauri::command]
pub async fn notes_links_get_mentions(note_id: String) -> Result<Vec<MentionItem>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let vault = notes::read_vault_path().ok_or_else(|| "No vault configured".to_string())?;
        let scanned = scan_vault_links(&vault);
        let target = scanned.iter().find(|s| s.note.id == note_id).cloned();
        let target = match target {
            Some(t) => t,
            None => return Ok(Vec::new()),
        };
        let mut mentions = find_plain_mentions(&scanned, &target.note.title, &target.note.id);
        // Also search each alias.
        for alias in &target.note.aliases {
            let mut more = find_plain_mentions(&scanned, alias, &target.note.id);
            mentions.append(&mut more);
        }
        // Deduplicate by note_id + line.
        let mut seen: std::collections::HashSet<(String, usize)> = Default::default();
        mentions.retain(|m| seen.insert((m.note_id.clone(), m.line)));
        Ok(mentions)
    })
    .await;
    match result {
        Ok(inner) => inner,
        Err(e) => Err(format!("Mentions scan task failed: {}", e)),
    }
}

#[tauri::command]
pub async fn notes_links_rename_sync(
    old_title: String,
    new_title: String,
) -> Result<RenameResult, String> {
    rename_sync(&old_title, &new_title)
}

#[tauri::command]
pub async fn notes_links_search_mentions(query: String) -> Result<Vec<MentionItem>, String> {
    let vault = notes::read_vault_path().ok_or_else(|| "No vault configured".to_string())?;
    let scanned = scan_vault_links(&vault);
    Ok(find_plain_mentions(&scanned, &query, ""))
}

#[tauri::command]
pub async fn notes_moc_list() -> Result<Vec<MocItem>, String> {
    let graph = current_graph()?;
    // Incoming count by resolved target id.
    let mut incoming: HashMap<String, usize> = HashMap::new();
    let mut outgoing: HashMap<String, usize> = HashMap::new();
    for edge in &graph.edges {
        if let Some(target) = &edge.resolved_target {
            *incoming.entry(target.clone()).or_insert(0) += 1;
        }
        *outgoing.entry(edge.source.clone()).or_insert(0) += 1;
    }
    let mocs = graph
        .nodes
        .iter()
        .filter(|n| n.note_type == "moc")
        .map(|n| MocItem {
            id: n.id.clone(),
            title: n.title.clone(),
            path: n.path.clone(),
            outgoing_count: *outgoing.get(&n.id).unwrap_or(&0),
            incoming_count: *incoming.get(&n.id).unwrap_or(&0),
        })
        .collect();
    Ok(mocs)
}
