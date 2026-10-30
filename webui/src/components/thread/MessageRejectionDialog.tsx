import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function MessageRejectionDialog({
  rejection,
  onDismiss,
}: {
  rejection: { runActive: boolean; uncertain?: boolean; stopOutcome?: "unknown" | "unsupported" } | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const title = rejection?.stopOutcome
    ? `errors.workStop.${rejection.stopOutcome}Title`
    : rejection?.uncertain ? "errors.messageRejected.unknownTitle" : "errors.messageRejected.title";
  const body = rejection?.stopOutcome
    ? `errors.workStop.${rejection.stopOutcome}Body`
    : rejection?.uncertain ? "errors.messageRejected.unknownBody" : rejection?.runActive ? "errors.messageRejected.runActiveBody" : "errors.messageRejected.body";
  return (
    <AlertDialog open={rejection !== null} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(body)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.dismiss")}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
