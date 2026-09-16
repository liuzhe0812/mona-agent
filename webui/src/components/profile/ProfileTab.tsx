import { Fragment, useMemo } from "react";
import { FileText, Network, Radar, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ProfileArtifact, ProfileCharts, ProfileData, RichProfile } from "@/lib/profile-api";

import {
  PROFILE_CHART_COLORS,
  profileChartColor,
  profileChartColorAlpha,
  profileHeatmapStyle,
} from "./profile-chart-colors";

import { artifactCategory, isNamedCategory } from "./profile-categories";

interface ProfileTabProps {
  data?: ProfileData;
  profile?: RichProfile;
  loading: boolean;
  onOpenArtifact?: (artifact: ProfileArtifact) => void;
}

export function ProfileTab({ data, profile, loading, onOpenArtifact }: ProfileTabProps) {
  if (loading) return <div className="flex h-full items-center justify-center text-body text-muted-foreground">加载中…</div>;

  const actual = profile?.profile ?? data;
  const dashboard = profile?.dashboard;
  const evidence = actual?.evidence;
  const charts = profileCharts(profile);
  const radar = normalizeDimensions(charts?.profile_dimensions);
  const graph = normalizeGraph(charts?.topic_graph);
  const topics = (dashboard?.topic_records ?? []).filter((item) => isNamedCategory(item.topic));
  const topicCount = graph?.nodes?.length ?? topics.length;
  const focusCount = radar.length;
  const normalizedConversationTypes = normalizeCounts(charts?.collaboration_types);
  const conversationTypes = normalizedConversationTypes.length ? normalizedConversationTypes : [];
  const supportSessions = dashboard?.metrics?.active_conversations?.current.value ?? evidence?.total_sessions ?? 0;
  const artifacts = dashboard?.artifacts ?? [];
  const generatedArtifacts = dashboard?.metrics?.generated_artifacts?.current.value ?? artifacts.length;
  const normalizedArtifactGroups = normalizeCounts(charts?.artifact_types);
  const hasLegacyArtifactGroups = charts?.artifact_types?.some((item) => !isNamedCategory(item.label));
  const artifactGroups = hasLegacyArtifactGroups && artifacts.length ? groupArtifacts(artifacts) : normalizedArtifactGroups.length ? normalizedArtifactGroups : groupArtifacts(artifacts);
  const matrix = readMatrix(charts?.domain_task_matrix);

  return (
    <div className="flex w-full flex-col text-foreground lg:grid lg:h-full lg:min-h-0 lg:grid-rows-[auto_minmax(0,1.15fr)_minmax(0,0.85fr)_auto]">
      <div className="grid grid-cols-2 border-b border-border/70 py-3 sm:grid-cols-4">
        <SummaryStat label="关注领域" value={focusCount} />
        <SummaryStat label="关联主题" value={topicCount} />
        <SummaryStat label="协作类型" value={conversationTypes.length} />
        <SummaryStat label="支撑会话" value={supportSessions} />
      </div>

      <div className="grid min-h-0 grid-cols-1 border-b border-border/70 lg:grid-cols-[0.95fr_1.7fr]">
        <section className="flex min-h-0 flex-col overflow-hidden border-b border-border/70 py-4 lg:border-b-0 lg:border-r lg:border-border/70 lg:pr-6">
          <ChartHeading icon={<Radar className="h-4 w-4" />} title="关注领域" subtitle="相关记录数" />
          {radar.length > 2 ? <RadarPlot values={radar} /> : <ChartEmpty text="暂无足够领域记录" />}
        </section>
        <section className="flex min-h-0 flex-col overflow-hidden py-4 lg:pl-6">
          <ChartHeading icon={<Network className="h-4 w-4" />} title="主题关联" subtitle="同一记录中的共同出现" />
          {graph?.nodes?.length ? <TopicGraph graph={graph} /> : <ChartEmpty text="暂无主题关联图" />}
          <div className="mt-1 flex flex-wrap gap-4 text-micro text-muted-foreground">
            {graphLegend(graph).map((item) => <Legend key={item.label} color={item.color} label={item.label} />)}
          </div>
        </section>
      </div>

      <div className="grid min-h-0 grid-cols-1 border-b border-border/70 py-4 lg:grid-cols-[0.9fr_1fr_1.3fr]">
        <section className="flex min-h-0 flex-col justify-center overflow-hidden border-b border-border/70 pb-4 lg:border-b-0 lg:border-r lg:border-border/70 lg:pr-6">
          <ChartHeading icon={<Users className="h-4 w-4" />} title="常见协作类型" subtitle="已识别记录" />
          {conversationTypes.length ? <CollaborationDonut items={conversationTypes} /> : <ChartEmpty text="暂无协作类型记录" />}
        </section>
        <section className="flex min-h-0 flex-col justify-center overflow-hidden border-b border-border/70 py-4 lg:border-b-0 lg:border-r lg:border-border/70 lg:px-6 lg:py-0">
          <ChartHeading icon={<FileText className="h-4 w-4" />} title="常见交付物" subtitle={`${artifactGroups.reduce((sum, item) => sum + item.count, 0)} / ${generatedArtifacts || 0} 份已识别`} />
          {artifactGroups.length ? <ArtifactBars groups={artifactGroups} artifacts={artifacts} onOpenArtifact={onOpenArtifact} /> : <ChartEmpty text="暂无可验证的交付物" />}
        </section>
        <section className="flex min-h-0 flex-col overflow-hidden pt-4 lg:pl-6 lg:pt-0">
          <ChartHeading icon={<Network className="h-4 w-4" />} title="领域 × 协作方式" />
          {matrix.values.length ? <Matrix data={matrix} /> : <ChartEmpty text="暂无领域与协作方式交叉记录" />}
        </section>
      </div>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return <div className="flex items-baseline justify-center gap-2 border-r border-border/70 px-2 last:border-r-0"><span className="text-caption text-muted-foreground">{label}</span><strong className="text-title-sm font-medium leading-none tabular-nums">{value}</strong></div>;
}

function ChartHeading({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return <div className="mb-2 flex items-baseline gap-2"><h2 className="flex items-center gap-1.5 text-body font-semibold">{icon}{title}</h2>{subtitle ? <span className="text-micro text-muted-foreground">{subtitle}</span> : null}</div>;
}

function ChartEmpty({ text }: { text: string }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center text-caption text-muted-foreground">{text}</div>;
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />{label}</span>;
}

function RadarPlot({ values }: { values: Array<{ axis: string; value: number }> }) {
  const size = 320;
  const center = size / 2;
  const radius = 105;
  const max = Math.max(30, ...values.map((item) => item.value));
  const points = values.slice(0, 8).map((item, index, all) => {
    const angle = -Math.PI / 2 + (index / all.length) * Math.PI * 2;
    const distance = radius * Math.max(0, Math.min(1, item.value / max));
    return { ...item, x: center + Math.cos(angle) * distance, y: center + Math.sin(angle) * distance, labelX: center + Math.cos(angle) * (radius + 22), labelY: center + Math.sin(angle) * (radius + 22), angle };
  });
  const polygon = points.map((point) => `${point.x},${point.y}`).join(" ");
  return <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto block min-h-0 flex-1 w-full max-w-[380px] text-border" aria-label="关注领域雷达图">
    {[0.33, 0.66, 1].map((level) => <g key={level}>
      <polygon points={points.map((_, index, all) => { const angle = -Math.PI / 2 + (index / all.length) * Math.PI * 2; return `${center + Math.cos(angle) * radius * level},${center + Math.sin(angle) * radius * level}`; }).join(" ")} fill="none" stroke="currentColor" strokeWidth="1" />
      <text x={center + 4} y={center - radius * level + 10} className="fill-muted-foreground" fontSize="9">{Math.round(max * level)}</text>
    </g>)}
    {points.map((point) => <line key={`axis-${point.axis}`} x1={center} y1={center} x2={center + Math.cos(point.angle) * radius} y2={center + Math.sin(point.angle) * radius} stroke="currentColor" strokeWidth="1" />)}
    <polygon points={polygon} fill={profileChartColorAlpha(PROFILE_CHART_COLORS.blue, 0.14)} stroke={PROFILE_CHART_COLORS.blue} strokeWidth="2" />
    {points.map((point) => <g key={point.axis}><circle cx={point.x} cy={point.y} r="3.5" fill={PROFILE_CHART_COLORS.blue} /><text x={point.labelX} y={point.labelY} textAnchor={point.labelX < center - 8 ? "end" : point.labelX > center + 8 ? "start" : "middle"} dominantBaseline="middle" className="fill-muted-foreground" fontSize="11">{point.axis}</text></g>)}
    <text x={center} y={center - 4} textAnchor="middle" className="fill-muted-foreground" fontSize="10">相关记录数</text>
  </svg>;
}

function TopicGraph({ graph }: { graph: NonNullable<ProfileCharts["topic_graph"]> }) {
  const nodes = graph.nodes.slice(0, 18);
  const positions = useMemo(() => {
    const groups = new Map<string, typeof nodes>();
    for (const node of nodes) groups.set(node.group, [...(groups.get(node.group) ?? []), node]);
    const output = new Map<string, { x: number; y: number }>();
    const groupRows = groups.size > 3 ? 2 : 1;
    [...groups.entries()].forEach(([_group, groupNodes], groupIndex) => {
      const cx = 120 + (groupIndex % 3) * 240;
      const cy = groupRows === 1 ? 140 : 70 + Math.floor(groupIndex / 3) * 140;
      groupNodes.forEach((node, index) => {
        const angle = groupNodes.length === 1 ? 0 : (index / groupNodes.length) * Math.PI * 2;
        output.set(node.id, { x: cx + Math.cos(angle) * 54, y: cy + Math.sin(angle) * 38 });
      });
    });
    return output;
  }, [nodes]);
  return <svg viewBox="0 0 720 280" className="min-h-0 flex-1 w-full text-border" aria-label="主题关联图">
    {graph.links.slice(0, 30).map((link, index) => { const from = positions.get(link.source); const to = positions.get(link.target); return from && to ? <line key={`${link.source}-${link.target}-${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" strokeWidth="1" /> : null; })}
    {nodes.map((node) => { const position = positions.get(node.id); if (!position) return null; const color = profileChartColor(node.group); const size = Math.max(5, Math.min(18, node.count / 2)); return <g key={node.id}><circle cx={position.x} cy={position.y} r={size} fill={color} opacity="0.95" /><text x={position.x} y={position.y + size + 13} textAnchor="middle" className="fill-muted-foreground" fontSize="11">{node.label}</text></g>; })}
  </svg>;
}

function CollaborationDonut({ items }: { items: { label: string; count: number }[] }) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  let start = 0;
  const gradient = items.map((item) => { const end = total ? start + (item.count / total) * 100 : 0; const part = `${profileChartColor(item.label)} ${start}% ${end}%`; start = end; return part; }).join(", ");
  return <div className="flex items-center justify-center gap-5 py-3"><div className="relative h-36 w-36 shrink-0 rounded-full" style={{ background: `conic-gradient(${gradient})` }}><div className="absolute inset-8 flex flex-col items-center justify-center rounded-full bg-background"><span className="text-title-sm font-medium leading-none">{total}</span><span className="text-micro text-muted-foreground">次协作</span></div></div><div className="space-y-2 text-caption">{items.slice(0, 5).map((item) => <div key={item.label} className="flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full" style={{ background: profileChartColor(item.label) }} /><span>{item.label}</span><span className="text-muted-foreground">{item.count}</span></div>)}</div></div>;
}

function groupArtifacts(artifacts: ProfileArtifact[]) {
  const groups = new Map<string, number>();
  for (const artifact of artifacts) {
    const type = artifactCategory(artifact);
    if (type === null) continue;
    groups.set(type, (groups.get(type) ?? 0) + 1);
  }
  return [...groups.entries()].map(([label, count]) => ({ label, count }));
}

function ArtifactBars({ groups, artifacts, onOpenArtifact }: { groups: { label: string; count: number }[]; artifacts: ProfileArtifact[]; onOpenArtifact?: (artifact: ProfileArtifact) => void }) {
  const max = Math.max(...groups.map((group) => group.count), 1);
  return (
    <div className="min-h-0 overflow-y-auto scrollbar-hover space-y-4 py-2">
      {groups.map((group) => {
        const target = artifacts.find((artifact) => artifactCategory(artifact) === group.label);
        const content = <>
          <span>{group.label}</span>
          <span className="h-2 bg-muted"><span className="block h-full" style={{ width: `${(group.count / max) * 100}%`, background: profileChartColor(group.label) }} /></span>
          <span className="text-right tabular-nums">{group.count}</span>
        </>;
        return target && onOpenArtifact ? (
          <Button key={group.label} type="button" variant="ghost" size="xs" className="grid h-auto w-full grid-cols-[50px_1fr_28px] items-center gap-2 rounded-none p-0 text-left text-caption font-normal hover:bg-transparent" onClick={() => onOpenArtifact(target)}>
            {content}
          </Button>
        ) : (
          <div key={group.label} className="grid w-full grid-cols-[50px_1fr_28px] items-center gap-2 text-caption">
            {content}
          </div>
        );
      })}
    </div>
  );
}

function readMatrix(raw: unknown): { rows: string[]; columns: string[]; values: number[][] } {
  const matrix = raw as { domains?: string[]; tasks?: string[]; values?: number[][]; rows?: string[]; columns?: string[] } | undefined;
  const rows = matrix?.domains ?? matrix?.rows;
  const columns = matrix?.tasks ?? matrix?.columns;
  if (!matrix || !rows?.length || !columns?.length || !matrix.values?.length) return { rows: [], columns: [], values: [] };
  const rowIndexes = rows.map((_, index) => index).filter((index) => isNamedCategory(rows[index]));
  const columnIndexes = columns.map((_, index) => index).filter((index) => isNamedCategory(columns[index]));
  if (!rowIndexes.length || !columnIndexes.length) return { rows: [], columns: [], values: [] };
  return { rows: rowIndexes.map((index) => rows[index]), columns: columnIndexes.map((index) => columns[index]), values: rowIndexes.map((row) => columnIndexes.map((column) => matrix.values![row]?.[column] ?? 0)) };
}

function profileCharts(profile?: RichProfile): ProfileCharts | undefined {
  return profile?.dashboard?.profile_charts;
}

function normalizeDimensions(raw: unknown): Array<{ axis: string; value: number }> {
  const values = Array.isArray(raw) ? raw : (raw as { axes?: unknown[] } | undefined)?.axes;
  if (!Array.isArray(values)) return [];
  return values.map((item) => item as { axis?: string; label?: string; value?: number; count?: number }).map((item) => ({ axis: item.axis ?? item.label ?? "", value: Number(item.value ?? item.count ?? 0) })).filter((item) => isNamedCategory(item.axis) && Number.isFinite(item.value));
}

function normalizeGraph(raw: unknown): { nodes: { id: string; label: string; group: string; count: number }[]; links: { source: string; target: string; weight: number }[] } | undefined {
  const value = raw as { nodes?: { id: string; label: string; group: string | number; count?: number; size?: number }[]; links?: { source: string; target: string; weight?: number }[] } | undefined;
  if (!value?.nodes?.length) return undefined;
  const nodes = value.nodes.filter((node) => isNamedCategory(node.label) && isNamedCategory(String(node.group)));
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes: nodes.map((node) => ({ ...node, group: String(node.group), count: node.count ?? node.size ?? 1 })), links: (value.links ?? []).filter((link) => ids.has(link.source) && ids.has(link.target)).map((link) => ({ ...link, weight: link.weight ?? 1 })) };
}

function normalizeCounts(raw: unknown): Array<{ label: string; count: number }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => item as { label?: string; type?: string; name?: string; count?: number; total?: number }).map((item) => ({ label: item.label ?? item.type ?? item.name ?? "", count: Number(item.count ?? item.total ?? 0) })).filter((item) => isNamedCategory(item.label) && item.count > 0);
}

function graphLegend(graph?: { nodes?: { label: string; group: string; count?: number }[] }) {
  if (!graph?.nodes?.length) return [];
  const groups = [...new Set(graph.nodes.slice(0, 18).map((node) => node.group))];
  return groups.map((group) => ({ label: group, color: profileChartColor(group) }));
}

function Matrix({ data }: { data: { rows: string[]; columns: string[]; values: number[][] } }) {
  const max = Math.max(...data.values.flat(), 1);
  return <div className="min-h-0 flex-1 overflow-auto scrollbar-hover text-micro"><div className="grid min-w-[360px]" style={{ gridTemplateColumns: `minmax(78px, 1fr) repeat(${data.columns.length}, minmax(48px, 1fr))` }}><span />{data.columns.map((column) => <span key={column} className="pb-2 text-center text-muted-foreground">{column}</span>)}{data.rows.map((row, rowIndex) => <Fragment key={row}><span className="py-2 pr-2 text-muted-foreground">{row}</span>{data.columns.map((column, columnIndex) => { const value = data.values[rowIndex]?.[columnIndex] ?? 0; return <span key={`${row}-${column}`} className="m-px flex items-center justify-center py-2" style={profileHeatmapStyle(value, max)}>{value}</span>; })}</Fragment>)}</div></div>;
}
