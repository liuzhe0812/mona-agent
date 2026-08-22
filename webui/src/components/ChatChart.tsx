import { useCallback, useMemo, useRef } from "react";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const CHART_TYPES = ["bar", "line", "area", "pie", "scatter"] as const;
const SERIES_COLORS = ["#2563eb", "#ea580c", "#0f766e", "#dc2626", "#7c3aed", "#ca8a04"];
const WIDTH = 720;
const HEIGHT = 420;
const MARGIN = { top: 34, right: 24, bottom: 64, left: 64 };

type ChartType = (typeof CHART_TYPES)[number];

interface ChartPointInput {
  label?: unknown;
  name?: unknown;
  value?: unknown;
  values?: unknown;
  x?: unknown;
  y?: unknown;
  series?: unknown;
}

interface ChartSpecInput {
  type?: unknown;
  title?: unknown;
  data?: unknown;
  series_names?: unknown;
  x_label?: unknown;
  y_label?: unknown;
}

interface CategoricalChart {
  type: Exclude<ChartType, "scatter">;
  title: string;
  labels: string[];
  rows: number[][];
  seriesNames: string[];
  xLabel: string;
  yLabel: string;
}

interface ScatterPoint {
  label: string;
  x: number;
  y: number;
  series: string;
}

interface ScatterChart {
  type: "scatter";
  title: string;
  points: ScatterPoint[];
  seriesNames: string[];
  xLabel: string;
  yLabel: string;
}

type NormalizedChart = CategoricalChart | ScatterChart;

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : fallback;
}

function parseChart(source: string): { chart?: NormalizedChart; error?: string } {
  let raw: ChartSpecInput;
  try {
    raw = JSON.parse(source) as ChartSpecInput;
  } catch {
    return { error: "invalidJson" };
  }
  if (!raw || typeof raw !== "object" || !CHART_TYPES.includes(raw.type as ChartType)) {
    return { error: "unsupportedType" };
  }
  if (!Array.isArray(raw.data) || raw.data.length === 0) {
    return { error: "emptyData" };
  }

  const type = raw.type as ChartType;
  const title = textValue(raw.title);
  const xLabel = textValue(raw.x_label);
  const yLabel = textValue(raw.y_label);
  const requestedSeriesNames = Array.isArray(raw.series_names)
    ? raw.series_names.map((name) => String(name))
    : [];

  if (type === "scatter") {
    const points: ScatterPoint[] = [];
    for (const [index, item] of raw.data.entries()) {
      if (Array.isArray(item)) {
        const [label, rawX, rawY] = item.length === 2
          ? [`P${index + 1}`, item[0], item[1]]
          : item;
        const x = finiteNumber(rawX);
        const y = finiteNumber(rawY);
        if (x === null || y === null) return { error: "invalidScatter" };
        points.push({
          label: textValue(label, `P${index + 1}`),
          x,
          y,
          series: requestedSeriesNames[0] || "Series 1",
        });
        continue;
      }
      if (!item || typeof item !== "object") {
        return { error: "invalidScatter" };
      }
      const point = item as ChartPointInput;
      const x = finiteNumber(point.x);
      const y = finiteNumber(point.y);
      if (x === null || y === null) return { error: "invalidScatter" };
      points.push({
        label: textValue(point.label, textValue(point.name, `P${index + 1}`)),
        x,
        y,
        series: textValue(point.series, requestedSeriesNames[0] || "Series 1"),
      });
    }
    const seriesNames = Array.from(new Set(points.map((point) => point.series)));
    return { chart: { type, title, points, seriesNames, xLabel, yLabel } };
  }

  const labels: string[] = [];
  const rows: number[][] = [];
  let seriesCount = 1;
  for (const [index, item] of raw.data.entries()) {
    if (Array.isArray(item)) {
      if (item.length < 2) return { error: "invalidData" };
      labels.push(textValue(item[0], `P${index + 1}`));
      const inputValues = item.length === 2 && Array.isArray(item[1])
        ? item[1]
        : item.slice(1);
      const values = inputValues.map(finiteNumber);
      if (values.some((value) => value === null)) return { error: "invalidData" };
      const row = values as number[];
      seriesCount = Math.max(seriesCount, row.length);
      rows.push(row);
      continue;
    }
    if (!item || typeof item !== "object") {
      return { error: "invalidData" };
    }
    const point = item as ChartPointInput;
    labels.push(textValue(point.label, textValue(point.name, textValue(point.x, `P${index + 1}`))));
    const inputValues = Array.isArray(point.values)
      ? point.values
      : [point.value ?? point.y];
    const values = inputValues.map(finiteNumber);
    if (values.some((value) => value === null)) return { error: "invalidData" };
    const row = values as number[];
    seriesCount = Math.max(seriesCount, row.length);
    rows.push(row);
  }
  for (const row of rows) {
    while (row.length < seriesCount) row.push(0);
  }
  const seriesNames = Array.from(
    { length: seriesCount },
    (_, index) => requestedSeriesNames[index] || `Series ${index + 1}`,
  );
  if (type === "pie") {
    const total = rows.reduce((sum, row) => sum + Math.max(0, row[0]), 0);
    if (total <= 0) return { error: "invalidPie" };
  }
  return { chart: { type, title, labels, rows, seriesNames, xLabel, yLabel } };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function niceTicks(low: number, high: number, target = 6): number[] {
  if (low === high) high = low + 1;
  const rawStep = (high - low) / Math.max(target - 1, 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep || 1));
  const normalized = rawStep / magnitude;
  const step = (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude;
  const start = Math.floor(low / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= high + step * 0.001; value += step) {
    if (value >= low - step * 0.001) ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

function paddedDomain(values: number[], includeZero: boolean): [number, number] {
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (includeZero) {
    low = Math.min(0, low);
    high = Math.max(0, high);
  }
  const padding = (high - low) * 0.08 || 1;
  return [low - (includeZero && low === 0 ? 0 : padding), high + padding];
}

function chartFilename(title: string, extension: string): string {
  const safe = title.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 60);
  return `${safe || "chart"}.${extension}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(WIDTH));
  clone.setAttribute("height", String(HEIGHT));
  return new XMLSerializer().serializeToString(clone);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function chartCsv(chart: NormalizedChart): string {
  if (chart.type === "scatter") {
    return [
      ["label", "series", chart.xLabel || "x", chart.yLabel || "y"],
      ...chart.points.map((point) => [point.label, point.series, point.x, point.y]),
    ].map((row) => row.map(csvCell).join(",")).join("\r\n");
  }
  if (chart.type === "pie") {
    return [
      ["label", chart.seriesNames[0] || "value"],
      ...chart.labels.map((label, index) => [label, chart.rows[index][0]]),
    ].map((row) => row.map(csvCell).join(",")).join("\r\n");
  }
  return [
    [chart.xLabel || "label", ...chart.seriesNames],
    ...chart.labels.map((label, index) => [label, ...chart.rows[index]]),
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function ChatChart({ source }: { source: string }) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const result = useMemo(() => parseChart(source), [source]);
  const chart = result.chart;

  const exportSvg = useCallback(() => {
    if (!svgRef.current || !chart) return;
    downloadBlob(
      new Blob([serializeSvg(svgRef.current)], { type: "image/svg+xml;charset=utf-8" }),
      chartFilename(chart.title, "svg"),
    );
  }, [chart]);

  const exportCsv = useCallback(() => {
    if (!chart) return;
    downloadBlob(
      new Blob([`\uFEFF${chartCsv(chart)}`], { type: "text/csv;charset=utf-8" }),
      chartFilename(chart.title, "csv"),
    );
  }, [chart]);

  const exportPng = useCallback(() => {
    if (!svgRef.current || !chart) return;
    const url = URL.createObjectURL(
      new Blob([serializeSvg(svgRef.current)], { type: "image/svg+xml;charset=utf-8" }),
    );
    const image = new Image();
    image.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = WIDTH * scale;
      canvas.height = HEIGHT * scale;
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        return;
      }
      context.scale(scale, scale);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, WIDTH, HEIGHT);
      context.drawImage(image, 0, 0, WIDTH, HEIGHT);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, chartFilename(chart.title, "png"));
        URL.revokeObjectURL(url);
      }, "image/png");
    };
    image.onerror = () => URL.revokeObjectURL(url);
    image.src = url;
  }, [chart]);

  if (!chart) {
    return (
      <div role="alert" className="my-3 rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {t(`chart.errors.${result.error ?? "invalidData"}`)}
      </div>
    );
  }

  return (
    <figure className="my-3 min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background/60">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <figcaption className="min-w-0 truncate text-sm font-medium">
          {chart.title || t("chart.untitled")}
        </figcaption>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs">
              <Download className="h-3.5 w-3.5" aria-hidden />
              {t("chart.export")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={exportPng}>{t("chart.exportPng")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={exportSvg}>{t("chart.exportSvg")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={exportCsv}>{t("chart.exportCsv")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="w-full overflow-x-auto p-2 text-foreground">
        {chart.type === "pie" ? (
          <PieChart chart={chart} svgRef={svgRef} />
        ) : chart.type === "scatter" ? (
          <ScatterPlot chart={chart} svgRef={svgRef} />
        ) : (
          <CartesianChart chart={chart} svgRef={svgRef} />
        )}
      </div>
    </figure>
  );
}

function ChartSvg({
  svgRef,
  label,
  children,
}: {
  svgRef: React.RefObject<SVGSVGElement>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <svg
      ref={svgRef}
      role="img"
      aria-label={label}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="block h-auto w-full min-w-[32rem]"
    >
      <title>{label}</title>
      {children}
    </svg>
  );
}

function Legend({ names }: { names: string[] }) {
  if (names.length <= 1) return null;
  return (
    <g aria-label="legend">
      {names.map((name, index) => (
        <g key={name} transform={`translate(${MARGIN.left + index * 130} 15)`}>
          <circle r="4" fill={SERIES_COLORS[index % SERIES_COLORS.length]} />
          <text x="9" y="4" fontSize="11" fill="currentColor">{name}</text>
        </g>
      ))}
    </g>
  );
}

function CartesianChart({
  chart,
  svgRef,
}: {
  chart: CategoricalChart;
  svgRef: React.RefObject<SVGSVGElement>;
}) {
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const allValues = chart.rows.flat();
  const [low, high] = paddedDomain(allValues, true);
  const ticks = niceTicks(low, high);
  const y = (value: number) => MARGIN.top + plotHeight - ((value - low) / (high - low || 1)) * plotHeight;
  const groupWidth = plotWidth / chart.labels.length;
  const x = (index: number) => MARGIN.left + groupWidth * (index + 0.5);
  const labelStep = Math.max(1, Math.ceil(chart.labels.length / 10));
  const baseline = y(0);

  return (
    <ChartSvg svgRef={svgRef} label={chart.title || `${chart.type} chart`}>
      <Legend names={chart.seriesNames} />
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(tick)} y2={y(tick)} stroke="currentColor" opacity="0.13" />
          <text x={MARGIN.left - 9} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="currentColor" opacity="0.7">
            {formatNumber(tick)}
          </text>
        </g>
      ))}
      <line x1={MARGIN.left} x2={MARGIN.left} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke="currentColor" opacity="0.45" />
      <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={baseline} y2={baseline} stroke="currentColor" opacity="0.45" />
      {chart.type === "bar" ? chart.rows.flatMap((row, rowIndex) => {
        const barWidth = Math.max(2, groupWidth * 0.7 / chart.seriesNames.length);
        return row.map((value, seriesIndex) => {
          const top = Math.min(y(value), baseline);
          const height = Math.max(1, Math.abs(baseline - y(value)));
          return (
            <rect
              key={`${rowIndex}-${seriesIndex}`}
              x={MARGIN.left + rowIndex * groupWidth + groupWidth * 0.15 + seriesIndex * barWidth}
              y={top}
              width={barWidth}
              height={height}
              fill={SERIES_COLORS[seriesIndex % SERIES_COLORS.length]}
              opacity="0.88"
            >
              <title>{`${chart.labels[rowIndex]} · ${chart.seriesNames[seriesIndex]}: ${formatNumber(value)}`}</title>
            </rect>
          );
        });
      }) : chart.seriesNames.map((seriesName, seriesIndex) => {
        const points = chart.rows.map((row, rowIndex) => [x(rowIndex), y(row[seriesIndex])] as const);
        const linePath = points.map(([px, py], index) => `${index === 0 ? "M" : "L"}${px},${py}`).join(" ");
        const areaPath = `${linePath} L${points.at(-1)?.[0]},${baseline} L${points[0][0]},${baseline} Z`;
        const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
        return (
          <g key={seriesName}>
            {chart.type === "area" ? <path d={areaPath} fill={color} opacity="0.18" /> : null}
            <path d={linePath} fill="none" stroke={color} strokeWidth="2.25" />
            {points.map(([px, py], rowIndex) => (
              <circle key={rowIndex} cx={px} cy={py} r="3.5" fill={color}>
                <title>{`${chart.labels[rowIndex]} · ${seriesName}: ${formatNumber(chart.rows[rowIndex][seriesIndex])}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
      {chart.labels.map((label, index) => index % labelStep === 0 ? (
        <text key={label} x={x(index)} y={HEIGHT - MARGIN.bottom + 20} textAnchor="middle" fontSize="11" fill="currentColor" opacity="0.75">
          {label.length > 12 ? `${label.slice(0, 11)}…` : label}
        </text>
      ) : null)}
      {chart.xLabel ? <text x={MARGIN.left + plotWidth / 2} y={HEIGHT - 10} textAnchor="middle" fontSize="12" fill="currentColor">{chart.xLabel}</text> : null}
      {chart.yLabel ? <text x="15" y={MARGIN.top + plotHeight / 2} textAnchor="middle" fontSize="12" fill="currentColor" transform={`rotate(-90 15 ${MARGIN.top + plotHeight / 2})`}>{chart.yLabel}</text> : null}
    </ChartSvg>
  );
}

function ScatterPlot({
  chart,
  svgRef,
}: {
  chart: ScatterChart;
  svgRef: React.RefObject<SVGSVGElement>;
}) {
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const [xLow, xHigh] = paddedDomain(chart.points.map((point) => point.x), false);
  const [yLow, yHigh] = paddedDomain(chart.points.map((point) => point.y), false);
  const xTicks = niceTicks(xLow, xHigh);
  const yTicks = niceTicks(yLow, yHigh);
  const x = (value: number) => MARGIN.left + ((value - xLow) / (xHigh - xLow || 1)) * plotWidth;
  const y = (value: number) => MARGIN.top + plotHeight - ((value - yLow) / (yHigh - yLow || 1)) * plotHeight;

  return (
    <ChartSvg svgRef={svgRef} label={chart.title || "scatter plot"}>
      <Legend names={chart.seriesNames} />
      {yTicks.map((tick) => (
        <g key={`y-${tick}`}>
          <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(tick)} y2={y(tick)} stroke="currentColor" opacity="0.13" />
          <text x={MARGIN.left - 9} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="currentColor" opacity="0.7">{formatNumber(tick)}</text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <g key={`x-${tick}`}>
          <line x1={x(tick)} x2={x(tick)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke="currentColor" opacity="0.08" />
          <text x={x(tick)} y={HEIGHT - MARGIN.bottom + 20} textAnchor="middle" fontSize="11" fill="currentColor" opacity="0.7">{formatNumber(tick)}</text>
        </g>
      ))}
      <rect x={MARGIN.left} y={MARGIN.top} width={plotWidth} height={plotHeight} fill="none" stroke="currentColor" opacity="0.4" />
      {chart.points.map((point, index) => {
        const seriesIndex = chart.seriesNames.indexOf(point.series);
        return (
          <circle
            key={`${point.label}-${index}`}
            cx={x(point.x)}
            cy={y(point.y)}
            r="5"
            fill={SERIES_COLORS[seriesIndex % SERIES_COLORS.length]}
            opacity="0.88"
          >
            <title>{`${point.label} · ${point.series}: (${formatNumber(point.x)}, ${formatNumber(point.y)})`}</title>
          </circle>
        );
      })}
      {chart.xLabel ? <text x={MARGIN.left + plotWidth / 2} y={HEIGHT - 10} textAnchor="middle" fontSize="12" fill="currentColor">{chart.xLabel}</text> : null}
      {chart.yLabel ? <text x="15" y={MARGIN.top + plotHeight / 2} textAnchor="middle" fontSize="12" fill="currentColor" transform={`rotate(-90 15 ${MARGIN.top + plotHeight / 2})`}>{chart.yLabel}</text> : null}
    </ChartSvg>
  );
}

function PieChart({
  chart,
  svgRef,
}: {
  chart: CategoricalChart;
  svgRef: React.RefObject<SVGSVGElement>;
}) {
  const values = chart.rows.map((row) => Math.max(0, row[0]));
  const total = values.reduce((sum, value) => sum + value, 0);
  const centerX = 270;
  const centerY = 218;
  const radius = 145;
  let angle = -Math.PI / 2;
  const slices = values.map((value, index) => {
    const start = angle;
    const sweep = value / total * Math.PI * 2;
    angle += sweep;
    const end = angle;
    const x1 = centerX + radius * Math.cos(start);
    const y1 = centerY + radius * Math.sin(start);
    const x2 = centerX + radius * Math.cos(end);
    const y2 = centerY + radius * Math.sin(end);
    const path = sweep >= Math.PI * 2 - 1e-6
      ? `M${centerX - radius},${centerY} A${radius},${radius} 0 1 0 ${centerX + radius},${centerY} A${radius},${radius} 0 1 0 ${centerX - radius},${centerY}`
      : `M${centerX},${centerY} L${x1},${y1} A${radius},${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2},${y2} Z`;
    return { value, index, path };
  });

  return (
    <ChartSvg svgRef={svgRef} label={chart.title || "pie chart"}>
      {slices.map(({ value, index, path }) => (
        <path key={chart.labels[index]} d={path} fill={SERIES_COLORS[index % SERIES_COLORS.length]} stroke="#ffffff" strokeWidth="1.5">
          <title>{`${chart.labels[index]}: ${formatNumber(value)} (${formatNumber(value / total * 100)}%)`}</title>
        </path>
      ))}
      {chart.labels.map((label, index) => (
        <g key={label} transform={`translate(480 ${90 + index * 28})`}>
          <rect width="11" height="11" y="-9" rx="2" fill={SERIES_COLORS[index % SERIES_COLORS.length]} />
          <text x="18" fontSize="12" fill="currentColor">
            {`${label} · ${formatNumber(values[index] / total * 100)}%`}
          </text>
        </g>
      ))}
    </ChartSvg>
  );
}
