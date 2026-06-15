import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useIdeStore } from "./useIdeStore";

export function IdeConflictDialog() {
  const conflict = useIdeStore((s) => s.conflictState);
  const resolveConflict = useIdeStore((s) => s.resolveConflict);
  const clearConflict = () => useIdeStore.setState({ conflictState: null });

  if (!conflict) return null;

  return (
    <Dialog open onOpenChange={clearConflict}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>文件已被外部修改</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          远程文件在编辑期间被修改。您要覆盖远程版本，还是放弃本地修改？
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={clearConflict}>
            取消
          </Button>
          <Button
            variant="secondary"
            onClick={() => resolveConflict(conflict.tabId, "discard")}
          >
            放弃本地修改
          </Button>
          <Button onClick={() => resolveConflict(conflict.tabId, "overwrite")}>
            覆盖远程
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
