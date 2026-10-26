import { StockVibeInfo } from "@/components/stock-vibe/StockVibeInfo";
import i18n from '../i18n';
/**
 * Alpha Zoo — browse / detail / bench views.
 *
 * Routing model: a single page component, three URL shapes:
 *   /alpha-zoo                 → browse view
 *   /alpha-zoo/bench           → bench runner
 *   /alpha-zoo/:alphaId        → alpha detail
 *
 * Bench and compare views use a shared recoverable job hook for snapshots
 * with Mona durable operations and read-only receipt recovery.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  Layers,
  Search,
  Play,
  ArrowLeft,
  ArrowLeftRight,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Library,
} from "lucide-react";
import { useNativeToast, useNativeSettings } from "../lib/toast";
import { cn } from "@/lib/utils";
import {
  api,
  type AlphaSummary,
  type AlphaDetailResponse,
  type AlphaBenchResult,
  type AlphaBenchTopRow,
  type AlphaCompareResult,
} from "../lib/api";
import { useChartLifecycle } from "../hooks/useChartLifecycle";
import { getChartTheme } from "../lib/chart-theme";
import { useAnalysisState } from "../hooks/useAnalysisState";
import { useAlphaJob } from "../hooks/useAlphaJob";
import type { AlphaReadiness, AlphaDefaults } from "../lib/api";

function useAlphaDefaults() {
  const [data, setData] = useState<AlphaDefaults | null>(null);
  const toast = useNativeToast();
  useEffect(() => { let active = true; void api.getAlphaDefaults().then((value) => { if (active) setData(value); }).catch(() => { if (active) toast.error(i18n.t("monaNative.defaultsError")); }); return () => { active = false; }; }, []);
  return data;
}

/* ---------- Constants ---------- */

interface ZooCard {
  id: string;
  approxCount: number;
}

// IMPORTANT: The Kakushadze 101 zoo must use the author's name as the label.
// The legacy / trademark name is forbidden by a CI grep gate — do not add it.
const ZOO_CARDS: ZooCard[] = [
  {
    id: "qlib158",
    approxCount: 154,
  },
  {
    id: "alpha101",
    approxCount: 101,
  },
  {
    id: "gtja191",
    approxCount: 191,
  },
  {
    id: "academic",
    approxCount: 10,
  },
  {
    id: "fundamental",
    approxCount: 4,
  },
];

// Benchmarkable data universes (bench + compare): each one needs a panel loader
// on the backend, so there is no Korea/India entry — the KRX factor capability
// is a metadata universe, not a benchmark universe.
const UNIVERSE_OPTIONS = [
  { value: "csi300" },
  { value: "sp500" },
  { value: "btc-usdt" },
];

// Metadata universe -> the benchmark universe whose panel represents it. Markets
// without a panel (equity_in, equity_kr, futures) are intentionally absent.
const BENCH_UNIVERSE_FOR_METADATA: Record<string, string> = {
  equity_cn: "csi300",
  equity_us: "sp500",
  crypto: "btc-usdt",
};

// Factor-metadata universes for the browse filter; GET /alpha/list filters on
// these directly (they are the values shown in each alpha's "universe" column).
const FILTER_UNIVERSE_OPTIONS = [
  { value: "equity_us" },
  { value: "equity_cn" },
  { value: "equity_hk" },
  { value: "equity_in" },
  { value: "equity_kr" },
  { value: "crypto" },
  { value: "futures" },
];

const PAGE_SIZE = 50;

/* ---------- Helpers ---------- */

function fmtNum(v: unknown, digits = 3): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function metaString(meta: Record<string, unknown>, key: string): string {
  const v = meta[key];
  if (v === undefined || v === null || v === "") return "—";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/* ---------- Page entry ---------- */

export function AlphaZoo() {
  const params = useParams<{ alphaId?: string }>();
  const { pathname } = useLocation();

  // Internal view selection
  if (pathname === "/alpha-zoo/bench") {
    return <BenchView />;
  }
  if (pathname === "/alpha-zoo/compare") {
    return <CompareView />;
  }
  if (params.alphaId) {
    return <DetailView alphaId={params.alphaId} />;
  }
  return <BrowseView />;
}

/* ---------- Browse view ---------- */

function BrowseView() {
  const toast = useNativeToast();
  const defaults = useAlphaDefaults();
  const [alphas, setAlphas] = useState<AlphaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useAnalysisState("alpha-browse", { zooFilter: "", themeFilter: "", universeFilter: "", search: "", visibleCount: PAGE_SIZE, selected: [] as string[] });
  const { zooFilter, themeFilter, universeFilter, search, visibleCount } = draft;
  const selected = new Set(draft.selected);
  const setZooFilter = (zooFilter: string) => setDraft((d) => ({ ...d, zooFilter, visibleCount: PAGE_SIZE }));
  const setThemeFilter = (themeFilter: string) => setDraft((d) => ({ ...d, themeFilter, visibleCount: PAGE_SIZE }));
  const setUniverseFilter = (universeFilter: string) => setDraft((d) => ({ ...d, universeFilter, visibleCount: PAGE_SIZE }));
  const setSearch = (search: string) => setDraft((d) => ({ ...d, search }));
  const setVisibleCount = (update: number | ((n: number) => number)) => setDraft((d) => ({ ...d, visibleCount: typeof update === "function" ? update(d.visibleCount) : update }));
  const [total, setTotal] = useState(0);
  const toggleSelected = (id: string) => setDraft((d) => ({ ...d, selected: d.selected.includes(id) ? d.selected.filter((v) => v !== id) : [...d.selected, id] }));

  const compareHref =
    selected.size >= 2
      ? `/alpha-zoo/compare?ids=${[...selected].map(encodeURIComponent).join(",")}`
      : "/alpha-zoo/compare";

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .listAlphas({
        limit: 1000,
      })
      .then((res) => {
        if (!alive) return;
        setAlphas(res.alphas);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : i18n.t("alphaZoo.failedToLoadAlphas" as any);
        toast.error(msg);
        setAlphas([]);
        setTotal(0);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const themeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of alphas) for (const t of a.theme || []) set.add(t);
    return Array.from(set).sort();
  }, [alphas]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return alphas.filter((a) => (!zooFilter || a.zoo === zooFilter)
      && (!themeFilter || a.theme?.includes(themeFilter))
      && (!universeFilter || a.universe?.includes(universeFilter))
      && (!q || a.id.toLowerCase().includes(q) || (a.nickname || "").toLowerCase().includes(q)));
  }, [alphas, search, zooFilter, themeFilter, universeFilter]);

  const visible = filtered.slice(0, visibleCount);

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-8">
      {/* Hero */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-caption text-muted-foreground uppercase tracking-wide">
          <Layers className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.title")}
        </div>
        <h1 className="text-title font-semibold tracking-tight">
          {loading
            ? i18n.t("alphaZoo.prebuiltAlphaLoading")
            : i18n.t("alphaZoo.prebuiltAlpha", { count: total })}
        </h1>
        <p className="text-ui text-muted-foreground max-w-2xl">
          {i18n.t("alphaZoo.browseDesc")}
        </p>
      </div>

      {/* Zoo cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {ZOO_CARDS.map((z) => {
          const active = zooFilter === z.id;
          return (
            <button
              key={z.id}
              type="button"
              onClick={() => setZooFilter(active ? "" : z.id)}
              className={cn(
                "text-left rounded-lg border border-border/60 bg-card p-4 space-y-2 shadow-none transition",
                "bg-none hover:bg-muted/60",
                active && "border-[hsl(var(--info))]/40 bg-[hsl(var(--info))]/10 text-[hsl(var(--info))]",
              )}
            >
              <div className="flex items-center justify-between">
                <Library className="h-5 w-5 text-[hsl(var(--info))]" aria-hidden="true" />
                <span className="text-caption font-mono text-muted-foreground">
                  {defaults?.registry.zoo_counts[z.id] ?? "—"}
                </span>
              </div>
              <h3 className="font-semibold text-ui leading-tight">{i18n.t("alphaZoo.zooCardTitle." + z.id as any)}</h3>
              <p className="text-caption text-muted-foreground line-clamp-3">
                {i18n.t("alphaZoo.zooCardDesc." + z.id as any)}
              </p>
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <div className="flex flex-col md:flex-row md:items-end gap-3 rounded-lg border border-border/60 bg-card p-4 shadow-none">
        <div className="flex-1 min-w-0">
          <label htmlFor="alpha-search" className="text-caption text-muted-foreground block mb-1">
            {i18n.t("alphaZoo.search")}
          </label>
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              id="alpha-search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                      }}
              placeholder={i18n.t("alphaZoo.searchPlaceholder")}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30"
            />
          </div>
        </div>
        <div className="md:w-40">
          <label htmlFor="alpha-zoo-filter" className="text-caption text-muted-foreground block mb-1">{i18n.t("alphaZoo.zoo")}</label>
          <select
            id="alpha-zoo-filter"
            value={zooFilter}
            onChange={(e) => setZooFilter(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30"
          >
            <option value="">{i18n.t("alphaZoo.allZoos")}</option>
            {ZOO_CARDS.map((z) => (
              <option key={z.id} value={z.id}>
                {i18n.t("alphaZoo.zooCardTitle." + z.id as any)}
              </option>
            ))}
          </select>
        </div>
        <div className="md:w-40">
          <label htmlFor="alpha-theme-filter" className="text-caption text-muted-foreground block mb-1">
            {i18n.t("alphaZoo.theme")}
          </label>
          <select
            id="alpha-theme-filter"
            value={themeFilter}
            onChange={(e) => setThemeFilter(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30"
          >
            <option value="">{i18n.t("alphaZoo.allThemes")}</option>
            {themeOptions.map((tname) => (
              <option key={tname} value={tname}>
                {i18n.t("alphaZoo.themes." + tname, { defaultValue: tname })}
              </option>
            ))}
          </select>
        </div>
        <div className="md:w-44">
          <label htmlFor="alpha-universe-filter" className="text-caption text-muted-foreground block mb-1">
            {i18n.t("alphaZoo.universe")}
          </label>
          <select
            id="alpha-universe-filter"
            value={universeFilter}
            onChange={(e) => setUniverseFilter(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30"
          >
            <option value="">{i18n.t("alphaZoo.allUniverses")}</option>
            {FILTER_UNIVERSE_OPTIONS.map((u) => (
              <option key={u.value} value={u.value} disabled={u.value === "btc-usdt"}>
                {i18n.t("alphaZoo.universeOption." + u.value as any)}
              </option>
            ))}
          </select>
        </div>
        <Link
          to={compareHref}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-border/60 text-ui font-medium hover:bg-muted/60 hover:text-foreground transition"
          title={i18n.t("alphaZoo.compareTooltip")}
        >
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.compare")}
          {selected.size >= 2 ? ` (${selected.size})` : ""}
        </Link>
        <Link
          to={selected.size === 1 ? `/alpha-zoo/bench?alpha_id=${encodeURIComponent([...selected][0])}&zoo=${encodeURIComponent(alphas.find((a) => a.id === [...selected][0])?.zoo ?? "alpha101")}&universe=${alphas.find((a) => a.id === [...selected][0])?.universe.includes("equity_us") ? "sp500" : "csi300"}` : selected.size > 1 ? compareHref : "/alpha-zoo/bench"}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[hsl(var(--info))] text-primary-foreground text-ui font-medium hover:opacity-90 transition"
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> {selected.size ? i18n.t("analysis.evaluateSelected", { count: selected.size }) : i18n.t("alphaZoo.runBenchmark")}
        </Link>
      </div>

      <p className="text-ui text-muted-foreground">{i18n.t("analysis.factorSelectionHint")}</p>
      {/* Table */}
      {/* TODO(v0.2): switch to react-window if alpha count exceeds 5000 */}
      <div className="overflow-hidden rounded-lg border border-border/60 bg-card shadow-none">
        <div className="overflow-x-auto">
          <table className="w-full text-ui" aria-label={i18n.t("alphaZoo.alphaCatalogue")}>
            <caption className="sr-only">{i18n.t("alphaZoo.alphaCatalogue")}</caption>
            <thead>
              <tr className="border-b bg-muted/40 text-micro uppercase tracking-wide text-muted-foreground [&_th]:font-medium">
                <th className="w-10 px-3 py-2.5">
                  <span className="sr-only">{i18n.t("alphaZoo.selectForCompare")}</span>
                </th>
                <th className="text-left px-4 py-2.5">
                  {i18n.t("alphaZoo.id")}
                </th>
                <th className="text-left px-4 py-2.5">
                  {i18n.t("alphaZoo.zoo")}
                </th>
                <th className="text-left px-4 py-2.5">
                  {i18n.t("alphaZoo.theme")}
                </th>
                <th className="text-left px-4 py-2.5 hidden md:table-cell">
                  {i18n.t("alphaZoo.universe")}
                </th>
                <th className="text-right px-4 py-2.5" title={i18n.t("alphaZoo.predictiveHalfLifeTitle")}>
                  {i18n.t("alphaZoo.decayDays")}
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" aria-hidden="true" />
                    {i18n.t("alphaZoo.loadingAlphas")}
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {i18n.t("alphaZoo.noAlphasMatch")}
                  </td>
                </tr>
              ) : (
                visible.map((a) => (
                  <tr
                    key={`${a.zoo}:${a.id}`}
                    className={cn(
                      "border-b last:border-0 hover:bg-muted/40",
                      selected.has(a.id) && "bg-[hsl(var(--info))]/10",
                    )}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(a.id)}
                        onChange={() => toggleSelected(a.id)}
                        aria-label={i18n.t("alphaZoo.selectAlphaForCompare" as any, { id: a.id })}
                        className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-2 font-mono text-caption">
                      <Link
                        to={`/alpha-zoo/${encodeURIComponent(a.id)}`}
                        className="text-[hsl(var(--info))] hover:underline"
                      >
                        {a.id}
                      </Link>
                      {a.nickname && (
                        <span className="ml-2 text-muted-foreground font-sans">
                          {a.nickname}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-caption">{a.zoo}</td>
                    <td className="px-4 py-2 text-caption text-muted-foreground">
                      {(a.theme || []).map((t) => i18n.t("alphaZoo.themes." + t, { defaultValue: t })).join(", ") || "—"}
                    </td>
                    <td className="px-4 py-2 text-caption text-muted-foreground hidden md:table-cell">
                      {(a.universe || []).map((u) => i18n.t("alphaZoo.universeOption." + u, { defaultValue: u })).join(", ") || "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums text-caption">
                      {a.decay_horizon ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!loading && visible.length < filtered.length && (
          <div className="border-t p-3 flex items-center justify-between text-caption text-muted-foreground">
            <span>
              {i18n.t("alphaZoo.showingOf", { visible: visible.length, total: filtered.length })}
            </span>
            <button
              type="button"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="px-3 py-1 rounded-md border border-border/60 hover:bg-muted/60 hover:text-foreground transition"
            >
              {i18n.t("alphaZoo.loadMore")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Detail view ---------- */

interface DetailProps {
  alphaId: string;
}

function DetailView({ alphaId }: DetailProps) {
  const [detail, setDetail] = useState<AlphaDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getAlpha(alphaId)
      .then((res) => {
        if (alive) setDetail(res);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : i18n.t("alphaZoo.failedToLoadAlpha" as any);
        setError(msg);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [alphaId]);

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" /> {i18n.t("alphaZoo.loadingAlpha", { id: alphaId })}
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="p-8 max-w-3xl mx-auto space-y-4">
        <Link to="/alpha-zoo" className="text-ui text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.backToAlphaZoo")}
        </Link>
        <div className="rounded-lg border border-border/60 bg-card p-5 shadow-none">
          <h2 className="font-semibold text-ui mb-1 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" /> {i18n.t("alphaZoo.couldNotLoad")}
          </h2>
          <p className="text-ui text-muted-foreground">{error || i18n.t("alphaZoo.unknownError")}</p>
        </div>
      </div>
    );
  }

  const a = detail.alpha;
  const meta = a.meta || {};
  const formulaLatex = (meta["formula_latex"] as string | undefined) || "";
  const nickname = (meta["nickname"] as string | undefined) || "";
  // An alpha's metadata universes (equity_us, equity_kr, ...) are not bench
  // universes; only the three names with panel loaders are. Translate, and drop
  // the prefill when the alpha's markets have no benchmark panel (Korea, India)
  // rather than handing BenchView a value its selector cannot hold.
  const benchUniverse = (((meta["universe"] as string[] | undefined) || [])
    .map((u) => BENCH_UNIVERSE_FOR_METADATA[u])
    .find(Boolean)) || "";

  // Carry only this explicitly selected factor and its compatible universe;
  // a required period without an execution default remains user-specified.
  const benchHref = benchUniverse
    ? `/alpha-zoo/bench?zoo=${encodeURIComponent(a.zoo)}&universe=${encodeURIComponent(benchUniverse)}&alpha_id=${encodeURIComponent(a.id)}`
    : `/alpha-zoo/bench?zoo=${encodeURIComponent(a.zoo)}&alpha_id=${encodeURIComponent(a.id)}`;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link
          to="/alpha-zoo"
          className="text-ui text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.backToAlphaZoo")}
        </Link>
        <button
          type="button"
          onClick={() => navigate(benchHref)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[hsl(var(--info))] text-primary-foreground text-caption font-medium hover:opacity-90 transition"
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("analysis.evaluateFactor")}
        </button>
      </div>

      {/* Title */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="font-mono text-title font-semibold tracking-tight">
            {a.id}
          </h1>
          <span className="text-caption px-2 py-0.5 rounded-full bg-[hsl(var(--info))]/10 text-[hsl(var(--info))] font-medium">
            {a.zoo}
          </span>
        </div>
        {nickname && (
          <p className="text-ui text-muted-foreground">{nickname}</p>
        )}
      </div>

      {/* Formula */}
      <section className="space-y-2">
        <h2 className="text-ui font-semibold text-muted-foreground">{i18n.t("alphaZoo.formula")}</h2>
        <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-4 text-caption leading-relaxed shadow-none">
          <code>{formulaLatex || i18n.t("alphaZoo.noFormula")}</code>
        </pre>
      </section>

      {/* Metadata */}
      <section className="space-y-2">
        <h2 className="text-ui font-semibold text-muted-foreground">{i18n.t("alphaZoo.metadata")}</h2>
        <div className="overflow-x-auto rounded-lg border border-border/60 bg-card shadow-none">
          <table className="w-full text-ui">
            <tbody>
              <MetaRow
                label={i18n.t("alphaZoo.theme")}
                value={
                  Array.isArray(meta.theme)
                    ? meta.theme.map((t: string) => i18n.t("alphaZoo.themes." + t, { defaultValue: t })).join(", ")
                    : typeof meta.theme === "string"
                    ? i18n.t("alphaZoo.themes." + meta.theme, { defaultValue: meta.theme })
                    : "—"
                }
              />
              <MetaRow
                label={i18n.t("alphaZoo.universe")}
                value={
                  Array.isArray(meta.universe)
                    ? meta.universe.map((u: string) => i18n.t("alphaZoo.universeOption." + u, { defaultValue: u })).join(", ")
                    : typeof meta.universe === "string"
                    ? i18n.t("alphaZoo.universeOption." + meta.universe, { defaultValue: meta.universe })
                    : "—"
                }
              />
              <MetaRow label={i18n.t("alphaZoo.frequency")} value={metaString(meta, "frequency")} />
              <MetaRow label={i18n.t("alphaZoo.decayHorizon")} value={metaString(meta, "decay_horizon")} />
              <MetaRow label={i18n.t("alphaZoo.minWarmupBars")} value={metaString(meta, "min_warmup_bars")} />
              <MetaRow label={i18n.t("alphaZoo.requiresSector")} value={metaString(meta, "requires_sector")} />
              <MetaRow label={i18n.t("alphaZoo.modulePath")} value={a.module_path || "—"} />
              <MetaRow label={i18n.t("alphaZoo.notes")} value={metaString(meta, "notes")} last />
            </tbody>
          </table>
        </div>
      </section>

      {/* Source code */}
      <section className="space-y-2">
        <h2 className="text-ui font-semibold text-muted-foreground">{i18n.t("alphaZoo.sourceCode")}</h2>
        <StockVibeInfo title={i18n.t("alphaZoo.sourceCode")} label={i18n.t("alphaZoo.viewSource", { lines: (detail.source_code || "").split("\n").length })}>
          <pre className="border-t border-border/60 bg-muted/40 p-4 overflow-x-auto text-caption leading-relaxed">
            <code>{detail.source_code || i18n.t("alphaZoo.noSource")}</code>
          </pre>
        </StockVibeInfo>
      </section>
    </div>
  );
}

function MetaRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <tr className={cn(!last && "border-b", "hover:bg-muted/40")}>
      <td className="px-4 py-2 text-caption text-muted-foreground w-1/3">{label}</td>
      <td className="px-4 py-2 text-caption font-mono break-all">{value}</td>
    </tr>
  );
}

/* ---------- Bench view ---------- */



interface BenchProgress {
  n_done: number;
  n_total: number;
  current_alpha_id?: string;
  stage?: "loading_data" | "preparing_returns" | "computing";
}

function BenchView() {
  // Read prefill from query string (set by Detail "Run bench" button).
  const { search: locSearch } = useLocation();
  const initial = useMemo(() => {
    const q = new URLSearchParams(locSearch);
    return {
      zoo: q.get("zoo") || "",
      universe: q.get("universe") || "",
      period: q.get("period") || "",
      top: Number(q.get("top") || "NaN"),
      alphaId: q.get("alpha_id") || "",
    };
  }, [locSearch]);

  const [draft, setDraft] = useAnalysisState(`alpha-bench:${initial.zoo}:${initial.alphaId}`, { ...initial });
  const { zoo, universe, period, top, alphaId } = draft;
  const defaults = useAlphaDefaults();
  const topSchema = defaults?.bench.request_schema.properties.top;
  useEffect(() => { if (typeof topSchema?.default === "number") setDraft((current) => Number.isFinite(current.top) ? current : { ...current, top: topSchema.default as number }); }, [topSchema?.default, setDraft]);
  const setZoo = (zoo: string) => setDraft((d) => ({ ...d, zoo }));
  const setUniverse = (universe: string) => setDraft((d) => ({ ...d, universe }));
  const setPeriod = (period: string) => setDraft((d) => ({ ...d, period }));
  const setTop = (top: number) => setDraft((d) => ({ ...d, top }));
  const job = useAlphaJob<AlphaBenchResult>("bench", `${initial.zoo}:${initial.alphaId}`);
  const { status, jobId, progress, result, formError, busy } = job;
  const readiness = useReadiness();
  const startBench = async (event: FormEvent) => {
    event.preventDefault();
    if (!zoo || !universe || !period.trim()) { job.setFormError(i18n.t("monaNative.required")); return; }
    if (!Number.isInteger(top) || top < (topSchema?.minimum ?? 1) || top > (topSchema?.maximum ?? 500)) { job.setFormError(i18n.t("monaNative.invalidTop")); return; }
    if (universe === "btc-usdt") { job.setFormError(i18n.t("analysis.ready_single_asset")); return; }
    await job.submit({ zoo, universe, period, top, ...(alphaId ? { alpha_id: alphaId } : {}) });
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      <Link
        to="/alpha-zoo"
        className="text-ui text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.backToAlphaZoo")}
      </Link>

      <div className="space-y-1">
        <div className="flex items-center gap-2 text-caption text-muted-foreground uppercase tracking-wide">
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.benchRunner")}
        </div>
        <h1 className="text-title font-semibold tracking-tight">
          {alphaId ? i18n.t("analysis.evaluateFactor") : i18n.t("alphaZoo.scoreZoo")}
        </h1>
        <p className="text-ui text-muted-foreground max-w-2xl">
          {alphaId ? i18n.t("analysis.selectedFactor", { id: alphaId }) : i18n.t("alphaZoo.scoreDesc")}
        </p>
      </div>

      {/* Form */}
      <form
        onSubmit={startBench}
        className="grid grid-cols-1 items-end gap-3 rounded-lg border border-border/60 bg-card p-4 shadow-none sm:grid-cols-2 lg:grid-cols-5"
      >
        <div>
          <label htmlFor="bench-zoo" className="text-caption text-muted-foreground block mb-1">{i18n.t("alphaZoo.zoo")}</label>
          <select
            id="bench-zoo"
            value={zoo}
            onChange={(e) => setZoo(e.target.value)}
            disabled={busy || Boolean(alphaId)}
            className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30 disabled:opacity-50"
          >
            <option value="">{i18n.t("monaNative.choose")}</option>
            {ZOO_CARDS.map((z) => (
              <option key={z.id} value={z.id}>
                {i18n.t("alphaZoo.zooCardTitle." + z.id as any)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bench-universe" className="text-caption text-muted-foreground block mb-1">{i18n.t("alphaZoo.universe")}</label>
          <select
            id="bench-universe"
            value={universe}
            onChange={(e) => setUniverse(e.target.value)}
            disabled={busy}
            className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30 disabled:opacity-50"
          >
            <option value="">{i18n.t("monaNative.choose")}</option>
            {UNIVERSE_OPTIONS.map((u) => (
              <option key={u.value} value={u.value} disabled={u.value === "btc-usdt"}>
                {i18n.t("alphaZoo.universeOption." + u.value as any)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bench-period" className="text-caption text-muted-foreground block mb-1">{i18n.t("alphaZoo.period")}</label>
          <input
            id="bench-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            disabled={busy}
            placeholder="2020-2025"
            className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30 disabled:opacity-50"
          />
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2"><label htmlFor="bench-top" className="text-caption text-muted-foreground">{i18n.t("analysis.resultLimit")}</label><StockVibeInfo title={i18n.t("analysis.resultLimit")} label="?"><p>{i18n.t("monaNative.topHelp")}</p></StockVibeInfo></div>
          <input
            id="bench-top"
            type="number"
            min={topSchema?.minimum ?? 1}
            max={topSchema?.maximum ?? 500}
            value={Number.isFinite(top) ? top : ""}
            onChange={(e) =>
              // Preserve an empty edit; validation prevents invalid submissions.
              setTop(e.target.value === "" ? Number.NaN : Number(e.target.value))
            }
            disabled={busy}
            className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30 disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[hsl(var(--info))] text-primary-foreground text-ui font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> {i18n.t("alphaZoo.running")}
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.runBenchmark")}
              </>
            )}
          </button>
        </div>
        {formError && (
          <p
            className="sm:col-span-2 lg:col-span-5 text-caption text-destructive"
            role="alert"
          >
            {formError}
          </p>
        )}
      </form>

      {zoo === "fundamental" && <p className="text-ui text-muted-foreground">{i18n.t("analysis.fundamentalsRequirement")}</p>}
      <ReadinessPanel readiness={readiness} universe={universe} count={alphaId ? 1 : readiness.data?.zoo_counts[zoo]} />
      {status === "disconnected" && <button type="button" onClick={job.reconnect} className="text-[hsl(var(--info))] underline">{i18n.t("monaNative.checkStatus")}</button>}
      {/* Progress */}
      {(status === "submitting" || status === "streaming" || status === "disconnected") && (
        <ProgressPanel jobId={jobId} progress={progress} />
      )}

      {/* Result */}
      {result && job.request && <p className="text-ui text-muted-foreground">{i18n.t("alphaZoo.universe")}: {i18n.t("alphaZoo.universeOption." + job.request.universe, { defaultValue: job.request.universe })} · {i18n.t("alphaZoo.period")}: {job.request.period}</p>}
      {result && <ResultPanel result={result} />}
    </div>
  );
}

function ProgressPanel({
  jobId,
  progress,
}: {
  jobId: string | null;
  progress: BenchProgress | null;
}) {
  const pct = progress && progress.n_total > 0
    ? Math.min(100, Math.round((progress.n_done / progress.n_total) * 100))
    : 0;
  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-card p-4 shadow-none">
      <div className="flex items-center justify-between text-caption text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {jobId
            ? i18n.t("alphaZoo.job" as any, { id: jobId.slice(0, 12) })
            : i18n.t("alphaZoo.submitting")}
        </span>
        {progress && (
          <span className="font-mono tabular-nums">
            {progress.n_done} / {progress.n_total}
          </span>
        )}
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-[hsl(var(--info))] transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-ui text-muted-foreground">{progress?.stage ? i18n.t(`analysis.stage_${progress.stage}`) : i18n.t("monaNative.working")}</p>
      <p className="text-caption text-muted-foreground">{i18n.t("analysis.backgroundJob")}</p>
      {progress?.current_alpha_id && (
        <p className="text-caption text-muted-foreground font-mono truncate">
          {i18n.t("alphaZoo.computing", { id: progress.current_alpha_id })}
        </p>
      )}
    </div>
  );
}

function ResultPanel({ result }: { result: AlphaBenchResult }) {
  const chartRef = useRef<HTMLDivElement>(null);

  useChartLifecycle(chartRef, () => {
    const theme = getChartTheme();
    const themes = Object.keys(result.by_theme || {}).sort();
    const aliveSeries = themes.map((k) => result.by_theme[k].alive);
    const reversedSeries = themes.map((k) => result.by_theme[k].reversed);
    const deadSeries = themes.map((k) => result.by_theme[k].dead);

    return {
      backgroundColor: "transparent",
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: {
        data: [i18n.t("alphaZoo.alive"), i18n.t("alphaZoo.reversed"), i18n.t("alphaZoo.dead")],
        textStyle: { color: theme.textColor, fontSize: 11 },
        right: 8,
        top: 4,
      },
      grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: themes.map((t) => i18n.t("alphaZoo.themes." + t, { defaultValue: t })),
        axisLine: { lineStyle: { color: theme.axisColor } },
        axisLabel: { color: theme.textColor, fontSize: 11, rotate: themes.length > 6 ? 30 : 0 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: theme.gridColor } },
        axisLabel: { color: theme.textColor, fontSize: 11 },
      },
      series: [
        { name: i18n.t("alphaZoo.alive"), type: "bar", stack: "n", data: aliveSeries, itemStyle: { color: theme.upColor } },
        { name: i18n.t("alphaZoo.reversed"), type: "bar", stack: "n", data: reversedSeries, itemStyle: { color: theme.warningColor } },
        { name: i18n.t("alphaZoo.dead"), type: "bar", stack: "n", data: deadSeries, itemStyle: { color: theme.downColor } },
      ],
    };
  }, [result]);

  const totals = [
    { label: i18n.t("alphaZoo.alive"), value: result.alive, icon: CheckCircle2, tone: "text-success" },
    { label: i18n.t("alphaZoo.reversed"), value: result.reversed, icon: AlertTriangle, tone: "text-warning" },
    { label: i18n.t("alphaZoo.dead"), value: result.dead, icon: XCircle, tone: "text-destructive" },
    { label: i18n.t("alphaZoo.skipped"), value: result.skipped ?? 0, icon: Loader2, tone: "text-muted-foreground" },
  ];

  return (
    <div className="space-y-4">
      <FactorDataNotice meta={result.meta} />
      {result.n_alphas_tested === 0 && <p role="alert" className="text-warning">{i18n.t("analysis.noEvaluableFactors")}</p>}
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {totals.map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="flex items-center gap-3 rounded-lg border border-border/60 bg-card p-4 shadow-none">
            <Icon className={cn("h-5 w-5 shrink-0", tone)} aria-hidden="true" />
            <div>
              <p className="text-caption text-muted-foreground">{label}</p>
              <p className="font-mono text-title-sm font-semibold tabular-nums">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Top tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopTable title={i18n.t("alphaZoo.topByIr")} rows={result.top5_by_ir || []} />
        <TopTable title={i18n.t("alphaZoo.mostReversed")} rows={(result.dead_examples || []).slice(0, 3)} />
      </div>

      {/* By-theme breakdown */}
      {result.by_theme && Object.keys(result.by_theme).length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card p-4 shadow-none">
          <h3 className="text-ui font-semibold text-muted-foreground mb-2">
            {i18n.t("alphaZoo.byTheme")}
          </h3>
          <div ref={chartRef} style={{ height: 240 }} />
        </div>
      )}
    </div>
  );
}

function TopTable({ title, rows }: { title: string; rows: AlphaBenchTopRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card shadow-none">
      <div className="px-4 py-2.5 border-b border-border/60 bg-muted/40">
        <h3 className="text-ui font-semibold text-muted-foreground">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-caption text-muted-foreground text-center">
          {i18n.t("alphaZoo.noRows")}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-ui">
            <thead>
              <tr className="border-b bg-muted/40 text-micro uppercase tracking-wide text-muted-foreground [&_th]:font-medium">
                <th className="text-left px-4 py-2 font-medium">{i18n.t("alphaZoo.id")}</th>
                <th className="text-right px-4 py-2 font-medium">{i18n.t("alphaZoo.meanIc")}</th>
                <th className="text-right px-4 py-2 font-medium">{i18n.t("alphaZoo.ir")}</th>
                <th className="text-left px-4 py-2 font-medium">{i18n.t("alphaZoo.theme")}</th>
                <th className="text-left px-4 py-2 font-medium">{i18n.t("alphaZoo.category")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2">
                    <Link
                      to={`/alpha-zoo/${encodeURIComponent(r.id)}`}
                      className="text-[hsl(var(--info))] hover:underline font-mono text-caption"
                    >
                      {r.id}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-caption">{fmtNum(r.ic_mean)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-caption">{fmtNum(r.ir)}</td>
                  <td className="px-4 py-2 text-caption text-muted-foreground">
                    {(r.theme || []).map((t) => i18n.t("alphaZoo.themes." + t, { defaultValue: t })).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2 text-caption">
                    <CategoryBadge category={r.category} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Render the alpha bench category as a colored badge so users can see whether
 * a row is alive / reversed / dead at a glance. The "Most reversed" panel
 * mixes reversed + dead rows; the badge keeps them distinguishable.
 */
function CategoryBadge({ category }: { category: AlphaBenchTopRow["category"] }) {
  const tone =
    category === "alive"
      ? "bg-success/10 text-success"
      : category === "reversed"
        ? "bg-warning/10 text-warning"
        : "bg-destructive/10 text-destructive";
  const label =
    category === "alive"
      ? i18n.t("alphaZoo.alive")
      : category === "reversed"
        ? i18n.t("alphaZoo.reversed")
        : i18n.t("alphaZoo.dead");
  return (
    <span className={cn("inline-block px-2 py-0.5 rounded-full text-micro font-medium", tone)}>
      {label}
    </span>
  );
}

/* ---------- Compare view ---------- */

const SORT_OPTIONS = [
  { value: "ir" },
  { value: "ic_mean" },
  { value: "ic_positive_ratio" },
  { value: "ic_count" },
];

/** Split a free-text id list on commas / whitespace; dedupe, preserve order. */
function parseAlphaIds(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const id = raw.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Head-to-head comparison of a hand-picked set of alphas.
 *
 * Uses the same recoverable job lifecycle as {@link BenchView}. Ids are prefilled from `?ids=a,b,c` — set by
 * the BrowseView multi-select — and remain editable as free text.
 */
function CompareView() {
  const { search: locSearch } = useLocation();
  const initialIds = useMemo(() => {
    const q = new URLSearchParams(locSearch);
    return parseAlphaIds(q.get("ids") || "").join(", ");
  }, [locSearch]);

  const [draft, setDraft] = useAnalysisState(`alpha-compare:${initialIds}`, { idsText: initialIds, universe: "", period: "", sort: "" });
  const defaults = useAlphaDefaults();
  const defaultSort = defaults?.compare.request_schema.properties.sort.default;
  useEffect(() => { if (typeof defaultSort === "string") setDraft((current) => current.sort ? current : { ...current, sort: defaultSort }); }, [defaultSort, setDraft]);
  const { idsText, universe, period, sort } = draft;
  const setIdsText = (idsText: string) => setDraft((d) => ({ ...d, idsText }));
  const setUniverse = (universe: string) => setDraft((d) => ({ ...d, universe }));
  const setPeriod = (period: string) => setDraft((d) => ({ ...d, period }));
  const setSort = (sort: string) => setDraft((d) => ({ ...d, sort }));
  const job = useAlphaJob<AlphaCompareResult>("compare", initialIds || "default");
  const { status, jobId, progress, result, formError, busy } = job;
  const readiness = useReadiness();
  const ids = useMemo(() => parseAlphaIds(idsText), [idsText]);
  const startCompare = async (event: FormEvent) => {
    event.preventDefault();
    if (ids.length < 2) { job.setFormError(i18n.t("alphaZoo.enterAtLeast2")); return; }
    if (universe === "btc-usdt") { job.setFormError(i18n.t("analysis.ready_single_asset")); return; }
    if (!universe || !period.trim()) { job.setFormError(i18n.t("monaNative.required")); return; }
    await job.submit({ alpha_ids: ids, universe, period, ...(sort ? { sort } : {}) });
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      <Link
        to="/alpha-zoo"
        className="text-ui text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.backToAlphaZoo")}
      </Link>

      <div className="space-y-1">
        <div className="flex items-center gap-2 text-caption text-muted-foreground uppercase tracking-wide">
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.headToHeadCompare")}
        </div>
        <h1 className="text-title font-semibold tracking-tight">
          {i18n.t("alphaZoo.compareAlphas")}
        </h1>
        <p className="text-ui text-muted-foreground max-w-2xl">
          {i18n.t("alphaZoo.compareDesc")}
        </p>
      </div>

      <form onSubmit={startCompare} className="space-y-3 rounded-lg border border-border/60 bg-card p-4 shadow-none">
        <div>
          <label htmlFor="compare-ids" className="text-caption text-muted-foreground block mb-1">
            {i18n.t("alphaZoo.alphaIds")}{ids.length > 0 ? ` (${ids.length} ${i18n.t("alphaZoo.selected")})` : ""}
          </label>
          <textarea
            id="compare-ids"
            value={idsText}
            onChange={(e) => setIdsText(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="alpha101_1, alpha101_2, gtja191_5"
            className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui font-mono focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30 disabled:opacity-50"
          />
          <p className="text-micro text-muted-foreground mt-1">
            {i18n.t("alphaZoo.alphaIdsHint")}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="compare-universe" className="text-caption text-muted-foreground block mb-1">{i18n.t("alphaZoo.universe")}</label>
            <select
              id="compare-universe"
              value={universe}
              onChange={(e) => setUniverse(e.target.value)}
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30 disabled:opacity-50"
            >
              <option value="">{i18n.t("monaNative.choose")}</option>
            {UNIVERSE_OPTIONS.map((u) => (
                <option key={u.value} value={u.value} disabled={u.value === "btc-usdt"}>
                  {i18n.t("alphaZoo.universeOption." + u.value as any)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="compare-period" className="text-caption text-muted-foreground block mb-1">{i18n.t("alphaZoo.period")}</label>
            <input
              id="compare-period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              disabled={busy}
              placeholder="2020-2025"
              className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30 disabled:opacity-50"
            />
          </div>
          <div>
            <label htmlFor="compare-sort" className="text-caption text-muted-foreground block mb-1">{i18n.t("alphaZoo.rankBy")}</label>
            <select
              id="compare-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-ui focus:outline-none focus:ring-1 focus:ring-[hsl(var(--info))]/30 disabled:opacity-50"
            >
              {SORT_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {i18n.t("alphaZoo.sortOption." + (s.value === "ic_mean" ? "icMean" : s.value === "ic_positive_ratio" ? "icPositiveRatio" : s.value === "ic_count" ? "icCount" : s.value) as any)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || ids.length < 2}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[hsl(var(--info))] text-primary-foreground text-ui font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> {i18n.t("alphaZoo.running")}
              </>
            ) : (
              <>
                <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.compare")}
              </>
            )}
          </button>
          {ids.length < 2 && (
            <span className="text-caption text-muted-foreground">{i18n.t("alphaZoo.pickAtLeast2")}</span>
          )}
        </div>

        {formError && (
          <p className="text-caption text-destructive" role="alert">
            {formError}
          </p>
        )}
      </form>

      <ReadinessPanel readiness={readiness} universe={universe} count={ids.length} />
      {status === "disconnected" && <button type="button" onClick={job.reconnect} className="text-[hsl(var(--info))] underline">{i18n.t("monaNative.checkStatus")}</button>}
      {(status === "submitting" || status === "streaming" || status === "disconnected") && (
        <ProgressPanel jobId={jobId} progress={progress} />
      )}

      {result && <CompareResultPanel result={result} />}
    </div>
  );
}

function CompareResultPanel({ result }: { result: AlphaCompareResult }) {
  const deltaKey = `delta_${result.sort}_vs_best`;
  return (
    <div className="space-y-4">
      <FactorDataNotice meta={result.meta} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui">
        <span className="inline-flex items-center gap-1.5 font-medium text-success">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {i18n.t("alphaZoo.winner")}:{" "}
          <span className="font-mono">{result.winner}</span>
        </span>
        <span className="text-muted-foreground">
          {i18n.t("alphaZoo.comparedRankedBy", {
            count: result.n_compared,
            sort: result.sort,
            universe: result.universe,
            period: result.period,
          })}
        </span>
        {result.n_skipped > 0 && (
          <span className="inline-flex items-center gap-1 text-warning">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {i18n.t("alphaZoo.skippedCount", { count: result.n_skipped })}
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border/60 bg-card shadow-none">
        <div className="overflow-x-auto">
          <table className="w-full text-ui" aria-label={i18n.t("alphaZoo.alphaComparisonRanking")}>
            <thead>
              <tr className="border-b bg-muted/40 text-micro uppercase tracking-wide text-muted-foreground [&_th]:font-medium">
                <th className="text-right px-3 py-2">#</th>
                <th className="text-left px-3 py-2">{i18n.t("alphaZoo.alpha")}</th>
                <th className="text-right px-3 py-2 hidden sm:table-cell">{i18n.t("alphaZoo.zoo")}</th>
                <th className="text-right px-3 py-2">{i18n.t("alphaZoo.icMean")}</th>
                <th className="text-right px-3 py-2 hidden md:table-cell">{i18n.t("alphaZoo.icStd")}</th>
                <th className="text-right px-3 py-2">{i18n.t("alphaZoo.ir")}</th>
                <th className="text-right px-3 py-2 hidden md:table-cell" title={i18n.t("alphaZoo.icPositiveTitle")}>{i18n.t("alphaZoo.icPositive")}</th>
                <th className="text-right px-3 py-2 hidden lg:table-cell" title={i18n.t("alphaZoo.icSampleCount")}>{i18n.t("alphaZoo.sampleCount")}</th>
                <th className="text-right px-3 py-2" title={i18n.t("alphaZoo.gapTitle", { sort: result.sort })}>Δ {result.sort}</th>
              </tr>
            </thead>
            <tbody>
              {result.ranking.map((r) => (
                <tr
                  key={`${r.zoo}:${r.id}`}
                  className={cn(
                    "border-b last:border-0 hover:bg-muted/40",
                    r.rank === 1 && "bg-success/5",
                  )}
                >
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{r.rank}</td>
                  <td className="px-3 py-2 font-mono text-caption">
                    <Link
                      to={`/alpha-zoo/${encodeURIComponent(r.id)}`}
                      className="text-[hsl(var(--info))] hover:underline"
                    >
                      {r.id}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-caption text-muted-foreground hidden sm:table-cell">{r.zoo}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtNum(r.ic_mean, 4)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums hidden md:table-cell">{fmtNum(r.ic_std, 4)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtNum(r.ir, 3)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums hidden md:table-cell">{fmtNum(r.ic_positive_ratio, 3)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums hidden lg:table-cell">{r.ic_count}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {r.rank === 1 ? "—" : fmtNum(Number(r[deltaKey]), 4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {result.skipped.length > 0 && (
        <p className="text-caption text-muted-foreground">
          <span className="font-medium">{i18n.t("alphaZoo.skippedPre")}</span>{" "}
          {result.skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}
        </p>
      )}
    </div>
  );
}

function useReadiness() {
  const [data, setData] = useState<AlphaReadiness | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    api.getAlphaReadiness().then((data) => { if (active) { setData(data); setError(""); } }).catch((error) => { if (active) setError(error instanceof Error ? error.message : i18n.t("analysis.failed")); });
    return () => { active = false; };
  }, [retry]);
  return { data, error, retry: () => setRetry((n) => n + 1) };
}

function ReadinessPanel({ readiness, universe, count }: { readiness: ReturnType<typeof useReadiness>; universe: string; count?: number }) {
  const onOpenSettings = useNativeSettings();
  const info = readiness.data?.universes[universe];
  return <div className="space-y-2 rounded-lg border bg-card p-4 text-ui" role="status">
    <p>{i18n.t("analysis.evaluationScope", { count: count ?? "–" })}</p>
    <p className={info?.ready ? "text-muted-foreground" : "text-warning"}>{info ? i18n.t(`analysis.ready_${info.reason}`) : readiness.error || i18n.t("analysis.checkingData")}</p>
    {readiness.error && <button onClick={readiness.retry} className="text-[hsl(var(--info))] underline">{i18n.t("connection.retry")}</button>}
    {info && !info.ready && universe !== "btc-usdt" && (onOpenSettings ? <button type="button" onClick={onOpenSettings} className="inline-block text-[hsl(var(--info))] underline">{i18n.t("layout.settings")}</button> : <StockVibeInfo title="数据要求" label="查看数据要求"><p>{i18n.t(`analysis.ready_${info.reason}`)}</p></StockVibeInfo>)}
  </div>;
}

function FactorDataNotice({ meta }: { meta?: import("../lib/api").AlphaDataMeta }) {
  if (!meta) return null;
  return <div className="space-y-1 rounded-lg border bg-card p-3 text-ui">
    {meta.fetched_instruments !== undefined && <p>{i18n.t("analysis.factorCoverage", { count: meta.fetched_instruments, total: meta.requested_instruments ?? "–" })}</p>}
    {meta.missing_instruments?.length ? <p className="text-warning">{i18n.t("analysis.missingAssets", { assets: meta.missing_instruments.join(", ") })}</p> : null}
    {meta.survivorship_bias && <p className="text-warning">{i18n.t("analysis.survivorshipBias")}</p>}
    {meta.degraded && <p className="text-warning">{i18n.t("analysis.degradedUniverse")}</p>}
  </div>;
}
