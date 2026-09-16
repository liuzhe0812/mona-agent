import type { ColumnDefinition, ForeignKeyDefinition, IndexDefinition, QueryTab, StructureColumn, StructureForeignKey, StructureIndex, StructureTrigger, TableAdvanced, TableInfo, TriggerDefinition } from "./types";

export function structureColumn(column: ColumnDefinition): StructureColumn {
  return { original_name: column.name, name: column.name, data_type: column.data_type,
    charset: column.charset ?? null, collation: column.collation ?? null,
    nullable: column.nullable, is_primary_key: column.is_primary_key, is_auto_increment: column.is_auto_increment,
    default_mode: "keep", default_value: column.default_value, comment: column.comment ?? "" };
}

export function hasStructureChanges(tab: QueryTab): boolean {
  if (!tab.structure) return false;
  const structure = tab.structure;
  return JSON.stringify(structure.columns) !== JSON.stringify(structure.originalColumns.map(structureColumn))
    || JSON.stringify(structure.indexes) !== JSON.stringify(structure.originalIndexes.filter((index) => !index.is_primary).map(structureIndex))
    || JSON.stringify(structure.foreignKeys) !== JSON.stringify(structure.originalForeignKeys.map(structureForeignKey))
    || JSON.stringify(structure.triggers) !== JSON.stringify(structure.originalTriggers.map(structureTrigger))
    || structure.advanced.some((option) => String(structure.originalAdvanced[option.key] ?? "") !== option.value);
}

export function structureIndex(index: IndexDefinition): StructureIndex {
  return { original_name: index.name, name: index.name, columns: index.columns, is_unique: index.is_unique,
    index_type: "BTREE", editable: index.editable !== false && !index.is_primary };
}

function referenceAction(value: string | null): StructureForeignKey["on_delete"] {
  const normalized = value?.toUpperCase();
  return normalized === "CASCADE" || normalized === "SET NULL" || normalized === "NO ACTION" ? normalized : "RESTRICT";
}

export function structureForeignKey(key: ForeignKeyDefinition): StructureForeignKey {
  return { original_name: key.name, name: key.name, columns: key.columns, ref_table: key.ref_table, ref_columns: key.ref_columns,
    on_delete: referenceAction(key.on_delete), on_update: referenceAction(key.on_update), editable: key.editable !== false };
}

export function structureTrigger(trigger: TriggerDefinition): StructureTrigger {
  return { original_name: trigger.name, name: trigger.name, timing: trigger.timing === "BEFORE" ? "BEFORE" : "AFTER",
    event: trigger.event === "UPDATE" || trigger.event === "DELETE" ? trigger.event : "INSERT",
    statement: trigger.statement, editable: trigger.editable };
}

export function tableAdvanced(info: TableInfo): TableAdvanced {
  return { engine: info.engine, charset: info.charset, collation: info.collation, comment: info.comment ?? null,
    row_format: info.row_format ?? null, auto_increment: info.auto_increment };
}

export function isStructureColumnReadOnly(column: ColumnDefinition): boolean {
  return (column.extra ?? "").replace(/auto_increment|default_generated|on update current_timestamp(?:\(\d*\))?/gi, "").trim() !== "";
}
