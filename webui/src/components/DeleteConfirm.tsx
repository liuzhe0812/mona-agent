import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface DeleteConfirmProps {
  open: boolean;
  title: string;
  /** 可选覆盖文案；不传则保持默认「删除这个对话？」语义 */
  titleText?: string;
  descriptionText?: string;
  /** 可选覆盖确认按钮文案；不传则保持默认「删除对话」语义 */
  confirmText?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirm({
  open,
  title,
  titleText,
  descriptionText,
  confirmText,
  onCancel,
  onConfirm,
}: DeleteConfirmProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <AlertDialogContent
        className="w-full max-w-sm gap-0 rounded-xl border-border/70 bg-popover p-6 shadow-overlay sm:rounded-xl"
      >
        <AlertDialogHeader className="space-y-0 text-left">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive">
              <Trash2 className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <AlertDialogTitle className="text-title-sm text-foreground">
                {titleText ?? t("deleteConfirm.title", { title })}
              </AlertDialogTitle>
              <AlertDialogDescription className="mt-2 text-body text-muted-foreground">
                {descriptionText ?? t("deleteConfirm.description")}
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-6 gap-2 sm:space-x-0">
          <AlertDialogCancel
            onClick={onCancel}
            className="text-ui"
          >
            {t("deleteConfirm.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {confirmText ?? t("deleteConfirm.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
