use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub(crate) struct ResidualScanInput {
    pub name: String,
    pub publisher: String,
    pub install_location: Option<PathBuf>,
    pub uninstall_registry_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResidualKind {
    Directory,
    File,
    Shortcut,
}

impl ResidualKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::File => "file",
            Self::Shortcut => "shortcut",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResidualConfidence {
    High,
    Medium,
}

impl ResidualConfidence {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResidualDiscovery {
    pub target: PathBuf,
    pub kind: ResidualKind,
    pub category: String,
    pub confidence: ResidualConfidence,
    pub recommended: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ResidualScanRoots {
    pub local_app_data: Option<PathBuf>,
    pub roaming_app_data: Option<PathBuf>,
    pub local_low_app_data: Option<PathBuf>,
    pub program_data: Option<PathBuf>,
    pub temp: Option<PathBuf>,
    pub user_profile: Option<PathBuf>,
    pub public_profile: Option<PathBuf>,
    pub additional_protected_roots: Vec<PathBuf>,
}

impl ResidualScanRoots {
    fn from_environment() -> Self {
        let user_profile = env_path("USERPROFILE");
        let roaming_app_data = env_path("APPDATA");
        let program_data = env_path("PROGRAMDATA");
        let public_profile = env_path("PUBLIC");
        let local_low_app_data = user_profile
            .as_ref()
            .map(|root| root.join("AppData").join("LocalLow"));
        let mut additional_protected_roots = Vec::new();
        for key in ["ProgramFiles", "ProgramFiles(x86)", "SystemRoot"] {
            if let Some(path) = env_path(key) {
                additional_protected_roots.push(path);
            }
        }
        Self {
            local_app_data: env_path("LOCALAPPDATA"),
            roaming_app_data,
            local_low_app_data,
            program_data,
            temp: env_path("TEMP").or_else(|| Some(std::env::temp_dir())),
            user_profile,
            public_profile,
            additional_protected_roots,
        }
    }

    fn protected_roots(&self) -> Vec<PathBuf> {
        let mut roots = [
            self.local_app_data.as_ref(),
            self.roaming_app_data.as_ref(),
            self.local_low_app_data.as_ref(),
            self.program_data.as_ref(),
            self.temp.as_ref(),
            self.user_profile.as_ref(),
            self.public_profile.as_ref(),
        ]
        .into_iter()
        .flatten()
        .filter_map(|path| path.canonicalize().ok())
        .collect::<Vec<_>>();
        roots.extend(
            self.additional_protected_roots
                .iter()
                .filter_map(|path| path.canonicalize().ok()),
        );
        roots
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Alias {
    value: String,
    source: &'static str,
}

pub(crate) fn scan_residuals(input: &ResidualScanInput) -> Vec<ResidualDiscovery> {
    scan_residuals_with_roots(input, &ResidualScanRoots::from_environment())
}

pub(crate) fn scan_residuals_with_roots(
    input: &ResidualScanInput,
    roots: &ResidualScanRoots,
) -> Vec<ResidualDiscovery> {
    let (product_aliases, vendor_aliases) = residual_aliases(input);
    if product_aliases.is_empty() && input.install_location.is_none() {
        return Vec::new();
    }

    let protected_roots = roots.protected_roots();
    let mut seen = HashSet::new();
    let mut discoveries = Vec::new();

    if let Some(path) = input.install_location.as_deref() {
        add_candidate(
            path,
            None,
            "原安装目录",
            ResidualConfidence::High,
            true,
            "该目录是卸载前记录的安装位置".to_string(),
            &protected_roots,
            &mut seen,
            &mut discoveries,
        );
    }

    let data_roots = [
        (roots.local_app_data.as_deref(), "本地应用数据"),
        (roots.roaming_app_data.as_deref(), "漫游应用数据"),
        (roots.local_low_app_data.as_deref(), "低权限应用数据"),
        (roots.program_data.as_deref(), "共享应用数据"),
    ];
    for (root, category) in data_roots {
        let Some(root) = root else { continue };
        scan_named_paths(
            root,
            category,
            &product_aliases,
            &vendor_aliases,
            ResidualConfidence::High,
            true,
            &protected_roots,
            &mut seen,
            &mut discoveries,
        );
    }

    if let Some(root) = roots.temp.as_deref() {
        scan_named_paths(
            root,
            "临时文件",
            &product_aliases,
            &vendor_aliases,
            ResidualConfidence::High,
            true,
            &protected_roots,
            &mut seen,
            &mut discoveries,
        );
    }

    if let Some(profile) = roots.user_profile.as_deref() {
        for alias in &product_aliases {
            add_candidate(
                &profile.join(format!(".{}", alias.value)),
                Some(profile),
                "用户配置",
                ResidualConfidence::Medium,
                false,
                format!("名称与{}一致，可能包含需要保留的用户设置", alias.source),
                &protected_roots,
                &mut seen,
                &mut discoveries,
            );
            add_candidate(
                &profile.join(".config").join(&alias.value),
                Some(profile),
                "用户配置",
                ResidualConfidence::Medium,
                false,
                format!(
                    "配置目录名称与{}一致，可能包含需要保留的用户设置",
                    alias.source
                ),
                &protected_roots,
                &mut seen,
                &mut discoveries,
            );
            add_candidate(
                &profile.join(".cache").join(&alias.value),
                Some(profile),
                "用户缓存",
                ResidualConfidence::High,
                true,
                format!("缓存目录名称与{}一致", alias.source),
                &protected_roots,
                &mut seen,
                &mut discoveries,
            );
            for base in [[".local", "share"], [".local", "state"]] {
                add_candidate(
                    &profile.join(base[0]).join(base[1]).join(&alias.value),
                    Some(profile),
                    "用户配置",
                    ResidualConfidence::Medium,
                    false,
                    format!("配置目录名称与{}一致，可能包含需要保留的用户设置", alias.source),
                    &protected_roots,
                    &mut seen,
                    &mut discoveries,
                );
            }
        }

        for root in [
            profile.join("Documents"),
            profile.join("Saved Games"),
            profile.join("Downloads"),
            profile.join("Pictures"),
            profile.join("Videos"),
        ] {
            scan_named_paths(
                &root,
                "用户资料",
                &product_aliases,
                &vendor_aliases,
                ResidualConfidence::Medium,
                false,
                &protected_roots,
                &mut seen,
                &mut discoveries,
            );
        }
    }
    if let Some(public) = roots.public_profile.as_deref() {
        scan_named_paths(
            &public.join("Documents"),
            "用户资料",
            &product_aliases,
            &vendor_aliases,
            ResidualConfidence::Medium,
            false,
            &protected_roots,
            &mut seen,
            &mut discoveries,
        );
    }

    let shortcut_roots = shortcut_roots(roots);
    for (root, category) in shortcut_roots {
        scan_shortcut_directory(
            &root,
            category,
            &product_aliases,
            &protected_roots,
            &mut seen,
            &mut discoveries,
        );
    }

    discoveries.sort_by(|left, right| {
        left.category
            .cmp(&right.category)
            .then_with(|| path_key(&left.target).cmp(&path_key(&right.target)))
    });
    discoveries
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn shortcut_roots(roots: &ResidualScanRoots) -> Vec<(PathBuf, &'static str)> {
    let mut result = Vec::new();
    if let Some(profile) = roots.user_profile.as_deref() {
        result.push((profile.join("Desktop"), "桌面快捷方式"));
    }
    if let Some(profile) = roots.public_profile.as_deref() {
        result.push((profile.join("Desktop"), "公共桌面快捷方式"));
    }
    if let Some(roaming) = roots.roaming_app_data.as_deref() {
        result.push((
            roaming
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
            "开始菜单快捷方式",
        ));
    }
    if let Some(program_data) = roots.program_data.as_deref() {
        result.push((
            program_data
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
            "公共开始菜单快捷方式",
        ));
    }
    result
}

fn residual_aliases(input: &ResidualScanInput) -> (Vec<Alias>, Vec<Alias>) {
    let mut products = Vec::new();
    let mut vendors = Vec::new();
    push_alias(&mut products, &input.name, "软件名称");
    push_alias(&mut vendors, &input.publisher, "发布者名称");

    if let Some(install_location) = input.install_location.as_deref() {
        if let Some(name) = install_location.file_name().and_then(OsStr::to_str) {
            push_alias(&mut products, name, "安装目录名称");
        }
        if let Some(name) = install_location
            .parent()
            .and_then(Path::file_name)
            .and_then(OsStr::to_str)
        {
            push_alias(&mut vendors, name, "安装目录中的厂商名称");
        }
    }

    if let Some(key) = input.uninstall_registry_key.as_deref() {
        if let Some(name) = key.rsplit(['\\', '/']).find(|part| !part.trim().is_empty()) {
            if !looks_like_product_code(name) {
                push_alias(&mut products, name, "卸载注册信息名称");
            }
        }
    }
    (products, vendors)
}

fn push_alias(aliases: &mut Vec<Alias>, value: &str, source: &'static str) {
    let value = value.trim();
    if !is_safe_alias(value)
        || aliases
            .iter()
            .any(|existing| existing.value.eq_ignore_ascii_case(value))
    {
        return;
    }
    aliases.push(Alias {
        value: value.to_string(),
        source,
    });
}

fn is_safe_alias(value: &str) -> bool {
    let value = value.trim();
    if value.chars().count() < 2 || value.chars().count() > 120 {
        return false;
    }
    if value == "."
        || value == ".."
        || value.chars().any(|character| {
            matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'
            )
        })
        || Path::new(value).components().count() != 1
    {
        return false;
    }
    !matches!(
        value.to_ascii_lowercase().as_str(),
        "app"
            | "application"
            | "applications"
            | "software"
            | "program"
            | "programs"
            | "program files"
            | "program files (x86)"
            | "users"
            | "appdata"
            | "local"
            | "locallow"
            | "roaming"
            | "temp"
            | "tmp"
            | "cache"
            | "config"
    )
}

fn looks_like_product_code(value: &str) -> bool {
    let value = value.trim();
    value.starts_with('{')
        && value.ends_with('}')
        && value.len() >= 34
        && value[1..value.len() - 1]
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

#[allow(clippy::too_many_arguments)]
fn scan_named_paths(
    root: &Path,
    category: &str,
    product_aliases: &[Alias],
    vendor_aliases: &[Alias],
    confidence: ResidualConfidence,
    recommended: bool,
    protected_roots: &[PathBuf],
    seen: &mut HashSet<String>,
    discoveries: &mut Vec<ResidualDiscovery>,
) {
    for product in product_aliases {
        add_candidate(
            &root.join(&product.value),
            Some(root),
            category,
            confidence,
            recommended,
            format!("名称与{}精确匹配", product.source),
            protected_roots,
            seen,
            discoveries,
        );
        for vendor in vendor_aliases {
            add_candidate(
                &root.join(&vendor.value).join(&product.value),
                Some(root),
                category,
                confidence,
                recommended,
                format!("目录层级与{}和{}精确匹配", vendor.source, product.source),
                protected_roots,
                seen,
                discoveries,
            );
        }
    }
}

fn scan_shortcut_directory(
    root: &Path,
    category: &str,
    aliases: &[Alias],
    protected_roots: &[PathBuf],
    seen: &mut HashSet<String>,
    discoveries: &mut Vec<ResidualDiscovery>,
) {
    scan_shortcut_directory_bounded(root, root, category, aliases, 0, protected_roots, seen, discoveries);
}

#[allow(clippy::too_many_arguments)]
fn scan_shortcut_directory_bounded(
    root: &Path,
    current: &Path,
    category: &str,
    aliases: &[Alias],
    depth: usize,
    protected_roots: &[PathBuf],
    seen: &mut HashSet<String>,
    discoveries: &mut Vec<ResidualDiscovery>,
) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() && depth == 0 {
            scan_shortcut_directory_bounded(
                root,
                &path,
                category,
                aliases,
                1,
                protected_roots,
                seen,
                discoveries,
            );
            continue;
        }
        if !file_type.is_file() || !is_shortcut(&path) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(OsStr::to_str) else {
            continue;
        };
        let Some(alias) = aliases
            .iter()
            .find(|alias| shortcut_name_matches(stem, &alias.value))
        else {
            continue;
        };
        add_candidate(
            &path,
            Some(root),
            category,
            ResidualConfidence::Medium,
            false,
            format!("快捷方式名称与{}匹配，删除前需要确认", alias.source),
            protected_roots,
            seen,
            discoveries,
        );
    }
}

fn is_shortcut(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("lnk")
                || extension.eq_ignore_ascii_case("url")
                || extension.eq_ignore_ascii_case("appref-ms")
        })
}

fn shortcut_name_matches(stem: &str, alias: &str) -> bool {
    let stem = stem.trim();
    stem.eq_ignore_ascii_case(alias)
        || stem
            .strip_suffix(" - Shortcut")
            .is_some_and(|name| name.trim().eq_ignore_ascii_case(alias))
        || stem
            .strip_suffix(" - 快捷方式")
            .is_some_and(|name| name.trim().eq_ignore_ascii_case(alias))
}

#[allow(clippy::too_many_arguments)]
fn add_candidate(
    path: &Path,
    allowed_root: Option<&Path>,
    category: &str,
    confidence: ResidualConfidence,
    recommended: bool,
    reason: String,
    protected_roots: &[PathBuf],
    seen: &mut HashSet<String>,
    discoveries: &mut Vec<ResidualDiscovery>,
) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
        return;
    }
    let Ok(target) = path.canonicalize() else {
        return;
    };
    if is_filesystem_root(&target) || protected_roots.iter().any(|root| same_path(root, &target)) {
        return;
    }
    if let Some(root) = allowed_root {
        let Ok(root) = root.canonicalize() else {
            return;
        };
        if same_path(&root, &target) || !is_path_within(&target, &root) {
            return;
        }
    }
    if !seen.insert(path_key(&target)) {
        return;
    }
    let kind = if metadata.is_dir() {
        ResidualKind::Directory
    } else if is_shortcut(&target) {
        ResidualKind::Shortcut
    } else {
        ResidualKind::File
    };
    discoveries.push(ResidualDiscovery {
        target,
        kind,
        category: category.to_string(),
        confidence,
        recommended,
        reason,
    });
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

fn same_path(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}

fn is_path_within(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let path = path_key(path);
        let root = path_key(root);
        return path
            .strip_prefix(&root)
            .is_some_and(|remainder| remainder.starts_with('\\'));
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root) && path != root
    }
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('/', "\\");
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(install_location: Option<PathBuf>) -> ResidualScanInput {
        ResidualScanInput {
            name: "Example App".to_string(),
            publisher: "Example Vendor".to_string(),
            install_location,
            uninstall_registry_key: Some(
                r"HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\ExampleApp"
                    .to_string(),
            ),
        }
    }

    #[test]
    fn builds_safe_identity_aliases() {
        let scan_input = input(Some(PathBuf::from(
            "C:/Program Files/Example Vendor/ExampleApp",
        )));
        let (products, vendors) = residual_aliases(&scan_input);
        assert_eq!(
            products
                .iter()
                .map(|alias| alias.value.as_str())
                .collect::<Vec<_>>(),
            vec!["Example App", "ExampleApp"]
        );
        assert_eq!(
            vendors
                .iter()
                .map(|alias| alias.value.as_str())
                .collect::<Vec<_>>(),
            vec!["Example Vendor"]
        );

        let unsafe_input = ResidualScanInput {
            name: "../Example".to_string(),
            publisher: "Program Files".to_string(),
            install_location: None,
            uninstall_registry_key: Some("{12345678-1234-1234-1234-123456789ABC}".to_string()),
        };
        let (products, vendors) = residual_aliases(&unsafe_input);
        assert!(products.is_empty());
        assert!(vendors.is_empty());
    }

    #[test]
    fn scans_known_data_roots_and_user_hidden_paths() {
        let sandbox = tempfile::tempdir().unwrap();
        let local = sandbox.path().join("local");
        let roaming = sandbox.path().join("roaming");
        let low = sandbox.path().join("low");
        let program_data = sandbox.path().join("program-data");
        let temp = sandbox.path().join("temp");
        let profile = sandbox.path().join("profile");
        let public = sandbox.path().join("public");
        let install = sandbox
            .path()
            .join("programs")
            .join("Example Vendor")
            .join("ExampleApp");
        for path in [
            local.join("Example App"),
            roaming.join("Example Vendor").join("Example App"),
            low.join("ExampleApp"),
            program_data.join("ExampleApp"),
            temp.join("ExampleApp"),
            profile.join(".Example App"),
            profile.join(".config").join("ExampleApp"),
            profile.join(".cache").join("ExampleApp"),
            profile.join("Documents").join("Example App"),
            public.join("Documents").join("ExampleApp"),
            install.clone(),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        let roots = ResidualScanRoots {
            local_app_data: Some(local),
            roaming_app_data: Some(roaming),
            local_low_app_data: Some(low),
            program_data: Some(program_data),
            temp: Some(temp),
            user_profile: Some(profile),
            public_profile: Some(public),
            ..Default::default()
        };

        let discoveries = scan_residuals_with_roots(&input(Some(install)), &roots);

        assert_eq!(discoveries.len(), 11);
        assert!(discoveries
            .iter()
            .any(|item| item.category == "低权限应用数据"));
        assert!(discoveries
            .iter()
            .any(|item| item.category == "共享应用数据"));
        assert!(discoveries.iter().any(|item| {
            item.category == "用户配置"
                && item.confidence == ResidualConfidence::Medium
                && !item.recommended
        }));
        assert_eq!(
            discoveries.iter().filter(|item| item.category == "用户资料").count(),
            2
        );
        assert!(discoveries.iter().any(|item| {
            item.category == "用户缓存"
                && item.confidence == ResidualConfidence::High
                && item.recommended
        }));
    }

    #[test]
    fn scans_matching_shortcuts_at_a_bounded_depth() {
        let sandbox = tempfile::tempdir().unwrap();
        let profile = sandbox.path().join("profile");
        let desktop = profile.join("Desktop");
        let roaming = sandbox.path().join("roaming");
        let start_menu = roaming
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");
        fs::create_dir_all(desktop.join("nested")).unwrap();
        fs::create_dir_all(&start_menu).unwrap();
        fs::write(desktop.join("Example App.lnk"), b"shortcut").unwrap();
        fs::write(desktop.join("nested").join("Example App.lnk"), b"shortcut").unwrap();
        fs::write(start_menu.join("ExampleApp.url"), b"shortcut").unwrap();
        fs::write(start_menu.join("Unrelated.lnk"), b"shortcut").unwrap();
        let roots = ResidualScanRoots {
            roaming_app_data: Some(roaming),
            user_profile: Some(profile),
            ..Default::default()
        };

        let discoveries = scan_residuals_with_roots(&input(None), &roots);
        let shortcuts = discoveries
            .iter()
            .filter(|item| item.kind == ResidualKind::Shortcut)
            .collect::<Vec<_>>();

        assert_eq!(shortcuts.len(), 3);
        assert!(shortcuts.iter().all(|item| !item.recommended));
        assert!(shortcuts
            .iter()
            .all(|item| item.confidence == ResidualConfidence::Medium));
    }

    #[test]
    fn rejects_a_scan_root_even_when_it_matches_an_alias() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("Example App");
        fs::create_dir_all(&root).unwrap();
        let roots = ResidualScanRoots {
            local_app_data: Some(root.clone()),
            ..Default::default()
        };
        let scan_input = ResidualScanInput {
            name: "Example App".to_string(),
            publisher: String::new(),
            install_location: Some(root),
            uninstall_registry_key: None,
        };

        assert!(scan_residuals_with_roots(&scan_input, &roots).is_empty());
    }

    #[test]
    fn kind_and_confidence_have_stable_wire_values() {
        assert_eq!(ResidualKind::Directory.as_str(), "directory");
        assert_eq!(ResidualKind::File.as_str(), "file");
        assert_eq!(ResidualKind::Shortcut.as_str(), "shortcut");
        assert_eq!(ResidualConfidence::High.as_str(), "high");
        assert_eq!(ResidualConfidence::Medium.as_str(), "medium");
    }
}
