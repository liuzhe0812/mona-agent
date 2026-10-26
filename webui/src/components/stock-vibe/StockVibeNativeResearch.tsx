import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleHelp, FileText, History, FlaskConical, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { createStockVibeRequestId, downloadStockVibeSwarmArtifact, getStockVibeRequest, listStockVibeSwarmRuns, type StockVibeRequestRecord } from "@/lib/stock-vibe-api";
import {
  getStockVibeNativeResearch, getStockVibeNativeResearchCatalog, startStockVibeNativeResearch,
  type StockVibeNativeResearchCatalog, type StockVibeNativeResearchRecord, type StockVibeNativeResearchResult, type StockVibeNativeResearchTeam,
} from "@/lib/stock-vibe-native-research-api";
import { StockVibeSavedStrategies } from "./StockVibeSavedStrategies";
import { StockVibeInfo } from "./StockVibeInfo";
import { StockVibeOpportunityCandidates } from "./StockVibeOpportunityCandidates";
import { StockVibeOpportunityArchive } from "./StockVibeOpportunityArchive";
import { StockVibeReport } from "./StockVibeReport";
import type { OpportunityMode } from "@/lib/stock-vibe-opportunity-api";

export interface StockVibeNativeResearchContext { swarmId: string; taskId?: string; candidateSource?: unknown; }
export interface StockVibeNativeResearchProps {
  catalogRevision?: number;
  onSaveStrategy?: (context: StockVibeNativeResearchContext) => void;
  mode: OpportunityMode; symbols: string[]; enabled: boolean; modelAvailable: boolean;
  onAdd: (symbol: string) => void; onMarket: (symbol: string, context?: StockVibeNativeResearchContext) => void;
  onResearch: (symbol: string, context?: StockVibeNativeResearchContext) => void;
  onOpenModel: () => void; onError: (message: string) => void;
  onReuseStrategy?: (strategyId: string) => void;
  backtestAction: ReactNode; onOpenBacktest: (view: "settings" | "history", runId?: string) => void;
}
const TEAM_TITLES: Record<string, string> = { quant_strategy_desk: "量化选股与验证", factor_research_committee: "因子研究", ml_quant_lab: "机器学习策略研究", fundamental_research_team: "公司基本面研究", sector_rotation_team: "行业轮动研究", event_driven_task_force: "事件机会研究", equity_research_team: "综合股票研究", investment_committee: "投资决策复核" };
type Workspace = "selection" | "research";
const METHODS: Record<string, { label: string; summary: string; workspaces: Workspace[]; auxiliary?: boolean }> = {
  equity_research_team: { label: "综合选股", summary: "从行业与公司分析寻找候选", workspaces: ["selection"] },
  quant_strategy_desk: { label: "量化选股", summary: "结合因子研究与历史检验", workspaces: ["selection", "research"] },
  event_driven_task_force: { label: "事件机会", summary: "寻找事件及相关股票", workspaces: ["selection"] },
  factor_research_committee: { label: "因子策略", summary: "研究有效指标及组合规则", workspaces: ["research"] },
  ml_quant_lab: { label: "机器学习策略", summary: "研究模型并检验历史表现", workspaces: ["research"] },
  sector_rotation_team: { label: "行业轮动策略", summary: "研究行业配置与轮动规则", workspaces: ["research"] },
  fundamental_research_team: { label: "公司基本面", summary: "分析指定公司的经营与价值", workspaces: ["research"], auxiliary: true },
  investment_committee: { label: "投资复核", summary: "复核指定股票的机会与风险", workspaces: ["research"], auxiliary: true },
};
function supportsWorkspace(name: string, workspace: Workspace) { return METHODS[name]?.workspaces.includes(workspace) ?? workspace === "research"; }
const VARIABLES: Record<string, string> = { target: "研究股票", factor_type: "因子研究方向", target_variable: "预测目标", event_type: "事件类型" };
// Categories come from the bundled Vibe team variables; labels are the Chinese UI projection.
const RESEARCH_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  factor_type: [
    { value: "value", label: "价值与估值" }, { value: "momentum", label: "价格动量" },
    { value: "quality", label: "经营质量" }, { value: "growth", label: "成长能力" },
    { value: "alternative", label: "另类数据" },
  ],
  target_variable: [
    { value: "return", label: "未来收益率" }, { value: "direction", label: "涨跌方向" },
    { value: "volatility", label: "价格波动" },
  ],
  event_type: [
    { value: "", label: "全部事件" }, { value: "M&A", label: "并购重组" },
    { value: "insider trading", label: "内部人士交易" }, { value: "earnings", label: "财报业绩" },
    { value: "policy", label: "政策变化" }, { value: "litigation", label: "诉讼事件" },
    { value: "management change", label: "管理层变动" },
  ],
};
const ROLE_TITLES: Record<string, string> = { screener: "候选筛选", factor_miner: "因子研究", backtester: "策略回测", risk_auditor: "风险复核", report_aggregator: "研究报告", feature_engineer: "特征研究", data_scientist: "模型研究", backtest_engineer: "样本外验证", fundamental_analyst: "基本面分析", technical_analyst: "走势分析", risk_manager: "风险复核", synthesizer: "结论汇总" };
const MODES: Record<string, string> = { ultrashort: "超短线", swing: "波段", medium: "中短线" };
const STATUS: Record<string, string> = { pending: "等待开始", queued: "排队中", running: "研究中", in_progress: "进行中", blocked: "等待前序步骤", completed: "已完成", failed: "未完成", interrupted: "已中断", cancelled: "已停止", waiting_user: "需要补充信息" };
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const STORAGE = "mona.stock-vibe.native-research-pending.v1";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const title = (team: StockVibeNativeResearchTeam) => TEAM_TITLES[team.name] ?? team.title;
function pendingRequest(): string | null { try { const id = localStorage.getItem(STORAGE); return id && /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id) ? id : null; } catch { return null; } }
function stageTitle(agentId: string, team?: StockVibeNativeResearchTeam) { return ROLE_TITLES[agentId] ?? team?.agents.find((agent) => agent.id === agentId)?.role ?? "研究步骤"; }
function receiptRun(record: StockVibeRequestRecord, requestId: string): { id?: string; rejected?: boolean } {
  if (record.request_id?.replace(/-/g, "").toLowerCase() !== requestId.replace(/-/g, "").toLowerCase() || record.method !== "POST" || record.path !== "/swarm/runs") return {};
  const code = record.receipt?.status_code, signed = /^[a-f\d]{64}$/i.test(record.receipt_sha256 ?? "");
  if (record.status === "completed" && signed && code && code >= 200 && code < 300 && isObject(record.receipt?.body) && typeof record.receipt.body.id === "string" && ID.test(record.receipt.body.id)) return { id: record.receipt.body.id };
  return { rejected: record.status === "rejected" && ((record.error_category === "not_dispatched" && record.receipt === null && record.source === null) || Boolean(signed && code && code >= 400 && code < 500)) };
}

export function StockVibeNativeResearchDetails({ swarmId, onError, onOpenBacktestRun }: { swarmId: string; onError: (message: string) => void; onOpenBacktestRun?: (runId: string) => void }) {
  const [result, setResult] = useState<StockVibeNativeResearchResult | null>(null), [failed, setFailed] = useState(false);
  const errorRef = useRef(onError); errorRef.current = onError;
  useEffect(() => {
    let active = true, reading = false, done = false, alerted = false;
    setResult(null); setFailed(false);
    const poll = async () => {
      if (reading || done) return; reading = true;
      try { const next = await getStockVibeNativeResearch(swarmId); if (active) { setResult(next); setFailed(false); done = TERMINAL.has(next.status); } }
      catch { if (active) { setFailed(true); if (!alerted) { alerted = true; errorRef.current("原生研究详情暂时无法读取，请稍后重新打开这份记录。"); } } }
      finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 3000); return () => { active = false; window.clearInterval(timer); };
  }, [swarmId]);
  if (!result) return <p role="status">{failed ? "这份研究详情暂时无法读取。" : "正在读取原生研究详情…"}</p>;
  return <div className="space-y-4 text-caption"><p className="text-muted-foreground">{TEAM_TITLES[result.preset_name] ?? "原生研究"} · {STATUS[result.status] ?? "状态待确认"}</p>
    {result.final_report ? <StockVibeReport>{result.final_report}</StockVibeReport> : <p className="text-muted-foreground">本次尚未保存最终研究报告。</p>}
    <StockVibeInfo title="原生研究步骤" label="查看执行步骤"><div className="space-y-4">{result.tasks.map((task) => <div key={task.id}><h3 className="font-medium">{stageTitle(task.agent_id)} · {STATUS[task.status] ?? "状态待确认"}</h3>{task.summary && <StockVibeReport>{task.summary}</StockVibeReport>}</div>)}</div></StockVibeInfo>
    {onOpenBacktestRun && result.linked_runs.length > 0 && <div className="flex flex-wrap gap-2">{result.linked_runs.map((run, index) => <Button key={run.run_id} variant="secondary" size="sm" onClick={() => onOpenBacktestRun(run.run_id)}>查看关联回测{result.linked_runs.length > 1 ? ` ${index + 1}` : ""}</Button>)}</div>}
    <StockVibeInfo title="本次原生条件与产物来源" label="查看研究条件与来源"><pre className="whitespace-pre-wrap break-words">{JSON.stringify({ user_vars: result.user_vars, grounding_metadata: result.grounding_metadata, candidate_sources: result.candidate_sources, artifacts: result.artifacts }, null, 2)}</pre></StockVibeInfo>
  </div>;
}

export function StockVibeNativeResearch({ mode, symbols, enabled, modelAvailable, onAdd, onMarket, onResearch, onReuseStrategy, onSaveStrategy, onOpenModel, onError, backtestAction, onOpenBacktest, catalogRevision }: StockVibeNativeResearchProps) {
  const [catalog, setCatalog] = useState<StockVibeNativeResearchCatalog | null>(null), [loaded, setLoaded] = useState(false);
  const [strategyOffset, setStrategyOffset] = useState(0);
  const [workspace, setWorkspace] = useState<Workspace>("selection");
  const [researchPane, setResearchPane] = useState<"develop" | "methods">("develop");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [auxiliaryOpen, setAuxiliaryOpen] = useState(false);
  const [teamNames, setTeamNames] = useState<Record<Workspace, string>>({ selection: "equity_research_team", research: "quant_strategy_desk" }), [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({}), [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [records, setRecords] = useState<StockVibeNativeResearchRecord[]>([]), [historyPage, setHistoryPage] = useState(0), [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadedResult, setResult] = useState<StockVibeNativeResearchResult | null>(null), [selectedSymbol, setSelectedSymbol] = useState<string | null>(null), [comparisonSymbols, setComparisonSymbols] = useState<string[]>([]);
  const [pending, setPending] = useState(pendingRequest), [submitting, setSubmitting] = useState(false), [revision, setRevision] = useState(0);
  const dispatching = useRef(false), errorsSeen = useRef(new Set<string>()), errorRef = useRef(onError); errorRef.current = onError;
  const availableTeams = Object.keys(METHODS).flatMap((name) => catalog?.teams.find((item) => item.name === name && METHODS[name].workspaces.includes(workspace)) ?? []);
  const team = availableTeams.find((item) => item.name === teamNames[workspace]) ?? availableTeams[0];
  const teamName = team?.name ?? "";
  const result = loadedResult && supportsWorkspace(loadedResult.preset_name, workspace) ? loadedResult : null;
  const runTeam = catalog?.teams.find((item) => item.name === result?.preset_name);
  const draft = drafts[teamName] ?? {}, candidates = result?.candidates ?? [], candidate = candidates.find((item) => item.symbol === selectedSymbol) ?? candidates[0];
  const notify = useCallback((key: string, message: string) => { if (!errorsSeen.current.has(key)) { errorsSeen.current.add(key); errorRef.current(message); } }, []);
  useEffect(() => {
    let active = true;
    void getStockVibeNativeResearchCatalog(strategyOffset).then((value) => { if (!Array.isArray(value.teams) || !Array.isArray(value.strategies?.items)) throw new Error(); if (active) setCatalog(value); }).catch(() => { if (active) notify("catalog", "研究方法暂时无法读取，请重新打开机会选股。"); }).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [notify, strategyOffset, catalogRevision]);
  useEffect(() => {
    if (!catalog) return;
    let active = true;
    void listStockVibeSwarmRuns(100).then((response) => {
      const native = response.native, rows = Array.isArray(native) ? native : isObject(native) && Array.isArray(native.runs) ? native.runs : [];
      const next = rows.filter((row): row is StockVibeNativeResearchRecord => isObject(row) && typeof row.id === "string" && ID.test(row.id) && typeof row.preset_name === "string" && catalog.teams.some((item) => item.name === row.preset_name) && typeof row.status === "string");
      if (active) { setRecords(next); setSelectedId((current) => current ?? next.find((row) => supportsWorkspace(row.preset_name, workspace))?.id ?? null); }
    }).catch(() => { if (active) notify("history", "研究历史暂时无法读取，系统没有重新执行任务。请稍后重新打开。"); });
    return () => { active = false; };
  }, [catalog, notify, revision]);
  const accept = useCallback((record: StockVibeRequestRecord, requestId: string) => {
    const accepted = receiptRun(record, requestId);
    if (accepted.id || accepted.rejected) { localStorage.removeItem(STORAGE); setPending(null); if (accepted.id) { setSelectedId(accepted.id); setResult(null); setSelectedSymbol(null); setComparisonSymbols([]); setRevision((value) => value + 1); } else notify(`rejected:${requestId}`, "研究请求未被接受。请核对研究目标和模型设置后重新发起。"); }
  }, [notify]);
  useEffect(() => {
    if (!pending) return;
    let active = true, reading = false;
    const poll = async () => { if (reading || dispatching.current) return; reading = true; try { const record = await getStockVibeRequest(pending); if (active) accept(record, pending); } catch { if (active) notify(`pending:${pending}`, "提交结果仍在核对，请勿重复发起；原请求已保留。"); } finally { reading = false; } };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 3000); return () => { active = false; window.clearInterval(timer); };
  }, [accept, notify, pending]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true, reading = false, done = false;
    const poll = async () => {
      if (reading || done) return; reading = true;
      try { const next = await getStockVibeNativeResearch(selectedId); if (!active) return; setResult(next); setRecords((current) => current.map((row) => row.id === next.id ? { ...row, status: next.status } : row)); done = TERMINAL.has(next.status); }
      catch { if (active) notify(`read:${selectedId}`, "这次研究的进度或产物暂时无法读取，可从历史记录再次打开。系统没有重新执行。"); }
      finally { reading = false; }
    };
    setResult(null); void poll(); const timer = window.setInterval(() => { void poll(); }, 3000); return () => { active = false; window.clearInterval(timer); };
  }, [notify, selectedId]);
  function selectTeam(value: string) {
    setTeamNames((current) => ({ ...current, [workspace]: value })); setFieldErrors({}); setAuxiliaryOpen(false);
  }
  function changeWorkspace(next: Workspace) {
    setWorkspace(next); setFieldErrors({});
    if (loadedResult && !supportsWorkspace(loadedResult.preset_name, next)) {
      setSelectedId(records.find((row) => supportsWorkspace(row.preset_name, next))?.id ?? null);
      setResult(null); setSelectedSymbol(null); setComparisonSymbols([]);
    }
  }
  const variableOptions = (name: string) => name === "target" ? symbols.map((symbol) => ({ value: symbol, label: symbol.slice(0, 6) })) : RESEARCH_OPTIONS[name] ?? [];
  async function launch() {
    if (dispatching.current || pending || !team) return;
    const errors: Record<string, string> = {}, userVars: Record<string, string> = {};
    for (const variable of team.variables) {
      const value = variable.name === "market" ? "中国A股" : draft[variable.name] ?? "";
      if (variable.name === "market") userVars.market = value;
      else if (variable.name === "goal") userVars.goal = workspace === "selection"
        ? `按所选原生${title(team)}流程研究中国A股机会，研究周期：${MODES[mode]}。`
        : `按所选原生${title(team)}流程研发并检验中国A股${team.name === "sector_rotation_team" ? "行业配置与轮动规则" : "选股与交易方法"}，研究周期：${MODES[mode]}。`;
      else if (value && variableOptions(variable.name).some((option) => option.value === value)) userVars[variable.name] = value;
      else if (variable.required) errors[variable.name] = `请选择${VARIABLES[variable.name] ?? variable.name}。`;
    }
    if (Object.keys(errors).length) { setFieldErrors(errors); return; }
    if (!modelAvailable) { onOpenModel(); return; }
    if (!enabled) { notify("unavailable", "研究服务暂不可用，请检查功能资源后重试。"); return; }
    const requestId = createStockVibeRequestId();
    try { localStorage.setItem(STORAGE, requestId); } catch { onError("无法保存研究请求的核对信息，本次没有提交。请检查本机存储后重试。"); return; }
    dispatching.current = true; setPending(requestId); setSubmitting(true);
    try { accept(await startStockVibeNativeResearch(requestId, { preset_name: team.name, user_vars: userVars }), requestId); }
    catch { notify(`submit:${requestId}`, "研究提交结果暂未确认，系统会核对原请求，请勿重复提交。"); }
    finally { dispatching.current = false; setSubmitting(false); }
  }
  async function download(artifact: StockVibeNativeResearchResult["artifacts"][number]) {
    if (!result) return;
    try { const blob = await downloadStockVibeSwarmArtifact(result.id, artifact.artifact_id), url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = artifact.filename; link.click(); URL.revokeObjectURL(url); }
    catch { onError("研究附件暂时无法下载，请稍后从同一研究记录重试。"); }
  }
  const visibleHistory = records.slice(historyPage * 8, historyPage * 8 + 8);
  const taskRows = result?.tasks ?? [];
  const compared = candidates.filter((item) => comparisonSymbols.includes(item.symbol));
  function candidateContext(symbol: string): StockVibeNativeResearchContext | undefined {
    if (!result) return undefined;
    const selected = result.candidates.find((item) => item.symbol === symbol);
    const source = result.candidate_sources.find((item) => isObject(item) && item.task_id === selected?.task_id && (item.symbol === symbol || Array.isArray(item.symbols) && item.symbols.includes(symbol)));
    return { swarmId: result.id, ...(selected?.task_id ? { taskId: selected.task_id } : {}), ...(source === undefined ? {} : { candidateSource: source }) };
  }
  function methodCards(auxiliary = false) {
    return <div className="stock-vibe-opportunity-method-grid" role="group" aria-label={auxiliary ? "个股辅助分析" : workspace === "selection" ? "选股方式" : "研发方向"}>
      {availableTeams.filter((item) => Boolean(METHODS[item.name].auxiliary) === auxiliary).map((item) => {
        const method = METHODS[item.name];
        return <button key={item.name} type="button" className="stock-vibe-opportunity-method-card" data-selected={teamName === item.name} aria-pressed={teamName === item.name} aria-label={`选择${title(item)}`} onClick={() => selectTeam(item.name)}>
          <span className="text-caption">{workspace === "research" && item.name === "quant_strategy_desk" ? "量化策略" : method.label}</span>
          <span className="text-caption text-muted-foreground">{method.summary}</span>
          <span className="text-micro text-muted-foreground">研究周期：{MODES[mode]}</span>
        </button>;
      })}
    </div>;
  }
  const methodView = workspace === "research" && researchPane === "methods";
  const progress = <ol className="flex shrink-0 flex-wrap gap-2 border-b border-border pb-3" aria-label="原生研究进度">{taskRows.map((task) => <li key={task.id} className="rounded-md bg-muted/50 px-2 py-1.5 text-caption"><span>{stageTitle(task.agent_id, runTeam)}</span><span className="ml-2 text-muted-foreground">{STATUS[task.status] ?? "状态待确认"}</span></li>)}</ol>;
  return <div className="stock-vibe-opportunity-viewport" data-mode={workspace} data-pane={methodView ? "methods" : "develop"}>
    <div className="stock-vibe-opportunity-mode-switch">
      <div className="flex gap-1" role="tablist" aria-label="机会选股任务">
        <Button role="tab" variant="ghost" data-active={workspace === "selection"} aria-selected={workspace === "selection"} onClick={() => changeWorkspace("selection")}><ScanSearch className="mr-1.5 size-4" aria-hidden="true" />AI 选股</Button>
        <Button role="tab" variant="ghost" data-active={workspace === "research"} aria-selected={workspace === "research"} onClick={() => changeWorkspace("research")}><FlaskConical className="mr-1.5 size-4" aria-hidden="true" />策略研发</Button>
      </div>
      <StockVibeInfo title="历史记录" label={<><History className="mr-1.5 size-4" aria-hidden="true" />历史记录</>} open={historyOpen} onOpenChange={setHistoryOpen}>
        <Button variant="ghost" size="sm" onClick={() => { setHistoryOpen(false); onOpenBacktest("history"); }}>策略回测记录</Button>
        <p className="text-muted-foreground">最近读取的选股与研发记录</p>
        <div className="space-y-1">{visibleHistory.length ? visibleHistory.map((row) => <button key={row.id} type="button" className="stock-vibe-opportunity-history" aria-pressed={selectedId === row.id} onClick={() => {
          if (!supportsWorkspace(row.preset_name, workspace)) setWorkspace(METHODS[row.preset_name]?.workspaces[0] ?? "research");
          setResearchPane("develop"); setSelectedId(row.id); setSelectedSymbol(null); setComparisonSymbols([]); setHistoryOpen(false);
        }}><span>{catalog?.teams.find((item) => item.name === row.preset_name) ? title(catalog.teams.find((item) => item.name === row.preset_name)!) : row.preset_name}</span><span className="text-caption text-muted-foreground">{STATUS[row.status] ?? "状态待确认"} · {row.created_at?.slice(0, 16).replace("T", " ") ?? "日期未提供"}</span></button>) : <p className="text-muted-foreground">暂无历史记录。</p>}</div>
        {records.length > 8 && <div className="flex items-center justify-between"><Button variant="ghost" size="sm" disabled={historyPage === 0} onClick={() => setHistoryPage(historyPage - 1)}>上一页</Button><span>{historyPage + 1} / {Math.ceil(records.length / 8)}</span><Button variant="ghost" size="sm" disabled={(historyPage + 1) * 8 >= records.length} onClick={() => setHistoryPage(historyPage + 1)}>下一页</Button></div>}
        <StockVibeInfo title="此前的选股档案" label="查看此前的选股档案"><StockVibeOpportunityArchive onError={onError} onMarket={onMarket} onAdd={onAdd} /></StockVibeInfo>
      </StockVibeInfo>
    </div>
    <div className="stock-vibe-opportunity">
      <aside className="stock-vibe-opportunity-setup" aria-label={workspace === "selection" ? "选股设置" : "策略研发设置"}>
        <div className="space-y-1"><h2 className="text-ui font-semibold">{workspace === "selection" ? "帮我找股票" : methodView ? "已保存的方法" : "研究一套选股方法"}</h2><p className="text-caption text-muted-foreground">{workspace === "selection" ? "选择方式，查看候选、理由和风险" : methodView ? "查看规则与历史测试，再继续研究" : "形成规则，检验表现，保存方法"}</p></div>
        {workspace === "research" && <div className="flex gap-3" aria-label="策略研发页面">{([["develop", "新建研发"], ["methods", "我的方法"]] as const).map(([key, label]) => <Button key={key} variant="ghost" className="stock-vibe-path-tab" data-active={researchPane === key} aria-pressed={researchPane === key} onClick={() => setResearchPane(key)}>{label}</Button>)}</div>}
        {methodView ? null : !loaded ? <p role="status" className="text-caption text-muted-foreground">正在读取可用方法…</p> : <>
          {methodCards()}
          {workspace === "research" && availableTeams.some((item) => METHODS[item.name].auxiliary) && <StockVibeInfo title="个股辅助分析" label="个股研究与投资复核" open={auxiliaryOpen} onOpenChange={setAuxiliaryOpen}><p className="text-muted-foreground">分析已指定的股票，为研究候选与检查风险提供参考。</p>{methodCards(true)}</StockVibeInfo>}
          {team && <>
            <StockVibeInfo title={`${title(team)} · 方法说明`} label={<><CircleHelp className="mr-1 size-4" aria-hidden="true" />方法说明</>}><p>{team.description}</p><p className="mt-2 text-muted-foreground">来源：Vibe {team.title}</p><div className="mt-3 space-y-2">{team.tasks.map((task) => <p key={task.id}>{stageTitle(task.agent_id, team)}{task.depends_on?.length ? " · 在前序步骤完成后执行" : " · 可独立开始"}</p>)}</div></StockVibeInfo>
            {METHODS[teamName]?.auxiliary && <p className="text-caption font-medium">当前：{title(team)}</p>}
            <div className="space-y-3">{team.variables.filter((variable) => !["market", "goal"].includes(variable.name)).map((variable) => {
              const options = variableOptions(variable.name), label = VARIABLES[variable.name] ?? variable.name;
              return <div key={variable.name} className="space-y-1.5"><div className="flex items-center gap-1"><span className="text-caption">{label}{variable.required ? " *" : ""}</span>{variable.description && <StockVibeInfo title={`${label}说明`} label={<CircleHelp className="size-3.5" aria-hidden="true" />} className="h-auto p-0 hover:bg-transparent"><p>{variable.description}</p></StockVibeInfo>}</div>
                <Select aria-label={label} value={draft[variable.name] ?? ""} options={options} placeholder={`请选择${label}`} disabled={!options.length} onValueChange={(value) => { setDrafts((current) => ({ ...current, [teamName]: { ...current[teamName], [variable.name]: value } })); setFieldErrors((current) => ({ ...current, [variable.name]: "" })); }} />
                {variable.name === "target" && !options.length && <p className="text-caption text-muted-foreground">暂无自选股票，请先在投资工作台添加自选。</p>}
                {fieldErrors[variable.name] && <p role="alert" className="text-caption text-destructive">{fieldErrors[variable.name]}</p>}
              </div>;
            })}</div>
            <p className="text-caption text-muted-foreground">中国A股 · {MODES[mode]}</p>
          </>}
          {!modelAvailable && <Button variant="ghost" size="sm" onClick={onOpenModel}>选择研究模型</Button>}
          <Button className="stock-vibe-opportunity-primary w-full" disabled={!team || submitting || Boolean(pending)} onClick={() => { void launch(); }}>{submitting ? "正在提交…" : pending ? "正在核对上次提交" : workspace === "selection" ? "开始选股" : METHODS[teamName]?.auxiliary ? "开始分析" : "开始研发"}</Button>
        </>}
      </aside>
      <section className="stock-vibe-opportunity-results" aria-label={workspace === "selection" ? "选股结果" : methodView ? "已保存的方法" : "策略研发结果"}>
        <header className="stock-vibe-opportunity-results-header"><div className="min-w-0"><h2 className="truncate text-ui font-semibold">{methodView ? "我的方法" : runTeam ? title(runTeam) : workspace === "selection" ? "候选股票" : "研发产物"}</h2><p className="mt-1 text-caption text-muted-foreground">{methodView ? "保存的规则与研究档案" : result ? STATUS[result.status] ?? "状态待确认" : pending ? "正在核对提交，不会重复执行" : workspace === "selection" ? "选择一种方式，开始寻找机会" : "选择研发方向，形成并检验方法"}</p></div>
          <div className="flex shrink-0 gap-2"><div hidden={workspace !== "research"} className="flex gap-2">{backtestAction}</div>{!methodView && result && <StockVibeInfo title={workspace === "selection" ? "本次选股过程" : "本次研发过程"} label={workspace === "selection" ? "查看选股过程" : "查看研发过程"}>{progress}<div className="space-y-4">{taskRows.map((task) => <div key={task.id}><p className="font-medium">{stageTitle(task.agent_id, runTeam)} · {STATUS[task.status] ?? "状态待确认"}</p>{task.summary && <StockVibeReport>{task.summary}</StockVibeReport>}</div>)}<StockVibeInfo title="本次条件与依据" label="查看条件与产物归属"><pre className="whitespace-pre-wrap break-words">{JSON.stringify({ user_vars: result.user_vars, grounding_metadata: result.grounding_metadata, candidate_sources: result.candidate_sources }, null, 2)}</pre></StockVibeInfo></div></StockVibeInfo>}</div>
        </header>
        {methodView ? <StockVibeSavedStrategies strategies={catalog?.strategies.items ?? []} total={catalog?.strategies.total ?? 0} offset={strategyOffset} onPageChange={setStrategyOffset} onError={onError} onReuseStrategy={onReuseStrategy} onOpenBacktestRun={(id) => onOpenBacktest("settings", id)} /> : <>
          {taskRows.length > 0 && (workspace === "research" ? progress : <p className="shrink-0 text-caption text-muted-foreground">已完成 {taskRows.filter((task) => task.status === "completed").length} / {taskRows.length} 项分析</p>)}
          {workspace === "selection" ? <>
            <StockVibeOpportunityCandidates candidates={candidates} selectedSymbol={candidate?.symbol} comparisonSymbols={comparisonSymbols} symbols={symbols} onSelect={setSelectedSymbol} onCompare={(symbol) => setComparisonSymbols((current) => current.includes(symbol) ? current.filter((item) => item !== symbol) : current.length < 3 ? [...current, symbol] : current)} onMarket={(symbol) => onMarket(symbol, candidateContext(symbol))} onAdd={onAdd} />
            {compared.length >= 2 && <StockVibeInfo title="候选依据对比" label={`对比已选股票（${compared.length}）`}><div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th className="border-b border-border py-2 font-medium">对比项目</th>{compared.map((item) => <th key={item.symbol} className="min-w-40 border-b border-border p-2 font-medium">{item.name || item.symbol.slice(0, 6)}</th>)}</tr></thead><tbody><tr><th className="border-b border-border py-2 font-medium">入选依据</th>{compared.map((item) => <td key={item.symbol} className="border-b border-border p-2 align-top">{item.support.join("；") || "原产物未提供"}</td>)}</tr><tr><th className="py-2 font-medium">风险</th>{compared.map((item) => <td key={item.symbol} className="p-2 align-top text-muted-foreground">{item.risks.join("；") || "原产物未提供"}</td>)}</tr></tbody></table></div></StockVibeInfo>}
            {candidates.length === 0 && <div className="stock-vibe-opportunity-empty"><h3 className="text-ui font-medium">{result && TERMINAL.has(result.status) ? "本次没有可核实的候选名单" : result ? "正在分析候选机会" : "从一种选股方式开始"}</h3><p className="mt-2 text-caption text-muted-foreground">{result ? "已有报告和步骤可继续查看。" : "在这里查看候选股票、入选理由和风险。"}</p></div>}
            {result?.final_report && <StockVibeInfo title="选股报告" label={<><FileText className="mr-1 size-4" aria-hidden="true" />查看选股报告</>}><StockVibeNativeResearchDetails swarmId={result.id} onError={onError} onOpenBacktestRun={(id) => onOpenBacktest("settings", id)} /></StockVibeInfo>}
          </> : result?.final_report ? <div className="min-h-0 flex-1 overflow-y-auto"><StockVibeReport>{result.final_report}</StockVibeReport></div> : <div className="stock-vibe-opportunity-empty"><h3 className="text-ui font-medium">{result ? TERMINAL.has(result.status) ? "本次尚未保存最终研发报告" : "研发正在进行" : "形成一套可检验的方法"}</h3><p className="mt-2 text-caption text-muted-foreground">{result ? "可查看已有步骤、历史测试和研究附件。" : "选择量化、因子、模型或行业轮动方向开始。"}</p></div>}
          {result?.linked_runs.length ? <div className="flex shrink-0 flex-wrap items-center gap-2"><span className="text-caption text-muted-foreground">历史测试</span>{result.linked_runs.map((run) => <Button key={run.run_id} variant="ghost" size="sm" onClick={() => onOpenBacktest("settings", run.run_id)}>{stageTitle(result.tasks.find((task) => task.id === run.task_id)?.agent_id ?? "backtester", runTeam)} · 查看报告</Button>)}{result.status === "completed" && onSaveStrategy && <Button variant="secondary" size="sm" onClick={() => onSaveStrategy({ swarmId: result.id, taskId: result.linked_runs[0].task_id })}>保存这套方法</Button>}</div> : null}
          {result?.historical_signals?.length ? <StockVibeInfo title="该次历史回测末日的策略信号" label={`查看历史策略信号（${result.historical_signals.length}）`}><p className="text-muted-foreground">这是回测期最后一天的目标持仓，不代表今天的候选或真实账户持仓。</p><div className="overflow-x-auto"><table className="w-full text-left"><thead><tr>{["历史日期", "股票", "目标仓位", "原生依据"].map((label) => <th key={label} className="border-b border-border p-2 font-medium">{label}</th>)}</tr></thead><tbody>{result.historical_signals.map((signal, index) => <tr key={index}><td className="border-b border-border p-2">{signal.as_of}</td><td className="border-b border-border p-2">{signal.symbol.slice(0, 6)}</td><td className="border-b border-border p-2">{Number.isFinite(signal.weight) ? `${(signal.weight * 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%` : "未提供"}</td><td className="border-b border-border p-2">{signal.support.join("；") || "原记录未提供"}</td></tr>)}</tbody></table></div></StockVibeInfo> : null}
          {result?.artifacts.length ? <StockVibeInfo title="研究附件" label={`研究附件（${result.artifacts.length}）`}><div className="space-y-2">{result.artifacts.map((artifact) => <div key={artifact.artifact_id} className="flex items-center justify-between gap-3"><span className="min-w-0 break-words">{artifact.filename}</span><Button variant="ghost" size="sm" onClick={() => { void download(artifact); }}>下载</Button></div>)}</div></StockVibeInfo> : null}
        </>}
      </section>
      {workspace === "selection" && <aside className="stock-vibe-opportunity-evidence" aria-label="候选依据与风险"><h2 className="text-ui font-semibold">入选原因与风险</h2>{candidate && result ? <><p className="text-ui font-semibold">{candidate.name || candidate.symbol.slice(0, 6)} <span className="text-caption font-normal text-muted-foreground">{candidate.name ? candidate.symbol.slice(0, 6) : ""}</span></p><div className="stock-vibe-opportunity-support"><h3 className="text-caption font-semibold">入选原因</h3>{(candidate.support.length ? candidate.support : ["原生产物没有提供具体入选原因。"]).slice(0, 2).map((item, index) => <p key={index} className="mt-2 line-clamp-3 text-caption">{item}</p>)}</div><div><h3 className="text-caption font-semibold">需要留意</h3>{(candidate.risks.length ? candidate.risks : ["原生产物没有提供完整风险资料。"]).slice(0, 2).map((item, index) => <p key={index} className="mt-2 line-clamp-3 text-caption text-muted-foreground">{item}</p>)}</div><StockVibeInfo title="候选的完整依据" label="查看详细依据"><div className="space-y-2">{candidate.support.map((item, index) => <p key={index}>{item}</p>)}{candidate.risks.map((item, index) => <p key={index} className="text-muted-foreground">{item}</p>)}</div><StockVibeInfo title="原生产物来源" label="查看来源记录"><pre className="whitespace-pre-wrap break-words">{JSON.stringify(result.candidate_sources, null, 2)}</pre></StockVibeInfo></StockVibeInfo><div className="stock-vibe-opportunity-evidence-actions"><Button className="stock-vibe-opportunity-primary w-full" onClick={() => onResearch(candidate.symbol, candidateContext(candidate.symbol))}>深入研究这只股票</Button></div></> : <p className="text-caption text-muted-foreground">选择候选股票后，查看具体理由和风险。</p>}</aside>}
    </div>
  </div>;
}
