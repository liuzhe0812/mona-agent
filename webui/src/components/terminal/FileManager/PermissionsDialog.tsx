import { useEffect, useState } from "react";
import { sftpChmod } from "../ipc";
import { type UnifiedFileItem } from "./FilePane";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: UnifiedFileItem | null;
  sessionId: string;
  onRefresh: () => void;
}

const ROWS = [
  { key: "owner", label: "Owner" },
  { key: "group", label: "Group" },
  { key: "others", label: "Others" },
] as const;

const COLS = [
  { key: "read", label: "Read", bit: 4 },
  { key: "write", label: "Write", bit: 2 },
  { key: "execute", label: "Execute", bit: 1 },
] as const;

type PermKey = "owner" | "group" | "others";
type PermBits = Record<PermKey, number>;

function modeToBits(mode: number): PermBits {
  return {
    owner: (mode >> 6) & 7,
    group: (mode >> 3) & 7,
    others: mode & 7,
  };
}

function bitsToMode(bits: PermBits): number {
  return ((bits.owner << 6) | (bits.group << 3) | bits.others) & 0o777;
}

export function PermissionsDialog({
  open,
  onOpenChange,
  file,
  sessionId,
  onRefresh,
}: Props) {
  const [bits, setBits] = useState<PermBits>({ owner: 6, group: 4, others: 4 });
  const [octalInput, setOctalInput] = useState("644");
  const [recursive, setRecursive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !file) return;
    const defaultMode = file.isDir ? 0o755 : 0o644;
    const b = modeToBits(defaultMode);
    setBits(b);
    setOctalInput(defaultMode.toString(8).padStart(3, "0"));
    setRecursive(false);
    setError(null);
  }, [open, file]);

  useEffect(() => {
    const mode = bitsToMode(bits);
    setOctalInput(mode.toString(8).padStart(3, "0"));
  }, [bits]);

  function toggleBit(row: PermKey, bit: number) {
    setBits((prev) => ({
      ...prev,
      [row]: prev[row] ^ bit,
    }));
  }

  function handleOctalChange(value: string) {
    setOctalInput(value);
    const parsed = parseInt(value, 8);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 0o777 && /^[0-7]{3}$/.test(value)) {
      setBits(modeToBits(parsed));
    }
  }

  async function handleSave() {
    if (!file) return;
    const mode = bitsToMode(bits);
    setSaving(true);
    setError(null);
    try {
      await sftpChmod(sessionId, file.path, mode);
      onRefresh();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>修改权限 — {file?.name}</DialogTitle>
          <DialogDescription>设置文件权限</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="w-24 text-left font-medium" />
                {COLS.map((col) => (
                  <th key={col.key} className="text-center font-medium">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.key}>
                  <td className="py-1 font-medium">{row.label}</td>
                  {COLS.map((col) => (
                    <td key={col.key} className="text-center py-1">
                      <Checkbox
                        checked={(bits[row.key] & col.bit) !== 0}
                        onCheckedChange={() => toggleBit(row.key, col.bit)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">八进制权限</span>
            <input
              type="text"
              value={octalInput}
              onChange={(e) => handleOctalChange(e.target.value)}
              maxLength={3}
              className="h-8 w-20 rounded-md border bg-background px-2 text-sm font-mono"
            />
          </div>

          {file?.isDir && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={recursive}
                onCheckedChange={(v) => setRecursive(v === true)}
              />
              递归应用
            </label>
          )}

          {error && (
            <div className="text-sm text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "保存中…" : "确定"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
