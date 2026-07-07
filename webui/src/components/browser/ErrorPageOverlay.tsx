import { AlertCircle, RotateCw, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorPageOverlayProps {
  visible: boolean;
  url?: string;
  onReload: () => void;
}

export function ErrorPageOverlay({ visible, url, onReload }: ErrorPageOverlayProps) {
  if (!visible) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background">
      <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="h-8 w-8 text-destructive" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold">无法访问此页面</h2>
          <p className="text-[13px] text-muted-foreground">
            页面可能已移动或暂时不可用。请检查网址或稍后重试。
          </p>
          {url && (
            <p className="flex items-center justify-center gap-1.5 text-[12px] text-muted-foreground">
              <Globe className="h-3 w-3" />
              <span className="truncate">{url}</span>
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onReload} className="mt-2">
          <RotateCw className="mr-2 h-3.5 w-3.5" />
          重新加载
        </Button>
      </div>
    </div>
  );
}
