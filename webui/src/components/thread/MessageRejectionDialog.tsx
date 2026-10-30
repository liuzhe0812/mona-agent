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
  rejection: { runActive: boolean; uncertain?: boolean } | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={rejection !== null} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(rejection?.uncertain ? "errors.messageRejected.unknownTitle" : "errors.messageRejected.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(rejection?.uncertain ? "errors.messageRejected.unknownBody" : rejection?.runActive ? "errors.messageRejected.runActiveBody" : "errors.messageRejected.body")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.dismiss")}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
