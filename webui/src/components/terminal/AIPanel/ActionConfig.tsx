import { useState } from "react";
import { ArrowLeft, X, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ActionConfirmResult {
  label: string;
  prompt: string;
  generateReport: boolean;
}

interface ChipGroupProps {
  options: { label: string; value: string }[];
  value: string | string[];
  onChange: (value: string | string[]) => void;
  multiple?: boolean;
}

export function ChipGroup({ options, value, onChange, multiple = false }: ChipGroupProps) {
  const selected = Array.isArray(value) ? value : [value];
  const handleClick = (v: string) => {
    if (multiple) {
      const next = selected.includes(v)
        ? selected.filter((s) => s !== v)
        : [...selected, v];
      onChange(next);
    } else {
      onChange(v);
    }
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const active = selected.includes(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => handleClick(opt.value)}
            className={cn(
              "rounded-md border px-2 py-1 text-[11px] transition-colors",
              active
                ? "border-foreground/30 bg-foreground/10 text-foreground"
                : "border-border/70 bg-background text-muted-foreground hover:border-foreground/20 hover:text-foreground",
            )}
          >
            {multiple && (active ? "☑ " : "☐ ")}
            {!multiple && (active ? "● " : "○ ")}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

interface CheckboxGroupProps {
  items: { label: string; value: string }[];
  value: string[];
  onChange: (value: string[]) => void;
}

export function CheckboxGroup({ items, value, onChange }: CheckboxGroupProps) {
  const toggle = (v: string) => {
    onChange(
      value.includes(v) ? value.filter((x) => x !== v) : [...value, v],
    );
  };
  return (
    <div className="space-y-1">
      {items.map((item) => {
        const checked = value.includes(item.value);
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => toggle(item.value)}
            className="flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="grid h-3.5 w-3.5 place-items-center rounded border border-border/70 text-[10px]">
              {checked ? "✓" : ""}
            </span>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

interface InputFieldProps {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}

export function InputField({ label, placeholder, value, onChange, hint }: InputFieldProps) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-muted-foreground">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/30"
      />
      {hint && <p className="text-[10px] text-muted-foreground/60">{hint}</p>}
    </div>
  );
}

interface ConfigPanelProps {
  title: string;
  icon: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
  confirmLabel?: string;
  generateReport: boolean;
  onGenerateReportChange: (v: boolean) => void;
}

export function ConfigPanel({
  title,
  icon,
  onConfirm,
  onCancel,
  children,
  confirmLabel = "开始",
  generateReport,
  onGenerateReportChange,
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
      <div className="flex items-center gap-2 border-t border-border/50 pt-2">
        <button
          type="button"
          onClick={() => onGenerateReportChange(!generateReport)}
          className="flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="grid h-3.5 w-3.5 place-items-center rounded border border-border/70 text-[10px]">
            {generateReport ? "✓" : ""}
          </span>
          生成 HTML 报告
        </button>
      </div>
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

const REPORT_INSTRUCTION = `此外，请将结果生成为一份 HTML 报告。先读取 doc-writing-guide skill 了解写作风格和内容结构规范，再读取 html-report skill 了解 HTML 报告的设计规范（主题、布局、图表、字体等）。【重要】不要在聊天回复中输出 HTML 代码。必须使用 generate_report 工具来保存报告，参数：title（报告标题）和 content（完整 HTML 字符串）。在聊天中只需告诉用户报告已生成即可。`;

// ---------------------------------------------------------------------------
// 1. Health Check
// ---------------------------------------------------------------------------

interface HealthCheckConfigProps {
  onConfirm: (result: ActionConfirmResult) => void;
  onCancel: () => void;
}

export function HealthCheckConfig({ onConfirm, onCancel }: HealthCheckConfigProps) {
  const [scope, setScope] = useState("full");
  const [services, setServices] = useState("");
  const [generateReport, setGenerateReport] = useState(false);

  const handleConfirm = () => {
    const servicePart = services.trim()
      ? `重点检查以下服务：${services.trim()}。`
      : "先自动发现运行中的关键服务（用 systemctl list-units），";
    let prompt: string;
    if (scope === "full") {
      prompt = `对这台服务器做一次全面健康巡检。${servicePart}然后检查：1) 各服务运行状态，是否有崩溃或频繁重启；2) CPU/内存/磁盘使用率，是否有资源即将耗尽；3) 最近是否有系统级错误（OOM、kernel panic）。最后给出分级摘要：🟢正常项、🟡需关注项、🔴异常项，对异常项给出原因和修复建议。`;
    } else if (scope === "service") {
      prompt = `检查这台服务器的服务运行状态。${servicePart}检查是否有服务崩溃、频繁重启或处于 failed 状态。给出分级摘要：🟢正常 🟡注意 🔴异常。`;
    } else {
      prompt = `检查这台服务器的资源使用情况：CPU 使用率和 load average、内存和 swap 使用率、各磁盘分区使用率。给出分级摘要：🟢正常 🟡需关注 🔴即将耗尽，对异常项给出具体数值和建议。`;
    }
    if (generateReport) prompt += REPORT_INSTRUCTION;
    onConfirm({ label: "健康巡检", prompt, generateReport });
  };

  return (
    <ConfigPanel
      title="健康巡检"
      icon={<span>❤️</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始巡检"
      generateReport={generateReport}
      onGenerateReportChange={setGenerateReport}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">巡检范围</label>
          <ChipGroup
            options={[
              { label: "全面", value: "full" },
              { label: "仅服务", value: "service" },
              { label: "仅资源", value: "resource" },
            ]}
            value={scope}
            onChange={(v) => setScope(v as string)}
          />
        </div>
        <InputField
          label="指定服务（可选）"
          placeholder="nginx, mysql, docker"
          value={services}
          onChange={setServices}
          hint="不填则自动发现运行中的服务"
        />
      </div>
    </ConfigPanel>
  );
}

// ---------------------------------------------------------------------------
// 2. Fault Diagnosis
// ---------------------------------------------------------------------------

interface FaultDiagnosisConfigProps {
  onConfirm: (result: ActionConfirmResult) => void;
  onCancel: () => void;
}

export function FaultDiagnosisConfig({ onConfirm, onCancel }: FaultDiagnosisConfigProps) {
  const [symptoms, setSymptoms] = useState<string[]>(["service_down"]);
  const [relatedServices, setRelatedServices] = useState("");
  const [description, setDescription] = useState("");
  const [generateReport, setGenerateReport] = useState(false);

  const handleConfirm = () => {
    const symptomMap: Record<string, string> = {
      service_down: "服务不可用",
      slow: "响应变慢",
      connection: "连接异常",
      crash: "报错/崩溃",
    };
    const symptomText = symptoms.map((s) => symptomMap[s] ?? s).join("、");
    const servicePart = relatedServices.trim()
      ? `关联服务：${relatedServices.trim()}。`
      : "";
    const descPart = description.trim()
      ? `用户补充：${description.trim()}。`
      : "";

    const checks: string[] = [];
    if (symptoms.includes("service_down")) {
      checks.push("检查相关服务进程是否存活");
      checks.push("检查端口是否在监听");
    }
    if (symptoms.includes("slow")) {
      checks.push("检查 CPU/内存/IO 瓶颈");
      checks.push("检查是否有慢查询或阻塞");
    }
    if (symptoms.includes("connection")) {
      checks.push("检查网络连通性和防火墙");
      checks.push("检查 DNS 解析");
    }
    if (symptoms.includes("crash")) {
      checks.push("检查系统日志中的错误信息");
      checks.push("检查 OOM killer 和 core dump");
    }
    checks.push("检查系统资源是否耗尽");

    let prompt = `服务器出现故障，现象：${symptomText}。${servicePart}${descPart}请系统性排查：${checks.map((c, i) => `${i + 1}) ${c}`).join("；")}。定位根因后给出修复方案。`;
    if (generateReport) prompt += REPORT_INSTRUCTION;
    onConfirm({ label: "故障诊断", prompt, generateReport });
  };

  return (
    <ConfigPanel
      title="故障诊断"
      icon={<span>🔍</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始诊断"
      generateReport={generateReport}
      onGenerateReportChange={setGenerateReport}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">故障现象（可多选）</label>
          <ChipGroup
            multiple
            options={[
              { label: "服务不可用", value: "service_down" },
              { label: "响应变慢", value: "slow" },
              { label: "连接异常", value: "connection" },
              { label: "报错/崩溃", value: "crash" },
            ]}
            value={symptoms}
            onChange={(v) => setSymptoms(v as string[])}
          />
        </div>
        <InputField
          label="关联服务（可选）"
          placeholder="nginx, php-fpm, mysql"
          value={relatedServices}
          onChange={setRelatedServices}
        />
        <InputField
          label="补充描述（可选）"
          placeholder="如 502 Bad Gateway、Connection refused"
          value={description}
          onChange={setDescription}
        />
      </div>
    </ConfigPanel>
  );
}

// ---------------------------------------------------------------------------
// 3. Performance Analysis
// ---------------------------------------------------------------------------

interface PerformanceConfigProps {
  onConfirm: (result: ActionConfirmResult) => void;
  onCancel: () => void;
}

export function PerformanceConfig({ onConfirm, onCancel }: PerformanceConfigProps) {
  const [dimension, setDimension] = useState("full");
  const [processes, setProcesses] = useState("");
  const [generateReport, setGenerateReport] = useState(false);

  const handleConfirm = () => {
    const processPart = processes.trim()
      ? `重点关注进程：${processes.trim()}。`
      : "";
    const dimMap: Record<string, { label: string; checks: string }> = {
      full: {
        label: "全面",
        checks:
          "1) CPU 使用率和 load average，找出 CPU 密集进程；2) 内存和 swap 使用，检查是否有内存泄漏；3) 磁盘 IO 等待和吞吐（iostat）；4) 网络连接数和 TCP 状态",
      },
      cpu: {
        label: "CPU",
        checks:
          "1) load average 和 CPU 使用率分布（us/sy/id/wa）；2) 上下文切换频率；3) 最耗 CPU 的进程",
      },
      memory: {
        label: "内存",
        checks:
          "1) 总内存和 swap 使用率；2) 缓存/缓冲区占用；3) 内存占用 TOP 进程；4) 是否有进程存在内存泄漏迹象",
      },
      disk: {
        label: "磁盘IO",
        checks:
          "1) iostat 各设备 IO 等待和吞吐；2) 最耗 IO 的进程（iotop）；3) 是否有 IO 瓶颈",
      },
      network: {
        label: "网络",
        checks:
          "1) 网络连接数和 TCP 状态分布；2) 带宽使用情况；3) 是否有异常流量",
      },
    };
    const dim = dimMap[dimension] ?? dimMap.full;
    let prompt = `分析服务器性能瓶颈，维度：${dim.label}。${processPart}检查：${dim.checks}。定位瓶颈后给出：当前瓶颈是什么、根因分析、优化建议。`;
    if (generateReport) prompt += REPORT_INSTRUCTION;
    onConfirm({ label: "性能分析", prompt, generateReport });
  };

  return (
    <ConfigPanel
      title="性能分析"
      icon={<span>⚡</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始分析"
      generateReport={generateReport}
      onGenerateReportChange={setGenerateReport}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">分析维度</label>
          <ChipGroup
            options={[
              { label: "全面", value: "full" },
              { label: "CPU", value: "cpu" },
              { label: "内存", value: "memory" },
              { label: "磁盘IO", value: "disk" },
              { label: "网络", value: "network" },
            ]}
            value={dimension}
            onChange={(v) => setDimension(v as string)}
          />
        </div>
        <InputField
          label="关注的进程（可选）"
          placeholder="java, node, python, nginx"
          value={processes}
          onChange={setProcesses}
        />
      </div>
    </ConfigPanel>
  );
}

// ---------------------------------------------------------------------------
// 4. Log Analysis
// ---------------------------------------------------------------------------

interface LogAnalysisConfigProps {
  onConfirm: (result: ActionConfirmResult) => void;
  onCancel: () => void;
}

export function LogAnalysisConfig({ onConfirm, onCancel }: LogAnalysisConfigProps) {
  const [sources, setSources] = useState<string[]>(["system"]);
  const [timeRange, setTimeRange] = useState("1h");
  const [keywords, setKeywords] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [generateReport, setGenerateReport] = useState(false);

  const handleConfirm = () => {
    const sourceMap: Record<string, string> = {
      system: "系统日志（journalctl）",
      nginx: "Nginx 日志",
      mysql: "MySQL 日志",
      docker: "Docker 容器日志",
    };
    const sourceText = sources
      .map((s) => (s === "custom" ? customPath.trim() || "自定义日志" : sourceMap[s]))
      .join("、");
    const timeMap: Record<string, string> = {
      "1h": "最近1小时",
      "6h": "最近6小时",
      "24h": "最近24小时",
    };
    const timeText = timeMap[timeRange] ?? "最近1小时";
    const kwPart = keywords.trim()
      ? `，关键词过滤：${keywords.trim()}`
      : "";

    const sourceInstructions: Record<string, string> = {
      system: "用 journalctl 读取系统日志",
      nginx: "读取 Nginx 错误日志和访问日志",
      mysql: "读取 MySQL 错误日志和慢查询日志",
      docker: "用 docker logs 读取容器日志",
    };
    const howToRead = sources
      .map((s) =>
        s === "custom"
          ? `读取文件 ${customPath.trim()} 的内容`
          : sourceInstructions[s],
      )
      .join("；");

    let prompt = `分析${sourceText}，时间范围：${timeText}${kwPart}。${howToRead}，过滤相关条目。统计：1) 错误类型分布；2) 高频错误 TOP5；3) 是否有集中爆发的时段；4) 关联分析（是否和特定服务/接口相关）。给出结论和建议。`;
    if (generateReport) prompt += REPORT_INSTRUCTION;
    onConfirm({ label: "日志分析", prompt, generateReport });
  };

  return (
    <ConfigPanel
      title="日志分析"
      icon={<span>📋</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始分析"
      generateReport={generateReport}
      onGenerateReportChange={setGenerateReport}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">日志来源（可多选）</label>
          <ChipGroup
            multiple
            options={[
              { label: "系统日志", value: "system" },
              { label: "Nginx", value: "nginx" },
              { label: "MySQL", value: "mysql" },
              { label: "Docker", value: "docker" },
              { label: "自定义", value: "custom" },
            ]}
            value={sources}
            onChange={(v) => setSources(v as string[])}
          />
        </div>
        {sources.includes("custom") && (
          <InputField
            label="自定义日志路径"
            placeholder="/var/log/myapp/app.log"
            value={customPath}
            onChange={setCustomPath}
          />
        )}
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">时间范围</label>
          <ChipGroup
            options={[
              { label: "1小时", value: "1h" },
              { label: "6小时", value: "6h" },
              { label: "24小时", value: "24h" },
            ]}
            value={timeRange}
            onChange={(v) => setTimeRange(v as string)}
          />
        </div>
        <InputField
          label="关键词过滤（可选）"
          placeholder="error, timeout, refused, OOM"
          value={keywords}
          onChange={setKeywords}
        />
      </div>
    </ConfigPanel>
  );
}

// ---------------------------------------------------------------------------
// 5. Deploy Verification
// ---------------------------------------------------------------------------

interface DeployVerifyConfigProps {
  onConfirm: (result: ActionConfirmResult) => void;
  onCancel: () => void;
}

export function DeployVerifyConfig({ onConfirm, onCancel }: DeployVerifyConfigProps) {
  const [serviceName, setServiceName] = useState("");
  const [port, setPort] = useState("");
  const [checks, setChecks] = useState<string[]>(["process", "port", "log"]);
  const [healthEndpoint, setHealthEndpoint] = useState("");
  const [generateReport, setGenerateReport] = useState(false);

  const handleConfirm = () => {
    const checkMap: Record<string, string> = {
      process: "检查进程是否存活",
      port: "检查端口是否在监听",
      log: "检查启动日志是否有 ERROR",
      health: `请求健康检查端点 ${healthEndpoint.trim() || "http://localhost/health"}`,
    };
    const checkItems = checks.map((c) => checkMap[c] ?? c);
    const servicePart = serviceName.trim() || "目标服务";
    const portPart = port.trim() ? `，端口：${port.trim()}` : "";

    let prompt = `验证部署是否成功，服务：${servicePart}${portPart}。验证项：${checkItems.map((c, i) => `${i + 1}) ${c}`).join("；")}。逐项给出 ✅通过 / ❌失败，如有失败项给出原因和修复建议。`;
    if (generateReport) prompt += REPORT_INSTRUCTION;
    onConfirm({ label: "部署验证", prompt, generateReport });
  };

  return (
    <ConfigPanel
      title="部署验证"
      icon={<span>✅</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始验证"
      generateReport={generateReport}
      onGenerateReportChange={setGenerateReport}
    >
      <div className="space-y-3">
        <InputField
          label="服务名称"
          placeholder="my-api, web-server, app"
          value={serviceName}
          onChange={setServiceName}
        />
        <InputField
          label="验证端口（可选）"
          placeholder="8080, 3000, 80, 443"
          value={port}
          onChange={setPort}
        />
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">验证项</label>
          <CheckboxGroup
            items={[
              { label: "进程存活", value: "process" },
              { label: "端口监听", value: "port" },
              { label: "日志无报错", value: "log" },
              { label: "健康检查端点", value: "health" },
            ]}
            value={checks}
            onChange={setChecks}
          />
        </div>
        {checks.includes("health") && (
          <InputField
            label="健康端点"
            placeholder="http://localhost:8080/health"
            value={healthEndpoint}
            onChange={setHealthEndpoint}
          />
        )}
      </div>
    </ConfigPanel>
  );
}

// ---------------------------------------------------------------------------
// 6. Security Audit
// ---------------------------------------------------------------------------

interface SecurityAuditConfigProps {
  onConfirm: (result: ActionConfirmResult) => void;
  onCancel: () => void;
}

export function SecurityAuditConfig({ onConfirm, onCancel }: SecurityAuditConfigProps) {
  const [items, setItems] = useState<string[]>(["login", "process"]);
  const [severity, setSeverity] = useState("all");
  const [generateReport, setGenerateReport] = useState(false);

  const handleConfirm = () => {
    const itemMap: Record<string, { label: string; checks: string }> = {
      login: {
        label: "异常登录",
        checks:
          "1) 检查最近的失败登录尝试（lastb、/var/log/auth.log），统计来源 IP，判断是否有暴力破解；2) 检查是否有异常的 root 登录或非工作时间登录",
      },
      process: {
        label: "可疑进程",
        checks:
          "3) 检查是否有可疑进程（高 CPU 但无名、隐藏进程、挖矿特征等）",
      },
      port: {
        label: "异常端口",
        checks: "4) 检查未知监听端口和异常外连",
      },
      permission: {
        label: "权限风险",
        checks: "5) 检查 SUID 文件和弱权限配置",
      },
    };
    const checksText = items
      .map((i) => itemMap[i]?.checks ?? "")
      .filter(Boolean)
      .join("；");
    const severityInstruction =
      severity === "critical"
        ? "仅输出 🔴高危项，给出紧急处置建议。"
        : "按严重程度分级：🔴高危 🟡中等 🟢低危，高危项给出处置建议。";

    let prompt = `安全巡检，检查项：${items.map((i) => itemMap[i]?.label ?? i).join("、")}。${checksText}。${severityInstruction}`;
    if (generateReport) prompt += REPORT_INSTRUCTION;
    onConfirm({ label: "安全巡检", prompt, generateReport });
  };

  return (
    <ConfigPanel
      title="安全巡检"
      icon={<span>🛡️</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始巡检"
      generateReport={generateReport}
      onGenerateReportChange={setGenerateReport}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">检查项（可多选）</label>
          <CheckboxGroup
            items={[
              { label: "异常登录", value: "login" },
              { label: "可疑进程", value: "process" },
              { label: "异常端口", value: "port" },
              { label: "权限风险", value: "permission" },
            ]}
            value={items}
            onChange={setItems}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">严重程度</label>
          <ChipGroup
            options={[
              { label: "全部", value: "all" },
              { label: "仅高危", value: "critical" },
            ]}
            value={severity}
            onChange={(v) => setSeverity(v as string)}
          />
        </div>
      </div>
    </ConfigPanel>
  );
}
