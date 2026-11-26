import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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

interface RenameChatDialogProps {
  open: boolean;
  title: string;
  partnerAlias?: boolean;
  onCancel: () => void;
  onConfirm: (title: string) => void;
}

export function RenameChatDialog({
  open,
  title,
  partnerAlias = false,
  onCancel,
  onConfirm,
}: RenameChatDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(title);

  useEffect(() => {
    if (open) setValue(title);
  }, [open, title]);

  const trimmed = value.trim();

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) onCancel();
    }}>
      <DialogContent className="max-w-sm rounded-2xl border-border/70 bg-popover p-5 shadow-lg">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed && !partnerAlias) return;
            onConfirm(trimmed);
          }}
        >
          <DialogHeader className="text-left">
            <DialogTitle>{t(partnerAlias ? "sidebar.partnerAlias" : "chat.renameTitle")}</DialogTitle>
            <DialogDescription>
              {t(partnerAlias ? "sidebar.partnerAliasDescription" : "chat.renameDescription")}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t(partnerAlias ? "sidebar.partnerAliasPlaceholder" : "chat.renamePlaceholder")}
            autoFocus
            maxLength={160}
          />
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button type="button" variant="outline" onClick={onCancel}>
              {t("deleteConfirm.cancel")}
            </Button>
            <Button type="submit" disabled={!trimmed && !partnerAlias}>
              {t("chat.renameSave")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
