import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchPptTemplates, getApiBase } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PptTemplate } from "@/lib/types";

interface PptTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedKey: string | null;
  selectedKind: "layout" | "deck" | null;
  token: string;
  onSelect: (tpl: PptTemplate) => void;
}

export function PptTemplateDialog({
  open,
  onOpenChange,
  selectedKey,
  selectedKind,
  token,
  onSelect,
}: PptTemplateDialogProps) {
  const [templates, setTemplates] = useState<PptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiBase, setApiBase] = useState<string | null>(null);

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetchPptTemplates(token)
      .then((res) => {
        if (!cancelled) setTemplates(res.templates);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, token]);

  function templateImgUrl(url: string): string {
    const base = apiBase ?? "";
    const sep = url.includes("?") ? "&" : "?";
    return `${base}${url}${sep}token=${encodeURIComponent(token)}`;
  }

  const groups = templates.reduce<Record<string, PptTemplate[]>>((acc, tpl) => {
    const g = tpl.group || "其他";
    if (!acc[g]) acc[g] = [];
    acc[g].push(tpl);
    return acc;
  }, {});

  function handleSelect(tpl: PptTemplate) {
    onSelect(tpl);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
          <DialogTitle>选择模板</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-5">
              {Object.entries(groups).map(([group, items]) => (
                <div key={group}>
                  <h4 className="mb-2 text-[12px] font-medium text-muted-foreground">
                    {group}
                  </h4>
                  <div className="grid grid-cols-3 gap-2.5">
                    {items.map((tpl) => {
                      const selected =
                        selectedKey === tpl.key && selectedKind === tpl.kind;
                      return (
                        <button
                          key={`${tpl.kind}-${tpl.key}`}
                          className={cn(
                            "flex flex-col overflow-hidden rounded-lg border text-left transition-colors",
                            selected
                              ? "border-primary ring-1 ring-primary"
                              : "border-border/70 hover:border-border",
                          )}
                          onClick={() => handleSelect(tpl)}
                        >
                          <div className="aspect-video w-full overflow-hidden bg-muted">
                            <img
                              src={templateImgUrl(tpl.coverSvgUrl)}
                              alt={tpl.name}
                              className="h-full w-full object-cover"
                            />
                          </div>
                          <div className="p-2">
                            <div className="flex items-center justify-between gap-1">
                              <span className="truncate text-[11px] font-medium text-foreground">
                                {tpl.name}
                              </span>
                              {tpl.kind === "deck" && tpl.primaryColor ? (
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: tpl.primaryColor }}
                                />
                              ) : tpl.kind === "layout" && tpl.pageCount != null ? (
                                <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                                  {tpl.pageCount}页
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                              {tpl.summary}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
