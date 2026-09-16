import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/select";
import { StatusNotice } from "@/components/ui/status-notice";
import { dbExecuteQuery } from "./ipc";
import { useDbStore } from "./store/dbStore";
import { quoteIdentifier, textLiteral } from "./table-sql";
import { displayCellValue, type CellValue, type QueryResult } from "./types";

export interface DatabaseSettingsDialogProps {
  connectionId: string;
  database?: string;
  onClose: () => void;
  onSaved: (database: string) => void;
}

interface CharsetInfo {
  name: string;
  defaultCollation: string | null;
}

interface CollationInfo {
  name: string;
  charset: string | null;
  isDefault: boolean;
}

interface DatabaseMetadata {
  charsets: CharsetInfo[];
  collations: CollationInfo[];
  currentCharset: string | null;
  currentCollation: string | null;
}

function normalizedColumnName(name: string): string {
  return name.toLocaleLowerCase().replace(/[\s_-]/g, "");
}

function findColumn(result: QueryResult, names: string[], fallback: number): number {
  const wanted = new Set(names.map(normalizedColumnName));
  const index = result.columns.findIndex((column) => wanted.has(normalizedColumnName(column.name)));
  return index >= 0 ? index : fallback;
}

function cellText(cell: CellValue | undefined): string | null {
  if (!cell || cell.type === "null") return null;
  return displayCellValue(cell);
}

function uniqueByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

function isDefaultValue(value: string | null): boolean {
  if (!value) return false;
  return ["1", "yes", "true", "y"].includes(value.trim().toLocaleLowerCase());
}

function parseMetadata(
  charsetResult: QueryResult,
  collationResult: QueryResult,
  schemaResult: QueryResult | null,
  editing: boolean,
): DatabaseMetadata {
  const charsetIndex = findColumn(charsetResult, ["charset", "character_set_name"], 0);
  const charsetDefaultIndex = findColumn(
    charsetResult,
    ["default collation", "default_collation_name"],
    2,
  );
  const charsetRows = charsetResult.rows
    .map((row) => {
      const name = cellText(row[charsetIndex]);
      if (!name) return null;
      return {
        name,
        defaultCollation: cellText(row[charsetDefaultIndex]),
      };
    })
    .filter((item): item is CharsetInfo => item !== null);

  const collationIndex = findColumn(collationResult, ["collation", "collation_name"], 0);
  const collationCharsetIndex = findColumn(
    collationResult,
    ["charset", "character_set_name"],
    1,
  );
  const collationDefaultIndex = findColumn(collationResult, ["default"], 3);
  const collations = collationResult.rows
    .map((row) => {
      const name = cellText(row[collationIndex]);
      if (!name) return null;
      return {
        name,
        charset: cellText(row[collationCharsetIndex]),
        isDefault: isDefaultValue(cellText(row[collationDefaultIndex])),
      };
    })
    .filter((item): item is CollationInfo => item !== null);

  let currentCharset: string | null = null;
  let currentCollation: string | null = null;
  if (editing) {
    if (!schemaResult?.rows[0]) throw new Error("未读取到数据库当前默认设置，数据库可能已被删除。");
    const schemaCharsetIndex = findColumn(
      schemaResult,
      ["default_character_set_name", "character_set_name"],
      0,
    );
    const schemaCollationIndex = findColumn(
      schemaResult,
      ["default_collation_name", "collation_name"],
      1,
    );
    currentCharset = cellText(schemaResult.rows[0][schemaCharsetIndex]);
    currentCollation = cellText(schemaResult.rows[0][schemaCollationIndex]);
    if (!currentCharset || !currentCollation) {
      throw new Error("未读取到数据库当前默认字符集或排序规则。");
    }
  }

  if (charsetRows.length === 0 || collations.length === 0) {
    throw new Error("服务器没有返回可用的字符集和排序规则。");
  }

  return {
    charsets: uniqueByName(charsetRows),
    collations: uniqueByName(collations),
    currentCharset,
    currentCollation,
  };
}

function getErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function DatabaseSettingsDialog({
  connectionId,
  database,
  onClose,
  onSaved,
}: DatabaseSettingsDialogProps) {
  const connection = useDbStore((state) => state.activeConnections.find((item) => item.id === connectionId));
  const connectionStatus = connection?.status;
  const databaseType = connection?.config.db_type;
  const editing = database !== undefined;
  const mountedRef = useRef(true);
  const [name, setName] = useState(database ?? "");
  const [charset, setCharset] = useState("");
  const [collation, setCollation] = useState("");
  const [metadata, setMetadata] = useState<DatabaseMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    let active = true;
    setName(database ?? "");
    setCharset("");
    setCollation("");
    setMetadata(null);
    setSaveError(null);
    setLoadError(null);

    if (!connection || connectionStatus !== "connected") {
      setLoading(false);
      setLoadError("连接已断开，请重新连接后重试。");
      return () => {
        active = false;
      };
    }
    if (databaseType !== "mysql") {
      setLoading(false);
      setLoadError("数据库设置目前仅支持 MySQL / MariaDB 连接。");
      return () => {
        active = false;
      };
    }

    setLoading(true);
    const requests = [
      dbExecuteQuery(connectionId, "SHOW CHARACTER SET"),
      dbExecuteQuery(connectionId, "SHOW COLLATION"),
    ];
    if (editing) {
      requests.push(
        dbExecuteQuery(
          connectionId,
          `SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${textLiteral(database, false)}`,
        ),
      );
    }

    void Promise.all(requests)
      .then((results) => {
        if (!active || !mountedRef.current) return;
        const parsed = parseMetadata(
          results[0],
          results[1],
          editing ? results[2] : null,
          editing,
        );
        setMetadata(parsed);
        if (editing) {
          setCharset(parsed.currentCharset ?? "");
          setCollation(parsed.currentCollation ?? "");
        } else {
          const initialCharset =
            parsed.charsets.find((item) => item.name.toLocaleLowerCase() === "utf8mb4") ?? parsed.charsets[0];
          setCharset(initialCharset.name);
          const defaultCollation = initialCharset.defaultCollation ??
            parsed.collations.find((item) => item.charset === initialCharset.name && item.isDefault)?.name ??
            parsed.collations.find((item) => item.charset === initialCharset.name)?.name ??
            parsed.collations[0]?.name ?? "";
          setCollation(defaultCollation);
        }
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active || !mountedRef.current) return;
        setMetadata(null);
        setLoading(false);
        setLoadError(getErrorMessage(reason));
      });

    return () => {
      active = false;
    };
  }, [connectionId, connectionStatus, database, databaseType, editing]);

  const charsetOptions = useMemo<SelectOption[]>(
    () => metadata?.charsets.map((item) => ({ value: item.name, label: item.name })) ?? [],
    [metadata],
  );
  const collationOptions = useMemo<SelectOption[]>(
    () => metadata?.collations
      .filter((item) => !item.charset || !charset || item.charset === charset)
      .map((item) => ({ value: item.name, label: item.name })) ?? [],
    [charset, metadata],
  );
  const connectedMySql = connectionStatus === "connected" && databaseType === "mysql";
  const validName = (editing ? database ?? "" : name).trim().length > 0;
  const validCharset = !!metadata?.charsets.some((item) => item.name === charset);
  const validCollation = !!metadata?.collations.some(
    (item) => item.name === collation && (!item.charset || item.charset === charset),
  );
  const canSubmit = connectedMySql && !loading && !loadError && validName && validCharset && validCollation;

  function handleCharsetChange(value: string) {
    setCharset(value);
    const selected = metadata?.charsets.find((item) => item.name === value);
    const defaultCollation = selected?.defaultCollation ??
      metadata?.collations.find((item) => item.charset === value && item.isDefault)?.name ??
      metadata?.collations.find((item) => item.charset === value)?.name ??
      "";
    setCollation(defaultCollation);
  }

  async function handleSubmit() {
    if (!canSubmit || saving || savingRef.current || !mountedRef.current) return;
    const targetName = editing ? database ?? "" : name.trim();
    const sql = editing
      ? `ALTER DATABASE ${quoteIdentifier(targetName, false)} CHARACTER SET ${quoteIdentifier(charset, false)} COLLATE ${quoteIdentifier(collation, false)}`
      : `CREATE DATABASE ${quoteIdentifier(targetName, false)} CHARACTER SET ${quoteIdentifier(charset, false)} COLLATE ${quoteIdentifier(collation, false)}`;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await dbExecuteQuery(connectionId, sql);
      if (!mountedRef.current) return;
      onSaved(targetName);
      onClose();
    } catch (reason) {
      if (mountedRef.current) setSaveError(getErrorMessage(reason));
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !saving) onClose();
    }}>
      <DialogContent className="max-w-md">
        <form onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}>
          <DialogHeader>
            <DialogTitle>{editing ? "编辑数据库" : "新建数据库"}</DialogTitle>
            <DialogDescription>
              默认字符集和排序规则只影响新建对象，不会转换已有表数据。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <label className="grid gap-2 text-body font-medium text-muted-foreground">
              数据库名称
              <Input
                autoFocus={!editing}
                aria-label="数据库名称"
                value={editing ? database ?? "" : name}
                readOnly={editing}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-body font-medium text-muted-foreground">
              字符集
              <Select
                aria-label="字符集"
                value={charset}
                options={charsetOptions}
                disabled={loading || saving || !metadata}
                onValueChange={handleCharsetChange}
              />
            </label>
            <label className="grid gap-2 text-body font-medium text-muted-foreground">
              排序规则
              <Select
                aria-label="排序规则"
                value={collation}
                options={collationOptions}
                disabled={loading || saving || !metadata}
                onValueChange={setCollation}
              />
            </label>
            {loading && <p role="status" className="text-caption text-muted-foreground">正在读取服务器字符集和排序规则…</p>}
            {loadError && <StatusNotice tone="danger">{loadError}</StatusNotice>}
            {saveError && <StatusNotice tone="danger">保存失败：{saveError}</StatusNotice>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={!canSubmit || saving}>
              {saving ? (editing ? "保存中…" : "创建中…") : (editing ? "保存" : "创建")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
