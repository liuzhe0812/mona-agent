import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { fetchPptTemplates, getApiBase } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { PptTemplate } from "@/lib/types";
import { PptBrandImportView } from "./PptBrandImportView";

interface PptTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedKey: string | null;
  selectedKind: "layout" | "brand" | "deck" | null;
  token: string;
  onSelect: (tpl: PptTemplate) => void;
}

type DialogView = "select" | "import" | "import-deck";
type TemplateKindFilter = "all" | "layout" | "brand" | "deck";

const TEMPLATE_FILTERS: Array<{ value: TemplateKindFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "deck", label: "完整模板" },
  { value: "layout", label: "布局" },
  { value: "brand", label: "品牌" },
];

export function PptTemplateDialog({
  open,
  onOpenChange,
  selectedKey,
  selectedKind,
  token,
  onSelect,
}: PptTemplateDialogProps) {
  const { client } = useClient();
  const [templates, setTemplates] = useState<PptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [dialogView, setDialogView] = useState<DialogView>("select");
  const [kindFilter, setKindFilter] = useState<TemplateKindFilter>("all");
  const [deletingBrand, setDeletingBrand] = useState<string | null>(null);

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

  const filteredTemplates =
    kindFilter === "all" ? templates : templates.filter((tpl) => tpl.kind === kindFilter);

  const groups = filteredTemplates.reduce<Record<string, PptTemplate[]>>((acc, tpl) => {
    const g = tpl.group || "其他";
    if (!acc[g]) acc[g] = [];
    acc[g].push(tpl);
    return acc;
  }, {});

  function handleSelect(tpl: PptTemplate) {
    onSelect(tpl);
    onOpenChange(false);
  }

  function handleImportSaved() {
    setDialogView("select");
    fetchPptTemplates(token)
      .then((res) => setTemplates(res.templates))
      .catch(() => {});
  }

  function handleDeleteBrand(brandId: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (deletingBrand) return;
    setDeletingBrand(brandId);
    let handled = false;
    const timeout = setTimeout(() => {
      if (handled) return;
      handled = true;
      setDeletingBrand(null);
    }, 15_000);

    const unsub = client.onPptDeleteBrandResult((result) => {
      if (handled) return;
      handled = true;
      clearTimeout(timeout);
      unsub();
      setDeletingBrand(null);
      if (result.ok) {
        setTemplates((prev) =>
          prev.filter((t) => !(t.kind === "brand" && t.key === brandId)),
        );
      }
    });

    client.sendPptDeleteBrand({ brandId });
  }

  // Reset view when dialog opens
  useEffect(() => {
    if (open) {
      setDialogView("select");
      setKindFilter("all");
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
          <DialogTitle>
            {dialogView === "import-deck"
              ? "导入完整模板"
              : dialogView === "import"
                ? "导入品牌模板"
                : "选择模板"}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {dialogView === "import" ? (
            <PptBrandImportView
              onBack={() => setDialogView("select")}
              onSaved={handleImportSaved}
            />
          ) : dialogView === "import-deck" ? (
            <PptBrandImportView
              onBack={() => setDialogView("select")}
              onSaved={handleImportSaved}
              mode="deck"
            />
          ) : loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-2">
                <div className="grid grid-cols-5 gap-1 rounded-lg bg-muted p-1">
                  {TEMPLATE_FILTERS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={cn(
                        "rounded-md px-2 py-1 text-[11px] font-medium transition-all",
                        kindFilter === item.value
                          ? "bg-background text-foreground shadow"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setKindFilter(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-[11px]"
                    onClick={() => setDialogView("import")}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    导入品牌
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-[11px]"
                    onClick={() => setDialogView("import-deck")}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    导入完整模板
                  </Button>
                </div>
              </div>
              {Object.entries(groups).length === 0 ? (
                <div className="flex items-center justify-center rounded-lg border border-dashed border-border/70 py-10 text-[12px] text-muted-foreground">
                  暂无模板
                </div>
              ) : (
                Object.entries(groups).map(([group, items]) => (
                  <div key={group}>
                    <h4 className="mb-2 text-[12px] font-medium text-muted-foreground">
                      {group}
                    </h4>
                    <div className="grid grid-cols-3 gap-2.5">
                      {items.map((tpl) => {
                        const selected =
                          selectedKey === tpl.key && selectedKind === tpl.kind;
                        return (
                          <div key={`${tpl.kind}-${tpl.key}`} className="relative">
                            <button
                              className={cn(
                                "flex w-full flex-col overflow-hidden rounded-lg border text-left transition-colors",
                                selected
                                  ? "border-primary ring-1 ring-primary"
                                  : "border-border/70 hover:border-border",
                              )}
                              onClick={() => handleSelect(tpl)}
                            >
                              <div className="aspect-video w-full overflow-hidden bg-muted">
                                {tpl.coverSvgUrl ? (
                                  <img
                                    src={templateImgUrl(tpl.coverSvgUrl)}
                                    alt={tpl.name}
                                    className="h-full w-full object-cover"
                                  />
                                ) : (
                                  <div
                                    className="flex h-full w-full items-center justify-center"
                                    style={{ backgroundColor: tpl.primaryColor || "#e5e5e5" }}
                                  >
                                    <span className="text-[11px] font-medium text-white/80">
                                      {tpl.name}
                                    </span>
                                  </div>
                                )}
                              </div>
                              <div className="p-2">
                                <div className="flex items-center justify-between gap-1">
                                  <span className="truncate text-[11px] font-medium text-foreground">
                                    {tpl.name}
                                  </span>
                                  {tpl.kind === "brand" && tpl.primaryColor ? (
                                    <span
                                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                                      style={{ backgroundColor: tpl.primaryColor }}
                                    />
                                  ) : (tpl.kind === "layout" || tpl.kind === "deck") &&
                                    tpl.pageCount != null ? (
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
                            {tpl.kind === "brand" && tpl.userCreated && (
                              <button
                                type="button"
                                className="absolute right-1 top-1 rounded-full bg-background/80 p-1 text-muted-foreground hover:text-destructive"
                                onClick={(e) => handleDeleteBrand(tpl.key, e)}
                                disabled={deletingBrand === tpl.key}
                              >
                                {deletingBrand === tpl.key ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
