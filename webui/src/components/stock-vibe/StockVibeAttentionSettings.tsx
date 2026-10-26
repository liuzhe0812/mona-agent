import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { inferStockVibeExchange } from "@/lib/stock-vibe-symbol";

export type StockVibeProactiveMode = "manual" | "important_changes" | "continuous";

export interface StockVibeAttentionSettingsValue {
  proactive_mode: StockVibeProactiveMode;
  watched_symbols: string[];
  notification_start: string;
  notification_end: string;
  attention_interval_sec: number;
  data_sources: string[];
}

export interface StockVibeAttentionSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: StockVibeAttentionSettingsValue;
  saving: boolean;
  onSave: (value: StockVibeAttentionSettingsValue) => void;
  error?: string;
}

const SOURCE_OPTIONS = [
  { value: "tencent", label: "腾讯" },
  { value: "eastmoney", label: "东方财富" },
] as const;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MODE_OPTIONS = [
  { value: "manual", label: "手动" },
  { value: "important_changes", label: "重要变化" },
  { value: "continuous", label: "持续关注" },
];

function editableValue(value: StockVibeAttentionSettingsValue): StockVibeAttentionSettingsValue {
  return {
    ...value,
    watched_symbols: [...value.watched_symbols],
    data_sources: value.data_sources.filter((source) => SOURCE_OPTIONS.some((option) => option.value === source)),
  };
}

function parseSymbols(text: string): { symbols: string[]; error?: string } {
  const codes = text.split(/[\s,，]+/).filter(Boolean);
  if (codes.some((code) => !/^\d{6}$/.test(code))) {
    return { symbols: [], error: "代码需为六位数字。" };
  }
  const symbols: string[] = [];
  for (const code of codes) {
    const exchange = inferStockVibeExchange(code);
    if (!exchange) return { symbols: [], error: "暂无法识别代码，请核对六位 A 股代码。" };
    symbols.push(`${code}.${exchange}`);
  }
  const unique = [...new Set(symbols)];
  if (unique.length > 50) return { symbols: [], error: "最多可关注 50 个不同代码。" };
  return { symbols: unique };
}

export function StockVibeAttentionSettings({
  open,
  onOpenChange,
  value,
  saving,
  onSave,
  error,
}: StockVibeAttentionSettingsProps) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const [draft, setDraft] = useState(() => editableValue(value));
  const [symbolsText, setSymbolsText] = useState(() => value.watched_symbols.map((symbol) => symbol.replace(/\.(SH|SZ|BJ)$/i, "")).join("\n"));
  const [intervalMinutes, setIntervalMinutes] = useState(() => String(Math.max(5, value.attention_interval_sec / 60)));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const current = valueRef.current;
    setDraft(editableValue(current));
    setSymbolsText(current.watched_symbols.map((symbol) => symbol.replace(/\.(SH|SZ|BJ)$/i, "")).join("\n"));
    setIntervalMinutes(String(Math.max(5, current.attention_interval_sec / 60)));
    setValidationError(null);
  }, [open]);

  const toggleSource = (source: string) => {
    setDraft((current) => ({
      ...current,
      data_sources: current.data_sources.includes(source)
        ? current.data_sources.filter((item) => item !== source)
        : [...current.data_sources, source],
    }));
  };

  const save = () => {
    const parsed = parseSymbols(symbolsText);
    if (parsed.error) {
      setValidationError(parsed.error);
      return;
    }
    if (!TIME.test(draft.notification_start) || !TIME.test(draft.notification_end)) {
      setValidationError("请输入有效的开始和结束时间。");
      return;
    }
    const minutes = Number(intervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 5) {
      setValidationError("检查间隔至少为 5 分钟。");
      return;
    }
    setValidationError(null);
    onSave({
      ...draft,
      watched_symbols: parsed.symbols,
      attention_interval_sec: Math.round(minutes * 60),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="scrollbar-scope max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>关注与提醒</DialogTitle>
          <DialogDescription>
            设置关注方式、标的范围和上海时区提醒时段。空范围不会扫描全市场。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <p className="text-ui font-medium">关注模式</p>
            <Select
              aria-label="关注模式"
              value={draft.proactive_mode}
              options={MODE_OPTIONS}
              disabled={saving}
              onValueChange={(mode) => {
                setValidationError(null);
                setDraft((current) => ({
                  ...current,
                  proactive_mode: mode as StockVibeProactiveMode,
                }));
              }}
            />
            <p className="text-caption text-muted-foreground">
              手动由你发起；重要变化关注变化；持续关注按设定间隔检查。目前后台只核对已完成日线，检查频率不代表行情更新频率；分钟和实时提醒尚未验收。
            </p>
          </section>

          <section className="space-y-2">
            <label className="text-ui font-medium" htmlFor="stock-vibe-watched-symbols">关注范围</label>
            <Textarea
              id="stock-vibe-watched-symbols"
              value={symbolsText}
              onChange={(event) => {
                setSymbolsText(event.target.value);
                setValidationError(null);
              }}
              placeholder={"600000\n000001"}
              rows={3}
              disabled={saving}
              spellCheck={false}
              aria-describedby="stock-vibe-symbols-help"
            />
            <p id="stock-vibe-symbols-help" className="text-caption text-muted-foreground">
              每行一个或用逗号分隔；仅输入六位 A 股代码，最多 50 个去重代码。留空时不检查全市场。
            </p>
          </section>

          <section className="space-y-2">
            <p className="text-ui font-medium">提醒时段（上海时间）</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-caption text-muted-foreground" htmlFor="stock-vibe-notification-start">
                开始
                <Input
                  id="stock-vibe-notification-start"
                  type="time"
                  value={draft.notification_start}
                  disabled={saving}
                  onChange={(event) => {
                    setValidationError(null);
                    setDraft((current) => ({ ...current, notification_start: event.target.value }));
                  }}
                />
              </label>
              <label className="space-y-1 text-caption text-muted-foreground" htmlFor="stock-vibe-notification-end">
                结束
                <Input
                  id="stock-vibe-notification-end"
                  type="time"
                  value={draft.notification_end}
                  disabled={saving}
                  onChange={(event) => {
                    setValidationError(null);
                    setDraft((current) => ({ ...current, notification_end: event.target.value }));
                  }}
                />
              </label>
            </div>
          </section>

          <section className="space-y-2">
            <label className="text-ui font-medium" htmlFor="stock-vibe-attention-interval">检查间隔（分钟）</label>
            <Input
              id="stock-vibe-attention-interval"
              type="number"
              min={5}
              step="any"
              value={intervalMinutes}
              disabled={saving}
              onChange={(event) => {
                setIntervalMinutes(event.target.value);
                setValidationError(null);
              }}
            />
          </section>

          <section className="space-y-2">
            <p className="text-ui font-medium">数据源偏好</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="数据源偏好">
              {SOURCE_OPTIONS.map((source) => {
                const selected = draft.data_sources.includes(source.value);
                return (
                  <Button
                    key={source.value}
                    type="button"
                    variant={selected ? "secondary" : "outline"}
                    aria-pressed={selected}
                    disabled={saving}
                    onClick={() => {
                      setValidationError(null);
                      toggleSource(source.value);
                    }}
                  >
                    {source.label}
                  </Button>
                );
              })}
            </div>
            <p className="text-caption text-muted-foreground">
              Baostock、AkShare、Tushare、Gildata 和本地文件源尚未接入，当前不可选。数据源偏好不代表分钟行情已可用。
            </p>
          </section>

          <p className="text-caption text-muted-foreground">
            Mona 应用完全退出后不会运行这些关注设置。
          </p>

          {(validationError || error) && (
            <p className="text-caption text-destructive" role="alert">
              {validationError ?? error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={saving} onClick={save}>
            {saving ? "保存中…" : "保存关注设置"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
