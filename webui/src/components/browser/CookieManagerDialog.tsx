import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Cookie, Trash2, Search, Shield } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isTauri } from "@/lib/tauri";
import { browserGetCookies, browserClearCookies, type CookieInfo } from "@/lib/browser-ipc";

interface CookieManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabId: string | null;
}

export function CookieManagerDialog({ open, onOpenChange, tabId }: CookieManagerDialogProps) {
  const [cookies, setCookies] = useState<CookieInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const loadCookies = useCallback(async () => {
    if (!tabId || !isTauri()) return;
    setLoading(true);
    try {
      await browserGetCookies(tabId);
      // 结果通过 browser-cookies-result 事件回传
    } catch (e) {
      console.error("[CookieManager] load cookies failed:", e);
    } finally {
      setLoading(false);
    }
  }, [tabId]);

  // 监听 cookie 结果事件
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<{ id: string; cookies: CookieInfo[] }>(
        "browser-cookies-result",
        (event) => {
          if (event.payload.id === tabId) {
            setCookies(event.payload.cookies || []);
            setLoading(false);
          }
        }
      );
    };
    void setup();
    return () => { unlisten?.(); };
  }, [open, tabId]);

  // 打开时自动加载
  useEffect(() => {
    if (open && tabId) {
      void loadCookies();
    }
  }, [open, tabId, loadCookies]);

  const handleClearAll = useCallback(async () => {
    if (!tabId || !isTauri()) return;
    try {
      await browserClearCookies(tabId);
      setCookies([]);
    } catch (e) {
      console.error("[CookieManager] clear cookies failed:", e);
    }
  }, [tabId]);

  const filteredCookies = cookies.filter(
    (c) =>
      c.name.toLowerCase().includes(filter.toLowerCase()) ||
      c.value.toLowerCase().includes(filter.toLowerCase()) ||
      c.domain.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cookie className="h-4 w-4" />
            Cookie 管理器
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索 Cookie..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 pl-9 text-[13px] rounded-full"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadCookies}
            disabled={loading || !tabId}
            className="h-8"
          >
            刷新
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleClearAll}
            disabled={cookies.length === 0 || !tabId}
            className="h-8"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            清除全部
          </Button>
        </div>
        <div className="h-[400px] overflow-y-auto scrollbar-thin rounded-md border">
          {filteredCookies.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
              <Shield className="h-8 w-8 opacity-50" />
              <p className="text-sm">
                {loading ? "加载中..." : cookies.length === 0 ? "没有可用的 Cookie" : "没有匹配的 Cookie"}
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {filteredCookies.map((cookie, idx) => (
                <div key={idx} className="flex items-start gap-3 p-3 hover:bg-muted/50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{cookie.name}</span>
                      <span className="text-xs text-muted-foreground truncate">{cookie.domain}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 break-all">
                      {cookie.value}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          注：仅显示非 HttpOnly 的 Cookie。HttpOnly Cookie 无法通过 JS 访问。
        </p>
      </DialogContent>
    </Dialog>
  );
}
