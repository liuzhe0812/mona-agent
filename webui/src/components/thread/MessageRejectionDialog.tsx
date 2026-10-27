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
  rejection: { runActive: boolean } | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={rejection !== null} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("errors.messageRejected.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(rejection?.runActive ? "errors.messageRejected.runActiveBody" : "errors.messageRejected.body")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.dismiss")}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
