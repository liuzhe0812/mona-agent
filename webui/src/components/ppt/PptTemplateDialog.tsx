import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2, Plus, Trash2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { fetchPptTemplates, getApiBase } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { PptTemplate } from "@/lib/types";
import { PptPptxTemplateImportView } from "./PptPptxTemplateImportView";

type TemplateKindFilter = "all" | "general" | "native";

const TEMPLATE_FILTERS: Array<{ value: TemplateKindFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "general", label: "通用" },
  { value: "native", label: "自定义" },
];

type DialogView = "select" | "import";

interface PptTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedKey: string | null;
  selectedKind: "layout" | "brand" | "native" | null;
  token: string;
  onSelect: (tpl: PptTemplate) => void;
}

/** 待确认删除的模板（AlertDialog），null 表示无待确认删除 */
interface PendingDeleteTemplate {
  key: string;
  kind: "brand" | "native";
  name: string;
}

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteTemplate | null>(null);
  // 删除失败：在对应模板卡片附近展示错误与重试
  const [deleteError, setDeleteError] = useState<{ key: string; message: string } | null>(null);
  const [kindFilter, setKindFilter] = useState<TemplateKindFilter>("all");
  const [dialogView, setDialogView] = useState<DialogView>("select");

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

  const loadTemplates = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    return fetchPptTemplates(token)
      .then((res) => {
        setTemplates(res.templates);
      })
      .catch((e) => {
        setLoadError(e instanceof Error ? e.message : "加载模板失败");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [token]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchPptTemplates(token)
      .then((res) => {
        if (!cancelled) setTemplates(res.templates);
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "加载模板失败");
        }
      })
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

  const filtered = kindFilter === "all"
    ? templates
    : templates.filter((t) =>
      kindFilter === "native" ? t.kind === "native" : t.kind !== "native",
    );

  const groups = filtered.reduce<Record<string, PptTemplate[]>>((acc, tpl) => {
    const g = tpl.group || "其他";
    if (!acc[g]) acc[g] = [];
    acc[g].push(tpl);
    return acc;
  }, {});

  function handleSelect(tpl: PptTemplate) {
    onSelect(tpl);
    onOpenChange(false);
  }

  /** 执行删除（确认后调用）：品牌模板与自定义模板共用同一流程 */
  function executeDelete(key: string, kind: "brand" | "native") {
    if (deletingKey) return;
    setDeletingKey(key);
    setDeleteError(null);
    let handled = false;

    const finish = (error?: string) => {
      if (handled) return;
      handled = true;
      clearTimeout(timeout);
      unsub();
      setDeletingKey(null);
      if (error) {
        setDeleteError({ key, message: error });
      } else {
        setTemplates((prev) =>
          prev.filter((t) => !(t.kind === kind && t.key === key)),
        );
      }
    };

    const timeout = setTimeout(() => finish("删除请求超时，请重试"), 15_000);
    const unsub = kind === "native"
      ? client.onPptDeleteNativeResult((result) => {
          if (result.ok) {
            finish();
          } else {
            finish(result.error ?? "删除失败，请重试");
          }
        })
      : client.onPptDeleteBrandResult((result) => {
          if (result.ok) {
            finish();
          } else {
            finish(result.error ?? "删除失败，请重试");
          }
        });

    if (kind === "native") {
      client.sendPptDeleteNative({ templateId: key });
    } else {
      client.sendPptDeleteBrand({ brandId: key });
    }
  }

  function handleImportSaved() {
    setDialogView("select");
    fetchPptTemplates(token)
      .then((res) => setTemplates(res.templates))
      .catch(() => {});
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
          <DialogTitle>
            {dialogView === "import" ? "自定义模板" : "选择模板"}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {dialogView === "import" ? (
            <PptPptxTemplateImportView
              onBack={() => setDialogView("select")}
              onSaved={handleImportSaved}
            />
          ) : loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-[12px]">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <span className="text-destructive">加载模板失败：{loadError}</span>
              <button
                type="button"
                className="rounded px-2 py-1 text-primary hover:bg-primary/10"
                onClick={() => void loadTemplates()}
              >
                重试
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-3">
                <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="模板类型筛选">
                  {TEMPLATE_FILTERS.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      aria-pressed={kindFilter === f.value}
                      className={cn(
                        "rounded-full px-3 py-1 text-[11px] font-medium transition-colors",
                        kindFilter === f.value
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-muted/80",
                      )}
                      onClick={() => setKindFilter(f.value)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-[11px]"
                  onClick={() => setDialogView("import")}
                >
                  <Plus className="mr-1 h-3 w-3" />
                  自定义模板
                </Button>
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
                              type="button"
                              aria-label={`选择模板 ${tpl.name}`}
                              aria-pressed={selected}
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
                                  ) : (tpl.kind === "layout" || tpl.kind === "native") &&
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
                            {(tpl.kind === "brand" || tpl.kind === "native") && tpl.userCreated && (
                              <button
                                type="button"
                                aria-label={`删除模板 ${tpl.name}`}
                                className="absolute right-1 top-1 rounded-full bg-background/80 p-1 text-muted-foreground hover:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingDelete({
                                    key: tpl.key,
                                    kind: tpl.kind as "brand" | "native",
                                    name: tpl.name,
                                  });
                                }}
                                disabled={deletingKey === tpl.key}
                              >
                                {deletingKey === tpl.key ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                              </button>
                            )}
                            {deleteError?.key === tpl.key && (
                              <div className="mt-1 flex items-center gap-1.5 rounded-md bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
                                <AlertCircle className="h-3 w-3 shrink-0" />
                                <span className="min-w-0 flex-1">删除失败：{deleteError.message}</span>
                                <button
                                  type="button"
                                  className="shrink-0 rounded px-1.5 py-0.5 text-primary hover:bg-primary/10"
                                  onClick={() =>
                                    executeDelete(
                                      tpl.key,
                                      tpl.kind === "native" ? "native" : "brand",
                                    )
                                  }
                                >
                                  重试
                                </button>
                              </div>
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

        {/* 删除模板二次确认 */}
        <AlertDialog
          open={pendingDelete !== null}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除这个模板？</AlertDialogTitle>
              <AlertDialogDescription>
                将删除{pendingDelete?.kind === "native" ? "自定义模板" : "品牌模板"}
                「{pendingDelete?.name}」，删除后无法恢复。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (pendingDelete) executeDelete(pendingDelete.key, pendingDelete.kind);
                  setPendingDelete(null);
                }}
              >
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
