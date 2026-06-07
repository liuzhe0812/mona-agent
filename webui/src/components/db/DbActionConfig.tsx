import { useState } from "react";
import { ArrowLeft, X, Rocket } from "lucide-react";
import { ChipGroup, CheckboxGroup, InputField } from "@/components/terminal/AIPanel/ActionConfig";
import type { QueryTab } from "./types";

export interface DbActionConfirmResult {
  label: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Shared ConfigPanel (simplified from terminal, no report generation)
// ---------------------------------------------------------------------------

interface ConfigPanelProps {
  title: string;
  icon: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
  confirmLabel?: string;
}

function ConfigPanel({
  title,
  icon,
  onConfirm,
  onCancel,
  children,
  confirmLabel = "开始",
}: ConfigPanelProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" />
          返回
        </button>
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
          {icon}
          {title}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {children}
      <button
        type="button"
        onClick={onConfirm}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[11px] font-medium text-background hover:bg-foreground/90 transition-colors"
      >
        <Rocket className="h-3 w-3" />
        {confirmLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. 执行计划
// ---------------------------------------------------------------------------

interface ExplainPlanConfigProps {
  activeTab: QueryTab | undefined;
  onConfirm: (result: DbActionConfirmResult) => void;
  onCancel: () => void;
}

export function ExplainPlanConfig({ activeTab, onConfirm, onCancel }: ExplainPlanConfigProps) {
  const [dimension, setDimension] = useState("full");
  const [query, setQuery] = useState("");

  const handleConfirm = () => {
    const table = activeTab?.title ?? "";
    const dimMap: Record<string, { label: string; checks: string }> = {
      full: {
        label: "全面",
        checks:
          "1) 用 SHOW CREATE TABLE 获取表结构和索引定义；2) 用 EXPLAIN 分析查询执行计划；3) 检查是否有全表扫描、文件排序、临时表等性能问题",
      },
      explain: {
        label: "仅EXPLAIN",
        checks: "用 EXPLAIN 分析查询执行计划，指出扫描类型、索引使用情况、预估行数",
      },
      structure: {
        label: "仅表结构",
        checks: "用 SHOW CREATE TABLE 和 SHOW INDEX 分析表结构和索引设计，指出潜在问题",
      },
    };
    const dim = dimMap[dimension] ?? dimMap.full;
    const queryPart = query.trim()
      ? `，分析这条查询：${query.trim()}`
      : table
        ? `，分析表 ${table} 的典型查询`
        : "";
    const prompt = `分析表 ${table} 的查询性能${queryPart}。${dim.checks}。给出：当前性能瓶颈、根因分析、优化建议。`;
    onConfirm({ label: "执行计划", prompt });
  };

  return (
    <ConfigPanel
      title="执行计划"
      icon={<span>⚡</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始分析"
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">分析维度</label>
          <ChipGroup
            options={[
              { label: "全面", value: "full" },
              { label: "仅EXPLAIN", value: "explain" },
              { label: "仅表结构", value: "structure" },
            ]}
            value={dimension}
            onChange={(v) => setDimension(v as string)}
          />
        </div>
        <InputField
          label="分析的 SQL（可选）"
          placeholder="SELECT * FROM users WHERE ..."
          value={query}
          onChange={setQuery}
          hint="不填则分析当前表的典型查询"
        />
      </div>
    </ConfigPanel>
  );
}

// ---------------------------------------------------------------------------
// 2. 索引诊断
// ---------------------------------------------------------------------------

interface IndexDiagnosisConfigProps {
  activeTab: QueryTab | undefined;
  onConfirm: (result: DbActionConfirmResult) => void;
  onCancel: () => void;
}

export function IndexDiagnosisConfig({ activeTab, onConfirm, onCancel }: IndexDiagnosisConfigProps) {
  const [scope, setScope] = useState("table");
  const [checks, setChecks] = useState<string[]>(["redundant", "missing"]);

  const handleConfirm = () => {
    const table = activeTab?.title ?? "";
    const scopeText = scope === "table" ? `表 ${table}` : "当前数据库所有表";
    const checkMap: Record<string, { label: string; instruction: string }> = {
      redundant: {
        label: "冗余索引",
        instruction: "1) 用 SHOW INDEX 获取索引定义，找出重复或前缀覆盖的冗余索引",
      },
      missing: {
        label: "缺失索引",
        instruction: "2) 分析查询模式和 WHERE 条件，找出缺少索引的高频查询列",
      },
      unused: {
        label: "未使用索引",
        instruction: "3) 查询 sys.schema_unused_indexes 找出从未被使用的索引",
      },
    };
    const checksText = checks
      .map((c) => checkMap[c]?.instruction ?? "")
      .filter(Boolean)
      .join("；");
    const prompt = `诊断${scopeText}的索引状况。${checksText}。给出诊断结果和优化建议。`;
    onConfirm({ label: "索引诊断", prompt });
  };

  return (
    <ConfigPanel
      title="索引诊断"
      icon={<span>🗂️</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始诊断"
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">诊断范围</label>
          <ChipGroup
            options={[
              { label: "当前表", value: "table" },
              { label: "全库", value: "database" },
            ]}
            value={scope}
            onChange={(v) => setScope(v as string)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">检查项</label>
          <CheckboxGroup
            items={[
              { label: "冗余索引", value: "redundant" },
              { label: "缺失索引", value: "missing" },
              { label: "未使用索引", value: "unused" },
            ]}
            value={checks}
            onChange={setChecks}
          />
        </div>
      </div>
    </ConfigPanel>
  );
}

// ---------------------------------------------------------------------------
// 3. 数据画像
// ---------------------------------------------------------------------------

interface DataProfileConfigProps {
  activeTab: QueryTab | undefined;
  onConfirm: (result: DbActionConfirmResult) => void;
  onCancel: () => void;
}

export function DataProfileConfig({ activeTab, onConfirm, onCancel }: DataProfileConfigProps) {
  const [dimensions, setDimensions] = useState<string[]>(["column_stats", "enum_dist", "null_rate"]);

  const handleConfirm = () => {
    const table = activeTab?.title ?? "";
    const dimMap: Record<string, { label: string; instruction: string }> = {
      column_stats: {
        label: "列统计",
        instruction: "1) 用 DESCRIBE 获取列定义，统计每列的数据类型、行数、distinct 值数量",
      },
      enum_dist: {
        label: "枚举分布",
        instruction: "2) 对枚举/状态类列查询值分布（SELECT col, COUNT(*) GROUP BY col）",
      },
      null_rate: {
        label: "空值率",
        instruction: "3) 统计每列的空值比例（COUNT(*) vs COUNT(col)）",
      },
      outlier: {
        label: "异常值",
        instruction: "4) 对数值列检查异常值（极大/极小值、偏离均值超过3σ的记录）",
      },
    };
    const checksText = dimensions
      .map((d) => dimMap[d]?.instruction ?? "")
      .filter(Boolean)
      .join("；");
    const prompt = `为表 ${table} 生成数据画像。${checksText}。输出画像报告。`;
    onConfirm({ label: "数据画像", prompt });
  };

  return (
    <ConfigPanel
      title="数据画像"
      icon={<span>📊</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始分析"
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">画像维度（可多选）</label>
          <CheckboxGroup
            items={[
              { label: "列统计", value: "column_stats" },
              { label: "枚举分布", value: "enum_dist" },
              { label: "空值率", value: "null_rate" },
              { label: "异常值", value: "outlier" },
            ]}
            value={dimensions}
            onChange={setDimensions}
          />
        </div>
      </div>
    </ConfigPanel>
  );
}

// ---------------------------------------------------------------------------
// 4. 诊断错误
// ---------------------------------------------------------------------------

interface DiagnoseErrorConfigProps {
  activeTab: QueryTab | undefined;
  onConfirm: (result: DbActionConfirmResult) => void;
  onCancel: () => void;
}

export function DiagnoseErrorConfig({ activeTab, onConfirm, onCancel }: DiagnoseErrorConfigProps) {
  const [errorMsg, setErrorMsg] = useState(activeTab?.result?.message ?? "");
  const [sql, setSql] = useState("");

  const handleConfirm = () => {
    const table = activeTab?.title ?? "";
    const errorPart = errorMsg.trim()
      ? `SQL 执行报错：${errorMsg.trim()}`
      : "SQL 执行报错";
    const sqlPart = sql.trim() ? `，出错的 SQL：${sql.trim()}` : "";
    const prompt = `${errorPart}${sqlPart}。请用 db_query 查询相关表结构（SHOW CREATE TABLE ` + "`" + table + "`" + `），分析错误原因并给出修复 SQL。`;
    onConfirm({ label: "诊断错误", prompt });
  };

  return (
    <ConfigPanel
      title="诊断错误"
      icon={<span>⚠️</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始诊断"
    >
      <div className="space-y-3">
        <InputField
          label="错误信息"
          placeholder="Unknown column 'xxx' in field list"
          value={errorMsg}
          onChange={setErrorMsg}
          hint="自动填充当前错误，可修改"
        />
        <InputField
          label="出错的 SQL（可选）"
          placeholder="SELECT name FORM users"
          value={sql}
          onChange={setSql}
        />
      </div>
    </ConfigPanel>
  );
}

// ---------------------------------------------------------------------------
// 5. 一键巡检
// ---------------------------------------------------------------------------

interface HealthInspectionConfigProps {
  activeTab: QueryTab | undefined;
  onConfirm: (result: DbActionConfirmResult) => void;
  onCancel: () => void;
}

export function HealthInspectionConfig({ onConfirm, onCancel }: HealthInspectionConfigProps) {
  const [scope, setScope] = useState("full");
  const [focus, setFocus] = useState("");

  const handleConfirm = () => {
    const scopeMap: Record<string, { label: string; checks: string }> = {
      full: {
        label: "全面",
        checks:
          "1) SHOW STATUS 获取服务器状态；2) SHOW VARIABLES 检查关键配置；3) SHOW PROCESSLIST 检查当前连接；4) 检查慢查询和锁等待",
      },
      status: {
        label: "仅状态",
        checks: "用 SHOW STATUS 获取服务器运行状态，关注连接数、QPS、慢查询、缓冲池命中率等关键指标",
      },
      variables: {
        label: "仅变量",
        checks: "用 SHOW VARIABLES 检查关键配置参数（innodb_buffer_pool_size、max_connections、slow_query_log 等），指出不合理配置",
      },
      processlist: {
        label: "仅进程",
        checks: "用 SHOW PROCESSLIST 检查当前连接，找出长事务、锁等待、慢查询",
      },
    };
    const dim = scopeMap[scope] ?? scopeMap.full;
    const focusPart = focus.trim() ? `重点关注：${focus.trim()}。` : "";
    const prompt = `对当前数据库实例做健康巡检，范围：${dim.label}。${dim.checks}。${focusPart}给出分级摘要：🟢正常项、🟡需关注项、🔴异常项，对异常项给出原因和修复建议。`;
    onConfirm({ label: "一键巡检", prompt });
  };

  return (
    <ConfigPanel
      title="一键巡检"
      icon={<span>🛡️</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始巡检"
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">巡检范围</label>
          <ChipGroup
            options={[
              { label: "全面", value: "full" },
              { label: "仅状态", value: "status" },
              { label: "仅变量", value: "variables" },
              { label: "仅进程", value: "processlist" },
            ]}
            value={scope}
            onChange={(v) => setScope(v as string)}
          />
        </div>
        <InputField
          label="关注项（可选）"
          placeholder="慢查询、锁等待、连接数"
          value={focus}
          onChange={setFocus}
          hint="不填则检查所有关键指标"
        />
      </div>
    </ConfigPanel>
  );
}

// ---------------------------------------------------------------------------
// 6. 优化建议
// ---------------------------------------------------------------------------

interface OptimizeConfigProps {
  activeTab: QueryTab | undefined;
  onConfirm: (result: DbActionConfirmResult) => void;
  onCancel: () => void;
}

export function OptimizeConfig({ activeTab, onConfirm, onCancel }: OptimizeConfigProps) {
  const [direction, setDirection] = useState("full");
  const [table = ""] = [activeTab?.title];

  const handleConfirm = () => {
    const dirMap: Record<string, { label: string; checks: string }> = {
      full: {
        label: "全面",
        checks:
          "1) 用 SHOW CREATE TABLE 获取表结构；2) 用 SHOW INDEX 获取索引信息；3) 用 SHOW TABLE STATUS 获取数据量和碎片率；4) 综合分析给出优化建议",
      },
      structure: {
        label: "表结构",
        checks: "分析表结构设计（列类型选择、主键设计、字符集），指出不合理之处",
      },
      index: {
        label: "索引",
        checks: "分析索引设计（主键、二级索引、联合索引顺序），指出冗余和缺失",
      },
      query: {
        label: "查询",
        checks: "分析常见查询模式，指出可优化的 SQL 写法（SELECT *、函数索引失效等）",
      },
      fragmentation: {
        label: "碎片",
        checks: "用 SHOW TABLE STATUS 检查碎片率，评估是否需要 OPTIMIZE TABLE",
      },
    };
    const dim = dirMap[direction] ?? dirMap.full;
    const prompt = `分析表 ${table} 的整体优化建议，方向：${dim.label}。${dim.checks}。给出具体优化建议和预期收益。`;
    onConfirm({ label: "优化建议", prompt });
  };

  return (
    <ConfigPanel
      title="优化建议"
      icon={<span>🔧</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始分析"
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">优化方向</label>
          <ChipGroup
            options={[
              { label: "全面", value: "full" },
              { label: "表结构", value: "structure" },
              { label: "索引", value: "index" },
              { label: "查询", value: "query" },
              { label: "碎片", value: "fragmentation" },
            ]}
            value={direction}
            onChange={(v) => setDirection(v as string)}
          />
        </div>
      </div>
    </ConfigPanel>
  );
}
