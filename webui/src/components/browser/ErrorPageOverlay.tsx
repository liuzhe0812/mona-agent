import { AlertCircle, RotateCw, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

interface ErrorPageOverlayProps {
  visible: boolean;
  url?: string;
  onReload: () => void;
}

export function ErrorPageOverlay({ visible, url, onReload }: ErrorPageOverlayProps) {
  if (!visible) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background">
      <EmptyState
        className="max-w-md"
        icon={
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
            <AlertCircle className="h-8 w-8 text-destructive" />
          </div>
        }
        title="无法访问此页面"
        description={
          <span className="flex flex-col items-center gap-1.5">
            <span>页面可能已移动或暂时不可用。请检查网址或稍后重试。</span>
            {url ? (
              <span className="flex items-center justify-center gap-1.5">
                <Globe className="h-3 w-3" />
                <span className="truncate">{url}</span>
              </span>
            ) : null}
          </span>
        }
        action={
          <Button variant="outline" size="sm" onClick={onReload}>
            <RotateCw className="mr-2 h-3.5 w-3.5" />
            重新加载
          </Button>
        }
      />
    </div>
  );
}
