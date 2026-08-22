import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, FileText, Loader2, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  confirmStockMaterialBinding,
  createStockMaterialBinding,
  fetchStockMaterialPage,
  fetchStockMaterials,
  type StockConfirmedFinancialFactInput,
  type StockMaterialBinding,
  type StockMaterialItem,
  type StockMaterialPagePreview,
} from "@/lib/stock-api";
import { extractMaterialsText } from "@/lib/materials-api";
import { isTauri, materialsImportFiles } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface StockMaterialEvidencePanelProps {
  instrumentId: string | null;
  open: boolean;
  onSelectionChange: (bindingIds: string[]) => void;
}

type BindingForm = {
  materialId: string;
  reportPeriod: string;
  firstPublishedAt: string;
  publisher: string;
  pages: string;
};

type PreviewState = {
  material: StockMaterialItem;
  binding: StockMaterialBinding;
  pages: StockMaterialPagePreview[];
  loading: boolean;
  confirming: boolean;
  error: string | null;
  confirmedFacts: FinancialFactDraft[];
  factError: string | null;
};

type FinancialFactDraft = {
  metric: string;
  valueText: string;
  unit: string;
  page: string;
  excerpt: string;
};

const FINANCIAL_METRICS = [
  { value: "revenue", label: "营业收入" },
  { value: "net_profit", label: "归母净利润" },
  { value: "operating_cash_flow", label: "经营活动现金流净额" },
  { value: "total_assets", label: "总资产" },
  { value: "total_liabilities", label: "总负债" },
  { value: "parent_equity", label: "归属于母公司所有者权益" },
  { value: "basic_eps", label: "基本每股收益" },
] as const;

const FINANCIAL_UNITS = [
  { value: "yuan", label: "元" },
  { value: "ten_thousand_yuan", label: "万元" },
  { value: "hundred_million_yuan", label: "亿元" },
  { value: "yuan_per_share", label: "元/股" },
] as const;

function metricLabel(value: string): string {
  return FINANCIAL_METRICS.find((item) => item.value === value)?.label
    ?? (/^[\u4e00-\u9fff]/.test(value) ? value : "指标待确认");
}

function unitLabel(value: string): string {
  return FINANCIAL_UNITS.find((item) => item.value === value)?.label
    ?? (/^[\u4e00-\u9fff]/.test(value) ? value : "单位待确认");
}

function unitsForMetric(metric: string) {
  return metric === "basic_eps"
    ? FINANCIAL_UNITS.filter((item) => item.value === "yuan_per_share")
    : FINANCIAL_UNITS.filter((item) => item.value !== "yuan_per_share");
}

function confirmedFactLabel(fact: { metric_name: string; unit: string }): { metric: string; unit: string } {
  return { metric: metricLabel(fact.metric_name), unit: unitLabel(fact.unit) };
}

function materialError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  if (message && /[\u4e00-\u9fff]/.test(message)) return message;
  return fallback;
}

function extractionLabel(material: StockMaterialItem): string {
  const raw = material.extraction_status.trim();
  if (["已完成", "提取完成", "ok", "ready"].includes(raw)) return "提取完成";
  if (["等待提取", "queued", "running"].includes(raw)) return "正在提取";
  if (["提取失败", "error", "extraction_failed"].includes(raw)) return "提取失败";
  if (["格式不支持", "unsupported", "extraction_unsupported"].includes(raw)) return "格式不支持";
  if (["没有可验证文本", "scan_without_text"].includes(raw)) return "没有可验证文本";
  return /[\u4e00-\u9fff]/.test(raw) ? raw : "提取状态待确认";
}

function bindingStatus(binding: StockMaterialBinding): string {
  if (binding.status_code === "confirmed" || binding.status === "已确认") return "已确认";
  if (binding.status_code === "invalidated" || binding.status === "已失效") return "已失效";
  return "待用户确认";
}

function isConfirmed(binding: StockMaterialBinding): boolean {
  return bindingStatus(binding) === "已确认";
}

function isInvalidated(binding: StockMaterialBinding): boolean {
  return bindingStatus(binding) === "已失效";
}

function displayMaterialName(name: string): string {
  const clean = name.replace(/\\/g, "/").split("/").at(-1)?.trim();
  return clean || "未命名财报";
}

function parsePages(value: string): number[] | null {
  const tokens = value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  if (tokens.length === 0 || tokens.some((item) => !/^\d+$/.test(item))) return null;
  const pages = tokens.map(Number);
  if (pages.some((page) => page < 1) || new Set(pages).size !== pages.length) return null;
  return pages;
}

function pagesLabel(pages: number[]): string {
  return pages.length > 0 ? pages.map((page) => `第 ${page} 页`).join("、") : "未提供页码";
}

export function StockMaterialEvidencePanel({
  instrumentId,
  open,
  onSelectionChange,
}: StockMaterialEvidencePanelProps) {
  const [materials, setMaterials] = useState<StockMaterialItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bindingForm, setBindingForm] = useState<BindingForm | null>(null);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const delayedRefreshRef = useRef<number | null>(null);

  const desktopUploadAvailable = isTauri();

  const loadMaterials = useCallback(async (clear = false) => {
    if (!instrumentId) return;
    if (clear) setMaterials([]);
    setLoading(true);
    setError(null);
    try {
      const response = await fetchStockMaterials(instrumentId);
      setMaterials(response.materials);
    } catch (err) {
      setError(materialError(err, "财报资料读取失败，请稍后重试"));
    } finally {
      setLoading(false);
    }
  }, [instrumentId]);

  useEffect(() => {
    if (delayedRefreshRef.current !== null) {
      window.clearTimeout(delayedRefreshRef.current);
      delayedRefreshRef.current = null;
    }
    setSelectedIds([]);
    setBindingForm(null);
    setBindingError(null);
    setPreview(null);
    setError(null);
    if (open && instrumentId) void loadMaterials(true);
  }, [instrumentId, open, onSelectionChange, loadMaterials]);

  useEffect(() => () => {
    if (delayedRefreshRef.current !== null) window.clearTimeout(delayedRefreshRef.current);
  }, []);

  const confirmedBindingIds = useMemo(
    () => new Set(materials.flatMap((material) => material.bindings.filter(isConfirmed).map((binding) => binding.binding_id))),
    [materials],
  );

  useEffect(() => {
    setSelectedIds((current) => {
      return current.filter((id) => confirmedBindingIds.has(id));
    });
  }, [confirmedBindingIds]);

  useEffect(() => {
    onSelectionChange(selectedIds);
  }, [onSelectionChange, selectedIds]);

  const toggleSelected = useCallback((binding: StockMaterialBinding) => {
    if (!isConfirmed(binding) || !binding.binding_id) return;
    setSelectedIds((current) => {
      if (current.includes(binding.binding_id)) {
        return current.filter((id) => id !== binding.binding_id);
      }
      if (current.length >= 8) return current;
      return [...current, binding.binding_id];
    });
  }, []);

  const handleUpload = useCallback(async () => {
    if (!desktopUploadAvailable) return;
    setUploading(true);
    setError(null);
    try {
      const { open: openFileDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openFileDialog({
        multiple: true,
        filters: [{ name: "财报文件", extensions: ["pdf"] }],
      });
      if (!selected) return;
      const paths = (Array.isArray(selected) ? selected : [selected]).filter((path): path is string => typeof path === "string");
      if (paths.length === 0 || paths.some((path) => !path.toLowerCase().endsWith(".pdf"))) {
        setError("只能上传 PDF 格式的财报文件。");
        return;
      }
      const imported = await materialsImportFiles(paths, "");
      let extractionFailed = false;
      for (const entry of imported) {
        if (entry.kind !== "file") continue;
        try {
          await extractMaterialsText(entry.path.replace(/^raw[\\/]/, ""));
        } catch {
          extractionFailed = true;
        }
      }
      await loadMaterials(false);
      // 文本提取由资料库后台异步完成，稍后再读一次以显示最终页数和状态。
      delayedRefreshRef.current = window.setTimeout(() => {
        delayedRefreshRef.current = null;
        void loadMaterials(false);
      }, 2000);
      if (extractionFailed) setError("财报已上传，但部分文本提取失败，请稍后重试。");
    } catch (err) {
      setError(materialError(err, "财报上传失败，请稍后重试"));
    } finally {
      setUploading(false);
    }
  }, [desktopUploadAvailable, loadMaterials]);

  const openBindingForm = useCallback((materialId: string) => {
    setBindingError(null);
    setBindingForm({ materialId, reportPeriod: "", firstPublishedAt: "", publisher: "", pages: "" });
  }, []);

  const submitBinding = useCallback(async () => {
    if (!bindingForm || !instrumentId) return;
    const pages = parsePages(bindingForm.pages);
    if (!bindingForm.reportPeriod) {
      setBindingError("请填写报告期，例如 2026-06-30。");
      return;
    }
    if (!bindingForm.firstPublishedAt) {
      setBindingError("请填写首次公开时间，不能由系统推断。");
      return;
    }
    if (!bindingForm.publisher.trim()) {
      setBindingError("请填写发布机构，不能由系统推断。");
      return;
    }
    if (!pages) {
      setBindingError("使用页码必须填写正整数，多个页码请用逗号分隔，例如：1, 2, 3。");
      return;
    }
    setBindingBusy(true);
    setBindingError(null);
    try {
      await createStockMaterialBinding({
        instrument_id: instrumentId,
        material_id: bindingForm.materialId,
        report_period: bindingForm.reportPeriod,
        first_published_at: bindingForm.firstPublishedAt,
        publisher: bindingForm.publisher.trim(),
        pages,
      });
      setBindingForm(null);
      await loadMaterials(false);
    } catch (err) {
      setBindingError(materialError(err, "财报登记失败，已保留当前资料列表"));
    } finally {
      setBindingBusy(false);
    }
  }, [bindingForm, instrumentId, loadMaterials]);

  const openPreview = useCallback(async (material: StockMaterialItem, binding: StockMaterialBinding) => {
    const pages = binding.pages;
    setPreview({
      material,
      binding,
      pages: [],
      loading: true,
      confirming: false,
      error: null,
      confirmedFacts: [],
      factError: null,
    });
    if (pages.length === 0) {
      setPreview((current) => current ? { ...current, loading: false, error: "这份财报没有可核对的页码，请重新登记。" } : current);
      return;
    }
    try {
      const previews = await Promise.all(pages.map((page) => fetchStockMaterialPage(material.material_id, page)));
      if (previews.some((page, index) => page.page !== pages[index])) {
        throw new Error("财报页码校验失败，请重试");
      }
      setPreview((current) => current ? { ...current, pages: previews, loading: false } : current);
    } catch (err) {
      setPreview((current) => current ? { ...current, loading: false, error: materialError(err, "财报页文本读取失败，请重试") } : current);
    }
  }, []);

  const confirmPreview = useCallback(async () => {
    if (!preview || preview.loading || preview.error || preview.pages.length !== preview.binding.pages.length) return;
    const incompleteFact = preview.confirmedFacts.find(
      (fact) => !fact.metric || !fact.valueText.trim() || !fact.unit || !fact.page || !fact.excerpt.trim(),
    );
    if (incompleteFact) {
      setPreview((current) => current ? {
        ...current,
        factError: "请完整填写每项已核对关键财务数据；不确定的指标可以删除，不要猜测。",
      } : current);
      return;
    }
    const invalidUnit = preview.confirmedFacts.find(
      (fact) => !unitsForMetric(fact.metric).some((unit) => unit.value === fact.unit),
    );
    if (invalidUnit) {
      setPreview((current) => current ? {
        ...current,
        factError: "基本每股收益只能选择元/股，其他指标只能选择元、万元或亿元。",
      } : current);
      return;
    }
    const confirmedFacts: StockConfirmedFinancialFactInput[] = preview.confirmedFacts.map((fact) => ({
      metric: fact.metric,
      value_text: fact.valueText.trim(),
      unit: fact.unit,
      page: Number(fact.page),
      excerpt: fact.excerpt.trim(),
    }));
    setPreview((current) => current ? { ...current, confirming: true } : current);
    try {
      await confirmStockMaterialBinding(preview.binding.binding_id, confirmedFacts);
      setPreview(null);
      await loadMaterials(false);
    } catch (err) {
      setPreview((current) => current ? {
        ...current,
        confirming: false,
        factError: materialError(err, "财报确认失败，已保留已填写内容，请修正后重试"),
      } : current);
    }
  }, [loadMaterials, preview]);

  const updateFact = useCallback((index: number, update: Partial<FinancialFactDraft>) => {
    setPreview((current) => current ? {
      ...current,
      factError: null,
      confirmedFacts: current.confirmedFacts.map((fact, factIndex) => factIndex === index ? { ...fact, ...update } : fact),
    } : current);
  }, []);

  const addFact = useCallback(() => {
    setPreview((current) => {
      if (!current || current.confirmedFacts.length >= 7) return current;
      return {
        ...current,
        factError: null,
        confirmedFacts: [
          ...current.confirmedFacts,
          { metric: "", valueText: "", unit: "", page: "", excerpt: "" },
        ],
      };
    });
  }, []);

  const removeFact = useCallback((index: number) => {
    setPreview((current) => current ? {
      ...current,
      factError: null,
      confirmedFacts: current.confirmedFacts.filter((_, factIndex) => factIndex !== index),
    } : current);
  }, []);

  if (!open || !instrumentId) return null;

  return <section className="rounded-md border bg-muted/10 p-3" data-testid="stock-material-evidence-panel">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="font-medium">财报原文证据</h3>
        <p className="mt-1 text-micro text-muted-foreground">财报原文仅作为补充证据，所选页会进入本次投研；未确认内容不会作为事实。</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {desktopUploadAvailable ? <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => void handleUpload()}>
          {uploading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}上传财报
        </Button> : <span className="text-micro text-warning">请在桌面端上传财报</span>}
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void loadMaterials(false)}>
          {loading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}刷新财报资料
        </Button>
      </div>
    </div>
    {error && <div className="mt-2 rounded-md bg-warning/10 px-2.5 py-2 text-micro text-warning">{error}</div>}
    {loading && <div className="mt-3 flex items-center gap-2 text-micro text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在读取当前股票的财报资料…</div>}
    {!loading && materials.length === 0 && <p className="mt-3 text-micro text-muted-foreground">当前股票暂无可用财报。</p>}
    <div className="mt-3 space-y-2">
      {materials.map((material) => {
        const name = displayMaterialName(material.material_name);
        const extraction = extractionLabel(material);
        const canBind = extraction === "提取完成" && material.page_count > 0;
        return <article key={material.material_id} className="rounded-md border bg-background/70 p-2.5">
          <div className="flex items-start gap-2">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-caption font-medium">{name}</span>
                <span className={cn("rounded-full px-1.5 py-0.5 text-micro", extraction === "提取完成" ? "bg-success/10 text-success" : "bg-warning/10 text-warning")}>{extraction}</span>
                <span className="text-micro text-muted-foreground">页数：{material.page_count > 0 ? material.page_count : "待确认"}</span>
              </div>
              {material.bindings.length > 0 ? <div className="mt-2 space-y-1.5">
                {material.bindings.map((binding) => {
                  const status = bindingStatus(binding);
                  const checked = selectedIds.includes(binding.binding_id);
                  const selectable = isConfirmed(binding) && !isInvalidated(binding);
                  return <div key={binding.binding_id} className="rounded border px-2 py-1.5 text-micro">
                    <div className="flex flex-wrap items-center gap-2">
                      {selectable && <label className="inline-flex items-center gap-1.5"><input type="checkbox" aria-label={`选择${name}`} checked={checked} disabled={!checked && selectedIds.length >= 8} onChange={() => toggleSelected(binding)} className="accent-[hsl(var(--info))]" />纳入本次投研</label>}
                      <span className={cn(status === "已确认" ? "text-success" : status === "已失效" ? "text-destructive" : "text-warning")}>{status}</span>
                      {binding.publisher && <span className="text-muted-foreground">发布机构：{binding.publisher}</span>}
                      {binding.first_published_at && <span className="text-muted-foreground">首次公开：{binding.first_published_at.replace("T", " ")}</span>}
                      {binding.report_period && <span className="text-muted-foreground">报告期：{binding.report_period}</span>}
                      {binding.pages.length > 0 && <span className="text-muted-foreground">使用页码：{pagesLabel(binding.pages)}</span>}
                    </div>
                    {binding.invalidation_reason && <div className="mt-1 text-destructive">失效原因：{binding.invalidation_reason}</div>}
                    {binding.confirmed_facts?.length ? <div className="mt-2 rounded bg-success/5 px-2 py-1.5">
                      <div className="font-medium">已核对关键财务数据</div>
                      <div className="mt-1 space-y-1">
                        {binding.confirmed_facts.map((fact, factIndex) => {
                          const labels = confirmedFactLabel(fact);
                          return <div key={`${fact.metric_name}-${fact.page}-${factIndex}`}>
                            <div>{labels.metric}：{fact.value_text} {labels.unit} · 第 {fact.page} 页</div>
                            <div className="mt-0.5 whitespace-pre-wrap text-muted-foreground">原文摘录：{fact.excerpt}</div>
                          </div>;
                        })}
                      </div>
                    </div> : null}
                    {status === "待用户确认" && <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-1.5 text-micro" onClick={() => void openPreview(material, binding)}><Eye className="mr-1 h-3.5 w-3.5" />逐页核对并确认</Button>}
                  </div>;
                })}
              </div> : <p className="mt-2 text-micro text-muted-foreground">尚未登记财报信息，请补充报告期、首次公开时间、发布机构和使用页码。</p>}
              {bindingForm?.materialId === material.material_id ? <div className="mt-2 space-y-2 rounded-md bg-muted/30 p-2.5" data-testid="stock-material-binding-form">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-micro">报告期（日期）<Input type="date" value={bindingForm.reportPeriod} onChange={(event) => setBindingForm((current) => current ? { ...current, reportPeriod: event.target.value } : current)} /></label>
                  <label className="text-micro">首次公开时间<Input type="datetime-local" value={bindingForm.firstPublishedAt} onChange={(event) => setBindingForm((current) => current ? { ...current, firstPublishedAt: event.target.value } : current)} /></label>
                </div>
                <label className="block text-micro">发布机构<Input value={bindingForm.publisher} onChange={(event) => setBindingForm((current) => current ? { ...current, publisher: event.target.value } : current)} placeholder="例如：贵州茅台股份有限公司" /></label>
                <label className="block text-micro">使用页码<Input value={bindingForm.pages} onChange={(event) => setBindingForm((current) => current ? { ...current, pages: event.target.value } : current)} placeholder="例如：1, 2, 3" /></label>
                <p className="text-micro text-muted-foreground">页码必须是 PDF 中存在的正整数，多个页码用逗号分隔；系统不会自动推断报告期、发布时间或页码。</p>
                {bindingError && <p className="text-micro text-destructive">{bindingError}</p>}
                <div className="flex gap-2"><Button type="button" size="sm" disabled={bindingBusy} onClick={() => void submitBinding()}>{bindingBusy ? "正在登记…" : "登记为待确认财报"}</Button><Button type="button" variant="ghost" size="sm" disabled={bindingBusy} onClick={() => { setBindingForm(null); setBindingError(null); }}>取消</Button></div>
              </div> : canBind && <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => openBindingForm(material.material_id)}>登记财报信息</Button>}
            </div>
          </div>
        </article>;
      })}
    </div>
    <p className="mt-2 text-micro text-muted-foreground">最多选择 8 份已确认且未失效的财报；待用户确认或已失效的材料不能进入本次投研。已选择 {selectedIds.length} 份。</p>
    {preview && <div className="mt-3 rounded-md border bg-background p-3" data-testid="stock-material-page-preview">
      <div className="flex items-center justify-between gap-2"><div className="text-caption font-medium">逐页核对：{displayMaterialName(preview.material.material_name)}</div><Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="关闭财报核对" onClick={() => setPreview(null)}><X className="h-3.5 w-3.5" /></Button></div>
      <p className="mt-1 text-micro text-muted-foreground">请确认每一页的提取文本，再显式确认这份财报。</p>
      {preview.loading && <div className="mt-3 flex items-center gap-2 text-micro text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在读取所选页文本…</div>}
      {preview.error && <p className="mt-3 text-micro text-destructive">{preview.error}</p>}
      {!preview.loading && !preview.error && <div className="mt-3 max-h-56 space-y-2 overflow-y-auto">{preview.pages.map((page) => <article key={page.page} className="rounded border p-2"><div className="text-micro font-medium">第 {page.page} 页</div><p className="mt-1 whitespace-pre-wrap text-micro text-muted-foreground">{page.text || "本页没有可显示的提取文本"}</p></article>)}</div>}
      {!preview.loading && !preview.error && <div className="mt-3 rounded border bg-muted/20 p-2.5" data-testid="stock-material-confirmed-facts">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-micro font-medium">已核对关键财务数据（可选，最多 7 项）</div>
            <p className="mt-1 text-micro text-muted-foreground">只录入你在原文中核对到的数值、单位和页码；系统不自动解析表格，不推断期间、单位或列。</p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={preview.confirmedFacts.length >= 7} onClick={addFact}>添加关键财务数据</Button>
        </div>
        {preview.confirmedFacts.length > 0 ? <div className="mt-2 space-y-2">
          {preview.confirmedFacts.map((fact, index) => {
            const units = unitsForMetric(fact.metric);
            return <div key={index} className="rounded border bg-background/60 p-2" data-testid={`stock-material-fact-${index}`}>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-micro">指标<select className="mt-1 block h-8 w-full rounded border bg-background px-2 text-micro" aria-label={`第 ${index + 1} 项指标`} value={fact.metric} onChange={(event) => updateFact(index, { metric: event.target.value, unit: "" })}>
                  <option value="">请选择指标</option>
                  {FINANCIAL_METRICS.map((metric) => <option key={metric.value} value={metric.value}>{metric.label}</option>)}
                </select></label>
                <label className="text-micro">原文中的数值<Input value={fact.valueText} onChange={(event) => updateFact(index, { valueText: event.target.value })} placeholder="例如：100.25" /></label>
                <label className="text-micro">单位<select className="mt-1 block h-8 w-full rounded border bg-background px-2 text-micro" aria-label={`第 ${index + 1} 项单位`} value={fact.unit} disabled={!fact.metric} onChange={(event) => updateFact(index, { unit: event.target.value })}>
                  <option value="">请选择单位</option>
                  {units.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
                </select></label>
                <label className="text-micro">已选页码<select className="mt-1 block h-8 w-full rounded border bg-background px-2 text-micro" aria-label={`第 ${index + 1} 项页码`} value={fact.page} onChange={(event) => updateFact(index, { page: event.target.value })}>
                  <option value="">请选择页码</option>
                  {preview.pages.map((page) => <option key={page.page} value={page.page}>第 {page.page} 页</option>)}
                </select></label>
              </div>
              <label className="mt-2 block text-micro">精确原文摘录<textarea className="mt-1 min-h-16 w-full rounded border bg-background px-2 py-1.5 text-micro" value={fact.excerpt} onChange={(event) => updateFact(index, { excerpt: event.target.value })} placeholder="请粘贴包含指标、数值和单位的原文" /></label>
              <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-1.5 text-micro" onClick={() => removeFact(index)}>删除这项</Button>
            </div>;
          })}
        </div> : <p className="mt-2 text-micro text-muted-foreground">暂不填写也可以，只确认所选页面证据。</p>}
        {preview.factError && <p className="mt-2 text-micro text-destructive">{preview.factError}</p>}
      </div>}
      <Button type="button" className="mt-3" disabled={preview.loading || Boolean(preview.error) || preview.pages.length !== preview.binding.pages.length || preview.confirming} onClick={() => void confirmPreview()}>{preview.confirming ? "正在确认…" : "确认这份财报"}</Button>
    </div>}
  </section>;
}
