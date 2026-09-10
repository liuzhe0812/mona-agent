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
import { Textarea } from "@/components/ui/textarea";

export interface CustomExpertInput {
  displayName: string;
  description: string;
  instructions: string;
}

interface CustomExpertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: CustomExpertInput) => Promise<void>;
}

export function CustomExpertDialog({
  open,
  onOpenChange,
  onSubmit,
}: CustomExpertDialogProps) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setDisplayName("");
      setDescription("");
      setInstructions("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    if (!displayName.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        displayName: displayName.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
      });
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("experts.customCreateError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("experts.customTitle")}</DialogTitle>
          <DialogDescription>{t("experts.customDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="custom-expert-name">
              {t("experts.customName")}
            </label>
            <Input
              id="custom-expert-name"
              value={displayName}
              maxLength={80}
              autoFocus
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={t("experts.customNamePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="custom-expert-description">
              {t("experts.customExpertise")}
            </label>
            <Input
              id="custom-expert-description"
              value={description}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("experts.customExpertisePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="custom-expert-instructions">
              {t("experts.customInstructions")}
            </label>
            <Textarea
              id="custom-expert-instructions"
              value={instructions}
              maxLength={20_000}
              rows={7}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t("experts.customInstructionsPlaceholder")}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("experts.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={!displayName.trim() || saving}>
            {saving ? t("experts.customCreating") : t("experts.customCreateAndSummon")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
