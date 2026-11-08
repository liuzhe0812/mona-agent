import { useTranslation } from "react-i18next";
import type { MessageAdmissionReason } from "@/lib/mona-client";

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
  rejection: { runActive: boolean; uncertain?: boolean; stopOutcome?: "unknown" | "unsupported"; reason?: MessageAdmissionReason } | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const title = rejection?.stopOutcome
    ? `errors.workStop.${rejection.stopOutcome}Title`
    : rejection?.uncertain ? "errors.messageRejected.unknownTitle" : "errors.messageRejected.title";
  const body = rejection?.stopOutcome
    ? `errors.workStop.${rejection.stopOutcome}Body`
    : rejection?.reason === "work_result_unknown" ? "errors.messageRejected.workResultUnknown"
      : rejection?.uncertain && rejection.reason === "billing_unknown" ? "errors.messageRejected.billingUnknown"
      : rejection?.uncertain ? "errors.messageRejected.unknownBody"
      : rejection?.reason === "insufficient_balance" ? "errors.messageRejected.insufficientBalance"
        : rejection?.reason === "history_media_limit" ? "errors.messageRejected.historyMediaLimit"
        : rejection?.reason === "invalid_history_media" ? "errors.messageRejected.invalidHistoryMedia"
        : rejection?.reason === "history_media_unavailable" ? "errors.messageRejected.historyMediaUnavailable"
        : rejection?.runActive ? "errors.messageRejected.runActiveBody" : "errors.messageRejected.body";
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
