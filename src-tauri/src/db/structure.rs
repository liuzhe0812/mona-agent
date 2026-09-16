use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use super::error::DbError;
use super::manager::{self, DbHandle};
use super::types::{
    ColumnDefinition, DbConnectionConfig, ForeignKeyDefinition, IndexDefinition, TableInfo,
    TriggerDefinition,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DefaultMode {
    Keep,
    None,
    Null,
    Literal,
    Expression,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructureColumn {
    pub original_name: Option<String>,
    pub name: String,
    pub data_type: String,
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
    pub default_mode: DefaultMode,
    pub default_value: Option<String>,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructureIndex {
    pub original_name: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub index_type: String,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructureForeignKey {
    pub original_name: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_delete: String,
    pub on_update: String,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructureTrigger {
    pub original_name: Option<String>,
    pub name: String,
    pub timing: String,
    pub event: String,
    pub statement: String,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AdvancedKey {
    Engine,
    Charset,
    Collation,
    Comment,
    RowFormat,
    AutoIncrement,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdvancedOption {
    pub key: AdvancedKey,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TableAdvanced {
    pub engine: Option<String>,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub comment: Option<String>,
    pub row_format: Option<String>,
    pub auto_increment: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureDraft {
    pub original_columns: Vec<ColumnDefinition>,
    pub columns: Vec<StructureColumn>,
    pub original_indexes: Vec<IndexDefinition>,
    pub indexes: Vec<StructureIndex>,
    pub original_foreign_keys: Vec<ForeignKeyDefinition>,
    pub foreign_keys: Vec<StructureForeignKey>,
    pub original_triggers: Vec<TriggerDefinition>,
    pub triggers: Vec<StructureTrigger>,
    pub original_advanced: TableAdvanced,
    pub advanced: Vec<AdvancedOption>,
    pub section: String,
}

#[derive(Debug, Serialize)]
pub struct ApplyResult {
    pub table_info: Option<TableInfo>,
    pub refresh_error: Option<String>,
    pub execution_error: Option<String>,
    pub applied_statements: usize,
}

#[derive(Clone, Copy)]
struct Dialect {
    sqlite: bool,
    mariadb: bool,
    no_backslash_escapes: bool,
}

fn invalid(message: impl Into<String>) -> DbError {
    DbError::QueryFailed(message.into())
}

fn identifier(value: &str, sqlite: bool) -> String {
    let quote = if sqlite { '"' } else { '`' };
    format!(
        "{quote}{}{quote}",
        value.replace(quote, &format!("{quote}{quote}"))
    )
}

fn literal(value: &str, dialect: Dialect) -> Result<String, DbError> {
    if value.contains('\0') {
        return Err(invalid("默认值、注释或触发器内容不能包含 NUL 字符"));
    }
    let value = if dialect.sqlite || dialect.no_backslash_escapes {
        value.to_string()
    } else {
        value.replace('\\', "\\\\")
    };
    Ok(format!("'{}'", value.replace('\'', "''")))
}

fn simple_name(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0')
}

fn token(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn supported_type(value: &str) -> bool {
    let value = value.trim().to_ascii_uppercase();
    let base = value
        .split(|c: char| c == '(' || c.is_ascii_whitespace())
        .next()
        .unwrap_or("");
    if !matches!(
        base,
        "TINYINT"
            | "SMALLINT"
            | "MEDIUMINT"
            | "INT"
            | "INTEGER"
            | "BIGINT"
            | "FLOAT"
            | "DOUBLE"
            | "REAL"
            | "DECIMAL"
            | "NUMERIC"
            | "BIT"
            | "BOOL"
            | "BOOLEAN"
            | "CHAR"
            | "VARCHAR"
            | "BINARY"
            | "VARBINARY"
            | "TINYTEXT"
            | "TEXT"
            | "MEDIUMTEXT"
            | "LONGTEXT"
            | "TINYBLOB"
            | "BLOB"
            | "MEDIUMBLOB"
            | "LONGBLOB"
            | "DATE"
            | "TIME"
            | "DATETIME"
            | "TIMESTAMP"
            | "YEAR"
            | "JSON"
    ) {
        return false;
    }
    let mut rest = value[base.len()..].trim();
    if rest.starts_with('(') {
        let Some(end) = rest.find(')') else {
            return false;
        };
        let args: Vec<_> = rest[1..end].split(',').collect();
        if args.is_empty()
            || args.len() > 2
            || args.iter().any(|arg| arg.trim().parse::<u32>().is_err())
        {
            return false;
        }
        rest = rest[end + 1..].trim();
    }
    rest.split_whitespace()
        .all(|word| matches!(word, "UNSIGNED" | "SIGNED" | "ZEROFILL" | "BINARY"))
}

fn timestamp_expression(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value == "current_timestamp"
        || value == "current_timestamp()"
        || value
            .strip_prefix("current_timestamp(")
            .and_then(|v| v.strip_suffix(')'))
            .and_then(|v| v.parse::<u8>().ok())
            .is_some_and(|v| v <= 6)
}

fn extra_clause(column: &ColumnDefinition) -> Result<String, DbError> {
    let extra = column
        .extra
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase()
        .replace("auto_increment", "")
        .replace("default_generated", "");
    let extra = extra.trim();
    if extra.is_empty() {
        return Ok(String::new());
    }
    if let Some(value) = extra.strip_prefix("on update ") {
        if timestamp_expression(value) {
            return Ok(format!(" {extra}"));
        }
    }
    Err(invalid(format!(
        "字段 {} 含生成列或特殊属性，请通过 SQL 修改",
        column.name
    )))
}

fn column_unchanged(column: &StructureColumn, original: &ColumnDefinition) -> bool {
    column.name == original.name
        && column.data_type == original.data_type
        && column.charset.as_ref().or(original.charset.as_ref()) == original.charset.as_ref()
        && column.collation.as_ref().or(original.collation.as_ref()) == original.collation.as_ref()
        && column.nullable == original.nullable
        && column.is_primary_key == original.is_primary_key
        && column.is_auto_increment == original.is_auto_increment
        && column.default_mode == DefaultMode::Keep
        && column.comment == original.comment.as_deref().unwrap_or("")
}

fn column_definition(
    column: &StructureColumn,
    original: Option<&ColumnDefinition>,
    dialect: Dialect,
) -> Result<String, DbError> {
    if !supported_type(&column.data_type)
        && !original.is_some_and(|old| old.data_type == column.data_type)
    {
        return Err(invalid(format!("字段 {} 的类型无效或不支持", column.name)));
    }
    if column.is_primary_key && column.nullable {
        return Err(invalid("主键字段不能允许空值"));
    }
    let mut sql = format!(
        "{} {}",
        identifier(&column.name, dialect.sqlite),
        column.data_type.trim()
    );
    if !dialect.sqlite {
        let text_type = column.data_type.to_ascii_lowercase();
        if [
            "char",
            "varchar",
            "tinytext",
            "text",
            "mediumtext",
            "longtext",
        ]
        .iter()
        .any(|prefix| text_type.starts_with(prefix))
        {
            if let Some(charset) = column
                .charset
                .as_ref()
                .or_else(|| original.and_then(|old| old.charset.as_ref()))
            {
                if !token(charset) {
                    return Err(invalid("字段字符集名称无效"));
                }
                sql.push_str(&format!(" CHARACTER SET {}", identifier(charset, false)));
            }
            if let Some(collation) = column
                .collation
                .as_ref()
                .or_else(|| original.and_then(|old| old.collation.as_ref()))
            {
                if !token(collation) {
                    return Err(invalid("字段排序规则名称无效"));
                }
                sql.push_str(&format!(" COLLATE {}", identifier(collation, false)));
            }
        }
    }
    sql.push_str(if column.nullable {
        " NULL"
    } else {
        " NOT NULL"
    });
    let default = match column.default_mode {
        DefaultMode::None => None,
        DefaultMode::Null => {
            if !column.nullable {
                return Err(invalid("非空字段不能设置 NULL 默认值"));
            }
            Some("NULL".to_string())
        }
        DefaultMode::Literal => Some(literal(
            column.default_value.as_deref().unwrap_or(""),
            dialect,
        )?),
        DefaultMode::Expression => {
            let value = column.default_value.as_deref().unwrap_or("");
            if !timestamp_expression(value) {
                return Err(invalid(
                    "默认表达式仅支持 CURRENT_TIMESTAMP 或 CURRENT_TIMESTAMP(n)",
                ));
            }
            Some(value.to_string())
        }
        DefaultMode::Keep => match original.and_then(|old| old.default_value.as_deref()) {
            None => None,
            Some(value)
                if dialect.sqlite
                    || dialect.mariadb
                    || original.is_some_and(|old| {
                        old.extra
                            .as_deref()
                            .unwrap_or("")
                            .to_ascii_lowercase()
                            .contains("default_generated")
                            || (timestamp_expression(value)
                                && ["timestamp", "datetime"].iter().any(|prefix| {
                                    old.data_type.to_ascii_lowercase().starts_with(prefix)
                                }))
                    }) =>
            {
                Some(value.to_string())
            }
            Some(value) => Some(literal(value, dialect)?),
        },
    };
    if let Some(default) = default {
        sql.push_str(&format!(" DEFAULT {default}"));
    }
    if column.is_auto_increment {
        sql.push_str(" AUTO_INCREMENT");
    }
    if let Some(old) = original {
        sql.push_str(&extra_clause(old)?);
    }
    if !dialect.sqlite {
        sql.push_str(&format!(" COMMENT {}", literal(&column.comment, dialect)?));
    }
    Ok(sql)
}

fn column_clauses(
    original: &[ColumnDefinition],
    columns: &[StructureColumn],
    dialect: Dialect,
) -> Result<Vec<String>, DbError> {
    if columns.is_empty() {
        return Err(invalid("数据表至少保留一个字段"));
    }
    let mut names = HashSet::new();
    let mut sources = HashSet::new();
    for column in columns {
        if !simple_name(&column.name) || !names.insert(column.name.to_ascii_lowercase()) {
            return Err(invalid("字段名不能为空或重复"));
        }
        if let Some(name) = &column.original_name {
            if !original.iter().any(|old| &old.name == name) || !sources.insert(name.clone()) {
                return Err(invalid("原始字段不存在或重复，请刷新结构"));
            }
        }
    }
    let retained: BTreeMap<_, _> = columns
        .iter()
        .filter_map(|column| {
            column
                .original_name
                .as_ref()
                .map(|name| (name.as_str(), column.name.as_str()))
        })
        .collect();
    let mut current_order: Vec<_> = original
        .iter()
        .filter_map(|column| retained.get(column.name.as_str()).copied())
        .collect();
    current_order.extend(
        columns
            .iter()
            .filter(|column| column.original_name.is_none())
            .map(|column| column.name.as_str()),
    );
    let desired_order: Vec<_> = columns.iter().map(|column| column.name.as_str()).collect();
    let order_changed = current_order != desired_order;
    if dialect.sqlite && order_changed {
        return Err(invalid("SQLite 暂不支持调整字段顺序"));
    }
    let primary_changed = original.iter().any(|old| {
        old.is_primary_key
            != columns
                .iter()
                .find(|c| c.original_name.as_deref() == Some(&old.name))
                .is_some_and(|c| c.is_primary_key)
    }) || columns
        .iter()
        .any(|c| c.original_name.is_none() && c.is_primary_key);
    if dialect.sqlite && primary_changed {
        return Err(invalid("SQLite 暂不支持修改主键"));
    }
    let mut clauses = Vec::new();
    if primary_changed && original.iter().any(|old| old.is_primary_key) {
        clauses.push("DROP PRIMARY KEY".into());
    }
    for old in original {
        if !sources.contains(&old.name) {
            extra_clause(old)?;
            clauses.push(format!(
                "DROP COLUMN {}",
                identifier(&old.name, dialect.sqlite)
            ));
        }
    }
    for (position, column) in columns.iter().enumerate() {
        let old = column
            .original_name
            .as_ref()
            .and_then(|name| original.iter().find(|old| &old.name == name));
        let position_clause = if !order_changed {
            String::new()
        } else if position == 0 {
            " FIRST".to_string()
        } else {
            format!(" AFTER {}", identifier(&columns[position - 1].name, false))
        };
        match old {
            Some(old) if column_unchanged(column, old) && !order_changed => {}
            Some(old) if column_unchanged(column, old) => clauses.push(format!(
                "MODIFY COLUMN {}{}",
                column_definition(column, Some(old), dialect)?,
                position_clause
            )),
            Some(old) if dialect.sqlite => {
                extra_clause(old)?;
                let mut renamed = column.clone();
                renamed.name = old.name.clone();
                if !column_unchanged(&renamed, old) {
                    return Err(invalid("SQLite 现有字段只支持重命名或删除"));
                }
                clauses.push(format!(
                    "RENAME COLUMN {} TO {}",
                    identifier(&old.name, true),
                    identifier(&column.name, true)
                ));
            }
            Some(old) => clauses.push(format!(
                "CHANGE COLUMN {} {}{}",
                identifier(&old.name, false),
                column_definition(column, Some(old), dialect)?,
                position_clause
            )),
            None => {
                if dialect.sqlite
                    && (column.is_auto_increment
                        || column.is_primary_key
                        || !column.comment.is_empty())
                {
                    return Err(invalid("SQLite 新字段不支持自增、主键或注释"));
                }
                clauses.push(format!(
                    "ADD COLUMN {}{}",
                    column_definition(column, None, dialect)?,
                    position_clause
                ));
            }
        }
    }
    if primary_changed {
        let primary: Vec<_> = columns
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| identifier(&c.name, false))
            .collect();
        if !primary.is_empty() {
            clauses.push(format!("ADD PRIMARY KEY ({})", primary.join(", ")));
        }
    }
    Ok(clauses)
}

fn validate_columns(
    columns: &[String],
    available: &HashSet<String>,
    label: &str,
) -> Result<String, DbError> {
    if columns.is_empty() {
        return Err(invalid(format!("{label}至少选择一个字段")));
    }
    let mut unique = HashSet::new();
    for column in columns {
        if !available.contains(&column.to_ascii_lowercase())
            || !unique.insert(column.to_ascii_lowercase())
        {
            return Err(invalid(format!("{label}包含不存在或重复的字段：{column}")));
        }
    }
    Ok(columns
        .iter()
        .map(|name| identifier(name, false))
        .collect::<Vec<_>>()
        .join(", "))
}

fn index_clauses(
    original: &[IndexDefinition],
    indexes: &[StructureIndex],
    available: &HashSet<String>,
    sqlite: bool,
    database: &str,
    table: &str,
) -> Result<(Vec<String>, Vec<String>), DbError> {
    let original: Vec<_> = original.iter().filter(|index| !index.is_primary).collect();
    let mut names = HashSet::new();
    let mut sources = HashSet::new();
    for index in indexes {
        if !simple_name(&index.name)
            || !names.insert(index.name.to_ascii_lowercase())
            || !index.index_type.eq_ignore_ascii_case("BTREE")
        {
            return Err(invalid("索引名称重复，或索引类型不支持"));
        }
        if let Some(name) = &index.original_name {
            if !original.iter().any(|old| &old.name == name) || !sources.insert(name.clone()) {
                return Err(invalid("原始索引不存在或重复，请刷新结构"));
            }
        }
        validate_columns(&index.columns, available, "索引")?;
    }
    let mut drops = Vec::new();
    let mut creates = Vec::new();
    for old in &original {
        let draft = indexes
            .iter()
            .find(|index| index.original_name.as_deref() == Some(&old.name));
        let changed = draft.is_some_and(|index| {
            index.name != old.name
                || index.columns != old.columns
                || index.is_unique != old.is_unique
                || !old
                    .index_type
                    .as_deref()
                    .unwrap_or("BTREE")
                    .eq_ignore_ascii_case("BTREE")
        });
        if draft.is_none() || changed {
            if !old.editable {
                return Err(invalid(format!(
                    "索引 {} 由约束或表达式生成，不能直接修改",
                    old.name
                )));
            }
            drops.push(if sqlite {
                format!(
                    "DROP INDEX {}.{}",
                    identifier(database, true),
                    identifier(&old.name, true)
                )
            } else {
                format!("DROP INDEX {}", identifier(&old.name, false))
            });
        }
    }
    for index in indexes {
        let old = index
            .original_name
            .as_ref()
            .and_then(|name| original.iter().find(|old| &old.name == name).copied());
        let changed = old.is_none_or(|old| {
            index.name != old.name
                || index.columns != old.columns
                || index.is_unique != old.is_unique
                || !old
                    .index_type
                    .as_deref()
                    .unwrap_or("BTREE")
                    .eq_ignore_ascii_case("BTREE")
        });
        if !changed {
            continue;
        }
        let columns = validate_columns(&index.columns, available, "索引")?;
        if sqlite {
            creates.push(format!(
                "CREATE {}INDEX {}.{} ON {} ({columns})",
                if index.is_unique { "UNIQUE " } else { "" },
                identifier(database, true),
                identifier(&index.name, true),
                identifier(table, true)
            ));
        } else {
            creates.push(format!(
                "ADD {}INDEX {} USING BTREE ({columns})",
                if index.is_unique { "UNIQUE " } else { "" },
                identifier(&index.name, false)
            ));
        }
    }
    Ok((drops, creates))
}

fn foreign_key_clauses(
    original: &[ForeignKeyDefinition],
    foreign_keys: &[StructureForeignKey],
    available: &HashSet<String>,
    sqlite: bool,
) -> Result<Vec<String>, DbError> {
    let expected: Vec<_> = original
        .iter()
        .map(|old| StructureForeignKey {
            original_name: Some(old.name.clone()),
            name: old.name.clone(),
            columns: old.columns.clone(),
            ref_table: old.ref_table.clone(),
            ref_columns: old.ref_columns.clone(),
            on_delete: old.on_delete.clone().unwrap_or_else(|| "RESTRICT".into()),
            on_update: old.on_update.clone().unwrap_or_else(|| "RESTRICT".into()),
            editable: old.editable,
        })
        .collect();
    if sqlite {
        if foreign_keys != expected {
            return Err(invalid("SQLite 暂不支持在结构编辑器中修改外键"));
        }
        return Ok(Vec::new());
    }
    let allowed = ["RESTRICT", "CASCADE", "SET NULL", "NO ACTION"];
    let mut names = HashSet::new();
    let mut sources = HashSet::new();
    let mut clauses = Vec::new();
    for key in foreign_keys {
        if !simple_name(&key.name)
            || !names.insert(key.name.to_ascii_lowercase())
            || !allowed.contains(&key.on_delete.as_str())
            || !allowed.contains(&key.on_update.as_str())
        {
            return Err(invalid("外键名称、删除规则或更新规则无效"));
        }
        if key.columns.len() != key.ref_columns.len() || key.ref_table.trim().is_empty() {
            return Err(invalid("外键字段与引用字段必须一一对应"));
        }
        validate_columns(&key.columns, available, "外键")?;
        if let Some(name) = &key.original_name {
            let Some(old) = original.iter().find(|old| &old.name == name) else {
                return Err(invalid("原始外键不存在，请刷新结构"));
            };
            if !old.editable {
                return Err(invalid(format!("外键 {} 当前不可编辑", old.name)));
            }
            if !sources.insert(name.clone()) {
                return Err(invalid("原始外键重复"));
            }
        }
    }
    for old in original {
        let draft = foreign_keys
            .iter()
            .find(|key| key.original_name.as_deref() == Some(&old.name));
        let expected = StructureForeignKey {
            original_name: Some(old.name.clone()),
            name: old.name.clone(),
            columns: old.columns.clone(),
            ref_table: old.ref_table.clone(),
            ref_columns: old.ref_columns.clone(),
            on_delete: old.on_delete.clone().unwrap_or_else(|| "RESTRICT".into()),
            on_update: old.on_update.clone().unwrap_or_else(|| "RESTRICT".into()),
            editable: old.editable,
        };
        if draft != Some(&expected) {
            clauses.push(format!("DROP FOREIGN KEY {}", identifier(&old.name, false)));
        }
    }
    for key in foreign_keys {
        let old = key
            .original_name
            .as_ref()
            .and_then(|name| original.iter().find(|old| &old.name == name));
        let unchanged = old.is_some_and(|old| {
            key.name == old.name
                && key.columns == old.columns
                && key.ref_table == old.ref_table
                && key.ref_columns == old.ref_columns
                && key.on_delete == old.on_delete.as_deref().unwrap_or("RESTRICT")
                && key.on_update == old.on_update.as_deref().unwrap_or("RESTRICT")
        });
        if unchanged {
            continue;
        }
        let columns = validate_columns(&key.columns, available, "外键")?;
        let refs = key
            .ref_columns
            .iter()
            .map(|name| identifier(name, false))
            .collect::<Vec<_>>()
            .join(", ");
        clauses.push(format!("ADD CONSTRAINT {} FOREIGN KEY ({columns}) REFERENCES {} ({refs}) ON DELETE {} ON UPDATE {}", identifier(&key.name, false), identifier(&key.ref_table, false), key.on_delete, key.on_update));
    }
    Ok(clauses)
}

fn advanced_clauses(
    original: &TableAdvanced,
    options: &[AdvancedOption],
    dialect: Dialect,
) -> Result<Vec<String>, DbError> {
    if dialect.sqlite {
        if options.is_empty() {
            return Ok(Vec::new());
        }
        return Err(invalid("SQLite 暂不支持高级表选项"));
    }
    let mut keys = HashSet::new();
    let mut clauses = Vec::new();
    for option in options {
        if !keys.insert(std::mem::discriminant(&option.key)) {
            return Err(invalid("高级选项不能重复"));
        }
        let clause = match option.key {
            AdvancedKey::Engine => {
                if !token(&option.value) {
                    return Err(invalid("存储引擎名称无效"));
                }
                format!("ENGINE={}", option.value)
            }
            AdvancedKey::Charset => {
                if !token(&option.value) {
                    return Err(invalid("字符集名称无效"));
                }
                format!("DEFAULT CHARACTER SET {}", option.value)
            }
            AdvancedKey::Collation => {
                if !token(&option.value) {
                    return Err(invalid("排序规则名称无效"));
                }
                format!("COLLATE {}", option.value)
            }
            AdvancedKey::Comment => format!("COMMENT={}", literal(&option.value, dialect)?),
            AdvancedKey::RowFormat => {
                let value = option.value.to_ascii_uppercase();
                if ![
                    "DEFAULT",
                    "DYNAMIC",
                    "FIXED",
                    "COMPRESSED",
                    "REDUNDANT",
                    "COMPACT",
                ]
                .contains(&value.as_str())
                {
                    return Err(invalid("行格式无效"));
                }
                format!("ROW_FORMAT={value}")
            }
            AdvancedKey::AutoIncrement => {
                let value = option
                    .value
                    .parse::<u64>()
                    .map_err(|_| invalid("自增起始值必须是正整数"))?;
                if value == 0 {
                    return Err(invalid("自增起始值必须大于 0"));
                }
                format!("AUTO_INCREMENT={value}")
            }
        };
        let unchanged = match option.key {
            AdvancedKey::Engine => original.engine.as_deref() == Some(option.value.as_str()),
            AdvancedKey::Charset => original.charset.as_deref() == Some(option.value.as_str()),
            AdvancedKey::Collation => original.collation.as_deref() == Some(option.value.as_str()),
            AdvancedKey::Comment => original.comment.as_deref().unwrap_or("") == option.value,
            AdvancedKey::RowFormat => original
                .row_format
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case(&option.value)),
            AdvancedKey::AutoIncrement => original.auto_increment == option.value.parse().ok(),
        };
        if !unchanged {
            clauses.push(clause);
        }
    }
    Ok(clauses)
}

fn trigger_statements(
    original: &[TriggerDefinition],
    triggers: &[StructureTrigger],
    database: &str,
    table: &str,
    dialect: Dialect,
) -> Result<(Vec<String>, Vec<String>), DbError> {
    let mut names = HashSet::new();
    let mut sources = HashSet::new();
    let mut drops = Vec::new();
    let mut creates = Vec::new();
    for trigger in triggers {
        if !simple_name(&trigger.name)
            || !names.insert(trigger.name.to_ascii_lowercase())
            || !["BEFORE", "AFTER"].contains(&trigger.timing.as_str())
            || !["INSERT", "UPDATE", "DELETE"].contains(&trigger.event.as_str())
            || trigger.statement.trim().is_empty()
            || trigger.statement.contains('\0')
            || trigger.statement.to_ascii_uppercase().contains("DELIMITER")
        {
            return Err(invalid("触发器名称、时机、事件或语句无效"));
        }
        if let Some(name) = &trigger.original_name {
            let Some(old) = original.iter().find(|old| &old.name == name) else {
                return Err(invalid("原始触发器不存在，请刷新结构"));
            };
            if !sources.insert(name.clone()) {
                return Err(invalid("原始触发器重复"));
            }
            let changed = trigger.name != old.name
                || trigger.timing != old.timing
                || trigger.event != old.event
                || trigger.statement != old.statement;
            if changed && !old.editable {
                return Err(invalid(format!("触发器 {} 当前只支持删除", old.name)));
            }
        }
    }
    for old in original {
        let draft = triggers
            .iter()
            .find(|trigger| trigger.original_name.as_deref() == Some(&old.name));
        let changed = draft.is_some_and(|trigger| {
            trigger.name != old.name
                || trigger.timing != old.timing
                || trigger.event != old.event
                || trigger.statement != old.statement
        });
        if draft.is_none() || changed {
            drops.push(format!(
                "DROP TRIGGER {}.{}",
                identifier(database, dialect.sqlite),
                identifier(&old.name, dialect.sqlite)
            ));
        }
    }
    for trigger in triggers {
        let old = trigger
            .original_name
            .as_ref()
            .and_then(|name| original.iter().find(|old| &old.name == name));
        let changed = old.is_none_or(|old| {
            trigger.name != old.name
                || trigger.timing != old.timing
                || trigger.event != old.event
                || trigger.statement != old.statement
        });
        if !changed {
            continue;
        }
        if dialect.sqlite {
            creates.push(format!(
                "CREATE TRIGGER {}.{} {} {} ON {} BEGIN\n{};\nEND",
                identifier(database, true),
                identifier(&trigger.name, true),
                trigger.timing,
                trigger.event,
                identifier(table, true),
                trigger.statement.trim().trim_end_matches(';')
            ));
        } else {
            creates.push(format!(
                "CREATE TRIGGER {}.{} {} {} ON {}.{} FOR EACH ROW {}",
                identifier(database, false),
                identifier(&trigger.name, false),
                trigger.timing,
                trigger.event,
                identifier(database, false),
                identifier(table, false),
                trigger.statement.trim()
            ));
        }
    }
    Ok((drops, creates))
}

fn advanced(info: &TableInfo) -> TableAdvanced {
    TableAdvanced {
        engine: info.engine.clone(),
        charset: info.charset.clone(),
        collation: info.collation.clone(),
        comment: info.comment.clone(),
        row_format: info.row_format.clone(),
        auto_increment: info.auto_increment,
    }
}

fn check_baseline(draft: &StructureDraft, info: &TableInfo) -> Result<(), DbError> {
    if draft.original_columns != info.columns
        || draft.original_indexes != info.indexes
        || draft.original_foreign_keys != info.foreign_keys
        || draft.original_triggers != info.triggers
        || draft.original_advanced != advanced(info)
    {
        return Err(invalid("表结构已被修改，请刷新结构后重新编辑"));
    }
    Ok(())
}

fn plan(
    database: &str,
    table: &str,
    info: &TableInfo,
    draft: &StructureDraft,
    dialect: Dialect,
) -> Result<Vec<String>, DbError> {
    if dialect.sqlite && database != "main" {
        return Err(invalid("SQLite 结构编辑目前只支持 main 数据库"));
    }
    let available: HashSet<_> = draft
        .columns
        .iter()
        .map(|column| column.name.to_ascii_lowercase())
        .collect();
    let columns = column_clauses(&info.columns, &draft.columns, dialect)?;
    let (index_drops, index_creates) = index_clauses(
        &info.indexes,
        &draft.indexes,
        &available,
        dialect.sqlite,
        database,
        table,
    )?;
    let foreign_keys = foreign_key_clauses(
        &info.foreign_keys,
        &draft.foreign_keys,
        &available,
        dialect.sqlite,
    )?;
    let advanced = advanced_clauses(&draft.original_advanced, &draft.advanced, dialect)?;
    let (trigger_drops, trigger_creates) =
        trigger_statements(&info.triggers, &draft.triggers, database, table, dialect)?;
    let target = format!(
        "{}.{}",
        identifier(database, dialect.sqlite),
        identifier(table, dialect.sqlite)
    );
    if dialect.sqlite {
        let mut statements = trigger_drops;
        statements.extend(index_drops);
        statements.extend(
            columns
                .into_iter()
                .map(|clause| format!("ALTER TABLE {target} {clause}")),
        );
        statements.extend(index_creates);
        statements.extend(trigger_creates);
        Ok(statements)
    } else {
        let mut clauses = columns;
        clauses.extend(index_drops);
        clauses.extend(index_creates);
        clauses.extend(foreign_keys);
        clauses.extend(advanced);
        let mut statements = Vec::new();
        if !clauses.is_empty() {
            statements.push(format!("ALTER TABLE {target}\n  {}", clauses.join(",\n  ")));
        }
        statements.extend(trigger_drops);
        statements.extend(trigger_creates);
        Ok(statements)
    }
}

fn apply_result(
    result: Result<TableInfo, DbError>,
    execution_error: Option<String>,
    applied: usize,
) -> ApplyResult {
    match result {
        Ok(info) => ApplyResult {
            table_info: Some(info),
            refresh_error: None,
            execution_error,
            applied_statements: applied,
        },
        Err(error) => ApplyResult {
            table_info: None,
            refresh_error: Some(format!(
                "结构修改已执行，但重新读取失败：{error}。请刷新，不要重复应用。"
            )),
            execution_error,
            applied_statements: applied,
        },
    }
}

pub async fn change_structure(
    handle: &(DbHandle, DbConnectionConfig),
    database: &str,
    table: &str,
    draft: StructureDraft,
    apply: bool,
) -> Result<(Vec<String>, Option<ApplyResult>), DbError> {
    match &handle.0 {
        DbHandle::Mysql(pool) => {
            let mut connection = pool
                .acquire()
                .await
                .map_err(|e| DbError::Mysql(e.to_string()))?;
            let (version, mode): (String, String) =
                sqlx::query_as("SELECT VERSION(), @@SESSION.sql_mode")
                    .fetch_one(&mut *connection)
                    .await
                    .map_err(|e| DbError::Mysql(e.to_string()))?;
            let info =
                manager::get_mysql_table_info_connection(&mut connection, database, table).await?;
            if info.engine.is_none() {
                return Err(invalid("视图不支持结构编辑"));
            }
            check_baseline(&draft, &info)?;
            let statements = plan(
                database,
                table,
                &info,
                &draft,
                Dialect {
                    sqlite: false,
                    mariadb: version.to_ascii_lowercase().contains("mariadb"),
                    no_backslash_escapes: mode
                        .split(',')
                        .any(|m| m.eq_ignore_ascii_case("NO_BACKSLASH_ESCAPES")),
                },
            )?;
            if !apply {
                return Ok((statements, None));
            }
            let mut applied = 0;
            for sql in &statements {
                if let Err(error) = sqlx::query(sql).execute(&mut *connection).await {
                    if applied == 0 {
                        return Err(DbError::Mysql(error.to_string()));
                    }
                    let refreshed =
                        manager::get_mysql_table_info_connection(&mut connection, database, table)
                            .await;
                    return Ok((
                        statements,
                        Some(apply_result(
                            refreshed,
                            Some(format!("已执行 {applied} 条结构语句，后续失败：{error}")),
                            applied,
                        )),
                    ));
                }
                applied += 1;
            }
            let refreshed =
                manager::get_mysql_table_info_connection(&mut connection, database, table).await;
            Ok((statements, Some(apply_result(refreshed, None, applied))))
        }
        DbHandle::Sqlite(shared) => {
            let info = manager::get_table_info_on_handle(handle, database, table).await?;
            check_baseline(&draft, &info)?;
            let statements = plan(
                database,
                table,
                &info,
                &draft,
                Dialect {
                    sqlite: true,
                    mariadb: false,
                    no_backslash_escapes: true,
                },
            )?;
            if !apply {
                return Ok((statements, None));
            }
            let shared = shared.clone();
            let table_owned = table.to_string();
            let execute = statements.clone();
            let expected_ddl = info.ddl.clone();
            tokio::task::spawn_blocking(move || -> Result<(), DbError> {
                let mut connection = shared.lock().map_err(|e| invalid(e.to_string()))?;
                let transaction = connection.transaction()?;
                let (kind, ddl): (String, Option<String>) = transaction.query_row(
                    "SELECT type, sql FROM sqlite_master WHERE name=?",
                    [&table_owned],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                if kind != "table" {
                    return Err(invalid("视图不支持结构编辑"));
                }
                if ddl != expected_ddl {
                    return Err(invalid("表结构已被修改，请刷新后重试"));
                }
                for sql in execute {
                    transaction.execute_batch(&sql)?;
                }
                transaction.commit()?;
                Ok(())
            })
            .await
            .map_err(|e| invalid(e.to_string()))??;
            let refreshed = manager::get_table_info_on_handle(handle, database, table).await;
            Ok((
                statements.clone(),
                Some(apply_result(refreshed, None, statements.len())),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn sqlite() -> (DbHandle, DbConnectionConfig) {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, legacy TEXT); INSERT INTO items VALUES (1,'Ada','old'); CREATE INDEX idx_name ON items(name);").unwrap();
        let config = serde_json::from_value(serde_json::json!({"id":"test","name":"test","db_type":"sqlite","host":":memory:","port":0,"username":"","password":"","database":null,"use_ssl":false,"use_ssh_tunnel":false,"ssh_host":null,"ssh_port":null,"ssh_username":null,"ssh_auth":null})).unwrap();
        (DbHandle::Sqlite(Arc::new(Mutex::new(connection))), config)
    }

    fn draft(info: &TableInfo) -> StructureDraft {
        StructureDraft {
            original_columns: info.columns.clone(),
            columns: info
                .columns
                .iter()
                .map(|column| StructureColumn {
                    original_name: Some(column.name.clone()),
                    name: column.name.clone(),
                    data_type: column.data_type.clone(),
                    charset: column.charset.clone(),
                    collation: column.collation.clone(),
                    nullable: column.nullable,
                    is_primary_key: column.is_primary_key,
                    is_auto_increment: column.is_auto_increment,
                    default_mode: DefaultMode::Keep,
                    default_value: column.default_value.clone(),
                    comment: column.comment.clone().unwrap_or_default(),
                })
                .collect(),
            original_indexes: info.indexes.clone(),
            indexes: info
                .indexes
                .iter()
                .filter(|index| !index.is_primary)
                .map(|index| StructureIndex {
                    original_name: Some(index.name.clone()),
                    name: index.name.clone(),
                    columns: index.columns.clone(),
                    is_unique: index.is_unique,
                    index_type: "BTREE".into(),
                    editable: index.editable,
                })
                .collect(),
            original_foreign_keys: info.foreign_keys.clone(),
            foreign_keys: info
                .foreign_keys
                .iter()
                .map(|key| StructureForeignKey {
                    original_name: Some(key.name.clone()),
                    name: key.name.clone(),
                    columns: key.columns.clone(),
                    ref_table: key.ref_table.clone(),
                    ref_columns: key.ref_columns.clone(),
                    on_delete: key.on_delete.clone().unwrap_or_else(|| "RESTRICT".into()),
                    on_update: key.on_update.clone().unwrap_or_else(|| "RESTRICT".into()),
                    editable: key.editable,
                })
                .collect(),
            original_triggers: info.triggers.clone(),
            triggers: info
                .triggers
                .iter()
                .map(|trigger| StructureTrigger {
                    original_name: Some(trigger.name.clone()),
                    name: trigger.name.clone(),
                    timing: trigger.timing.clone(),
                    event: trigger.event.clone(),
                    statement: trigger.statement.clone(),
                    editable: trigger.editable,
                })
                .collect(),
            original_advanced: advanced(info),
            advanced: Vec::new(),
            section: "columns".into(),
        }
    }

    #[tokio::test]
    async fn sqlite_applies_columns_indexes_and_triggers_in_one_transaction() {
        let handle = sqlite();
        let info = manager::get_table_info_on_handle(&handle, "main", "items")
            .await
            .unwrap();
        let mut draft = draft(&info);
        draft.columns[1].name = "label".into();
        draft.columns.remove(2);
        draft.indexes[0].name = "idx_label".into();
        draft.indexes[0].columns = vec!["label".into()];
        draft.triggers.push(StructureTrigger {
            original_name: None,
            name: "items_after_update".into(),
            timing: "AFTER".into(),
            event: "UPDATE".into(),
            statement: "UPDATE items SET label = NEW.label WHERE id = NEW.id".into(),
            editable: true,
        });
        let (preview, none) = change_structure(&handle, "main", "items", draft.clone(), false)
            .await
            .unwrap();
        assert!(none.is_none());
        assert!(preview.len() >= 4);
        let (_, result) = change_structure(&handle, "main", "items", draft, true)
            .await
            .unwrap();
        let updated = result.unwrap().table_info.unwrap();
        assert_eq!(
            updated
                .columns
                .iter()
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>(),
            ["id", "label"]
        );
        assert!(updated
            .indexes
            .iter()
            .any(|index| index.name == "idx_label"));
        assert!(updated
            .triggers
            .iter()
            .any(|trigger| trigger.name == "items_after_update"));
    }

    #[tokio::test]
    async fn sqlite_rolls_back_all_sections_on_failure() {
        let handle = sqlite();
        let info = manager::get_table_info_on_handle(&handle, "main", "items")
            .await
            .unwrap();
        let mut draft = draft(&info);
        draft.columns[1].name = "label".into();
        draft.indexes.push(StructureIndex {
            original_name: None,
            name: "bad_index".into(),
            columns: vec!["missing".into()],
            is_unique: false,
            index_type: "BTREE".into(),
            editable: true,
        });
        assert!(change_structure(&handle, "main", "items", draft, true)
            .await
            .is_err());
        assert_eq!(
            manager::get_table_info_on_handle(&handle, "main", "items")
                .await
                .unwrap()
                .columns,
            info.columns
        );
    }

    #[tokio::test]
    async fn sqlite_rejects_field_reordering_without_touching_the_table() {
        let handle = sqlite();
        let info = manager::get_table_info_on_handle(&handle, "main", "items")
            .await
            .unwrap();
        let mut draft = draft(&info);
        draft.columns.swap(0, 1);
        let error = change_structure(&handle, "main", "items", draft, true)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("字段顺序"));
        assert_eq!(
            manager::get_table_info_on_handle(&handle, "main", "items")
                .await
                .unwrap()
                .columns,
            info.columns
        );
    }

    #[tokio::test]
    async fn sqlite_reads_foreign_keys_and_marks_constraint_indexes_read_only() {
        let handle = sqlite();
        if let DbHandle::Sqlite(connection) = &handle.0 {
            connection
                .lock()
                .unwrap()
                .execute_batch(
                    "CREATE TABLE parent (id INTEGER PRIMARY KEY); \
                 CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER UNIQUE, \
                   FOREIGN KEY(parent_id) REFERENCES parent(id) ON DELETE CASCADE);",
                )
                .unwrap();
        }
        let info = manager::get_table_info_on_handle(&handle, "main", "child")
            .await
            .unwrap();
        assert_eq!(info.foreign_keys.len(), 1);
        assert_eq!(info.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
        assert!(!info.foreign_keys[0].editable);
        assert!(info
            .indexes
            .iter()
            .any(|index| index.is_unique && !index.editable));
    }

    #[tokio::test]
    async fn rejects_a_stale_index_or_trigger_snapshot() {
        let handle = sqlite();
        let info = manager::get_table_info_on_handle(&handle, "main", "items")
            .await
            .unwrap();
        let draft = draft(&info);
        if let DbHandle::Sqlite(connection) = &handle.0 {
            connection
                .lock()
                .unwrap()
                .execute_batch("CREATE INDEX idx_legacy ON items(legacy)")
                .unwrap();
        }
        let error = change_structure(&handle, "main", "items", draft, false)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("已被修改"));
    }

    #[test]
    fn accepts_the_frontend_camel_case_draft_contract() {
        let draft: StructureDraft = serde_json::from_value(serde_json::json!({
            "originalColumns": [], "columns": [], "originalIndexes": [], "indexes": [],
            "originalForeignKeys": [], "foreignKeys": [], "originalTriggers": [], "triggers": [],
            "originalAdvanced": {"engine": null, "charset": null, "collation": null, "comment": null, "row_format": null, "auto_increment": null},
            "advanced": [], "section": "indexes"
        })).unwrap();
        assert_eq!(draft.section, "indexes");
    }

    #[test]
    fn mysql_plan_contains_all_editable_sections_and_rejects_injection() {
        let info = TableInfo {
            name: "users".into(),
            schema: Some("app".into()),
            engine: Some("InnoDB".into()),
            charset: Some("utf8mb4".into()),
            collation: Some("utf8mb4_unicode_ci".into()),
            row_count: Some(1),
            data_size: None,
            index_size: None,
            auto_increment: Some(2),
            create_time: None,
            update_time: None,
            columns: vec![ColumnDefinition {
                name: "id".into(),
                data_type: "bigint".into(),
                nullable: false,
                default_value: None,
                is_primary_key: true,
                is_unique: false,
                is_auto_increment: true,
                extra: Some("auto_increment".into()),
                comment: None,
                charset: None,
                collation: None,
            }],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            comment: Some(String::new()),
            row_format: Some("Dynamic".into()),
            ddl: None,
        };
        let mut changes = draft(&info);
        changes.indexes.push(StructureIndex {
            original_name: None,
            name: "idx_id".into(),
            columns: vec!["id".into()],
            is_unique: false,
            index_type: "BTREE".into(),
            editable: true,
        });
        changes.foreign_keys.push(StructureForeignKey {
            original_name: None,
            name: "fk_id".into(),
            columns: vec!["id".into()],
            ref_table: "parent".into(),
            ref_columns: vec!["id".into()],
            on_delete: "CASCADE".into(),
            on_update: "RESTRICT".into(),
            editable: true,
        });
        changes.triggers.push(StructureTrigger {
            original_name: None,
            name: "audit".into(),
            timing: "AFTER".into(),
            event: "INSERT".into(),
            statement: "SET @seen = NEW.id".into(),
            editable: true,
        });
        changes.advanced.push(AdvancedOption {
            key: AdvancedKey::Comment,
            value: "users table".into(),
        });
        let statements = plan(
            "app",
            "users",
            &info,
            &changes,
            Dialect {
                sqlite: false,
                mariadb: false,
                no_backslash_escapes: true,
            },
        )
        .unwrap();
        assert!(
            statements[0].contains("ADD INDEX `idx_id`")
                && statements[0].contains("ADD CONSTRAINT `fk_id`")
                && statements[0].contains("COMMENT='users table'")
        );
        assert!(statements[1].contains("CREATE TRIGGER"));
        changes.indexes[0].name = "idx`, DROP TABLE users --".into();
        assert!(plan(
            "app",
            "users",
            &info,
            &changes,
            Dialect {
                sqlite: false,
                mariadb: false,
                no_backslash_escapes: true
            }
        )
        .is_ok());
        changes.indexes[0].index_type = "BTREE); DROP TABLE users".into();
        assert!(plan(
            "app",
            "users",
            &info,
            &changes,
            Dialect {
                sqlite: false,
                mariadb: false,
                no_backslash_escapes: true
            }
        )
        .is_err());

        let mut reordered = draft(&info);
        reordered.columns.push(StructureColumn {
            original_name: None,
            name: "display_name".into(),
            data_type: "varchar(32)".into(),
            charset: Some("utf8mb4".into()),
            collation: Some("utf8mb4_unicode_ci".into()),
            nullable: true,
            is_primary_key: false,
            is_auto_increment: false,
            default_mode: DefaultMode::None,
            default_value: None,
            comment: String::new(),
        });
        reordered.columns.swap(0, 1);
        let sql = plan(
            "app",
            "users",
            &info,
            &reordered,
            Dialect {
                sqlite: false,
                mariadb: false,
                no_backslash_escapes: true,
            },
        )
        .unwrap()
        .remove(0);
        assert!(sql.contains("ADD COLUMN `display_name` varchar(32) CHARACTER SET `utf8mb4` COLLATE `utf8mb4_unicode_ci` NULL COMMENT '' FIRST"));
        assert!(sql.contains(
            "MODIFY COLUMN `id` bigint NOT NULL AUTO_INCREMENT COMMENT '' AFTER `display_name`"
        ));
    }
}
