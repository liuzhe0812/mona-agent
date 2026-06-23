import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { createFolder } from "./lib/emailApi";
import type { EmailAccount } from "./lib/types";

interface NewFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: EmailAccount | null;
  gatewayUrl: string;
  onCreated?: (account: EmailAccount) => void;
}

export function NewFolderDialog({
  open,
  onOpenChange,
  account,
  gatewayUrl,
  onCreated,
}: NewFolderDialogProps) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account || !gatewayUrl || !name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createFolder(gatewayUrl, account, name.trim());
      setName("");
      onOpenChange(false);
      onCreated?.(account);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setName("");
        setError(null);
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">新建文件夹</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="folder-name" className="text-[12px]">
              文件夹名称
            </Label>
            <Input
              id="folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="请输入文件夹名称"
              className="h-8 text-[13px]"
              autoFocus
              disabled={submitting}
            />
          </div>
          {error ? (
            <div className="text-[12px] text-destructive">{error}</div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              className="h-8 text-[12px]"
              disabled={submitting || !name.trim()}
            >
              {submitting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              确定
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
