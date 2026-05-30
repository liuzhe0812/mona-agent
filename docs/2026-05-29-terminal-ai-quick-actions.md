# 终端 AI 快捷功能重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将终端 AI 助手的 6 个快捷按钮从"点击直接发 prompt"升级为"点击→配置→发精准 prompt"的交互模式，通过预置常用内容让配置更友好。

**Architecture:** QuickActions 组件内部维护两种视图状态（按钮网格 / 配置面板），点击按钮切换到对应配置面板，用户配置后点"开始"生成 prompt 发送给 AIChat。6 个配置面板共享 ChipGroup / CheckboxGroup / InputField 三个基础组件，每个面板有独立的 buildPrompt() 函数。

**Tech Stack:** React + TypeScript + Tailwind CSS + lucide-react icons

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `webui/src/components/terminal/AIPanel/QuickActions.tsx` | Rewrite | 按钮网格 + 视图切换逻辑 |
| `webui/src/components/terminal/AIPanel/ActionConfig.tsx` | Create | 6 个配置面板组件 + buildPrompt 函数 |
| `webui/src/components/terminal/AIPanel/AIPanel.tsx` | Modify | 适配新的 onAction 签名 |
| `webui/src/components/terminal/AIPanel/AIChat.tsx` | No change | 不变 |

---

### Task 1: Create ActionConfig.tsx — shared UI components

**Files:**
- Create: `webui/src/components/terminal/AIPanel/ActionConfig.tsx`

- [ ] **Step 1: Create ActionConfig.tsx with shared ChipGroup, CheckboxGroup, InputField components**

```tsx
import { useState, useCallback } from "react";
import { ArrowLeft, X, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Config panel wrapper
// ---------------------------------------------------------------------------

interface ConfigPanelProps {
  title: string;
  icon: React.ReactNode;
  onConfirm: (prompt: string) => void;
  onCancel: () => void;
  children: React.ReactNode;
  confirmLabel?: string;
}

export function ConfigPanel({
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
```

---

### Task 2: Add 6 config panels to ActionConfig.tsx

**Files:**
- Modify: `webui/src/components/terminal/AIPanel/ActionConfig.tsx`

- [ ] **Step 1: Add HealthCheckConfig component and its buildPrompt**

Append to ActionConfig.tsx:

```tsx
// ---------------------------------------------------------------------------
// 1. Health Check
// ---------------------------------------------------------------------------

interface HealthCheckConfigProps {
  onConfirm: (prompt: string) => void;
  onCancel: () => void;
}

export function HealthCheckConfig({ onConfirm, onCancel }: HealthCheckConfigProps) {
  const [scope, setScope] = useState("full");
  const [services, setServices] = useState("");

  const handleConfirm = () => {
    const servicePart = services.trim()
      ? `重点检查以下服务：${services.trim()}。`
      : "先自动发现运行中的关键服务（用 systemctl list-units），";
    if (scope === "full") {
      onConfirm(
        `对这台服务器做一次全面健康巡检。${servicePart}然后检查：1) 各服务运行状态，是否有崩溃或频繁重启；2) CPU/内存/磁盘使用率，是否有资源即将耗尽；3) 最近是否有系统级错误（OOM、kernel panic）。最后给出分级摘要：🟢正常项、🟡需关注项、🔴异常项，对异常项给出原因和修复建议。`,
      );
    } else if (scope === "service") {
      onConfirm(
        `检查这台服务器的服务运行状态。${servicePart}检查是否有服务崩溃、频繁重启或处于 failed 状态。给出分级摘要：🟢正常 🟡注意 🔴异常。`,
      );
    } else {
      onConfirm(
        `检查这台服务器的资源使用情况：CPU 使用率和 load average、内存和 swap 使用率、各磁盘分区使用率。给出分级摘要：🟢正常 🟡需关注 🔴即将耗尽，对异常项给出具体数值和建议。`,
      );
    }
  };

  return (
    <ConfigPanel
      title="健康巡检"
      icon={<span>❤️</span>}
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
```

- [ ] **Step 2: Add FaultDiagnosisConfig component and its buildPrompt**

Append to ActionConfig.tsx:

```tsx
// ---------------------------------------------------------------------------
// 2. Fault Diagnosis
// ---------------------------------------------------------------------------

interface FaultDiagnosisConfigProps {
  onConfirm: (prompt: string) => void;
  onCancel: () => void;
}

export function FaultDiagnosisConfig({ onConfirm, onCancel }: FaultDiagnosisConfigProps) {
  const [symptoms, setSymptoms] = useState<string[]>(["service_down"]);
  const [relatedServices, setRelatedServices] = useState("");
  const [description, setDescription] = useState("");

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

    onConfirm(
      `服务器出现故障，现象：${symptomText}。${servicePart}${descPart}请系统性排查：${checks.map((c, i) => `${i + 1}) ${c}`).join("；")}。定位根因后给出修复方案。`,
    );
  };

  return (
    <ConfigPanel
      title="故障诊断"
      icon={<span>🔍</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始诊断"
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
```

- [ ] **Step 3: Add PerformanceConfig component and its buildPrompt**

Append to ActionConfig.tsx:

```tsx
// ---------------------------------------------------------------------------
// 3. Performance Analysis
// ---------------------------------------------------------------------------

interface PerformanceConfigProps {
  onConfirm: (prompt: string) => void;
  onCancel: () => void;
}

export function PerformanceConfig({ onConfirm, onCancel }: PerformanceConfigProps) {
  const [dimension, setDimension] = useState("full");
  const [processes, setProcesses] = useState("");

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
    onConfirm(
      `分析服务器性能瓶颈，维度：${dim.label}。${processPart}检查：${dim.checks}。定位瓶颈后给出：当前瓶颈是什么、根因分析、优化建议。`,
    );
  };

  return (
    <ConfigPanel
      title="性能分析"
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
```

- [ ] **Step 4: Add LogAnalysisConfig component and its buildPrompt**

Append to ActionConfig.tsx:

```tsx
// ---------------------------------------------------------------------------
// 4. Log Analysis
// ---------------------------------------------------------------------------

interface LogAnalysisConfigProps {
  onConfirm: (prompt: string) => void;
  onCancel: () => void;
}

export function LogAnalysisConfig({ onConfirm, onCancel }: LogAnalysisConfigProps) {
  const [sources, setSources] = useState<string[]>(["system"]);
  const [timeRange, setTimeRange] = useState("1h");
  const [keywords, setKeywords] = useState("");
  const [customPath, setCustomPath] = useState("");

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

    onConfirm(
      `分析${sourceText}，时间范围：${timeText}${kwPart}。${howToRead}，过滤相关条目。统计：1) 错误类型分布；2) 高频错误 TOP5；3) 是否有集中爆发的时段；4) 关联分析（是否和特定服务/接口相关）。给出结论和建议。`,
    );
  };

  return (
    <ConfigPanel
      title="日志分析"
      icon={<span>📋</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始分析"
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
```

- [ ] **Step 5: Add DeployVerifyConfig component and its buildPrompt**

Append to ActionConfig.tsx:

```tsx
// ---------------------------------------------------------------------------
// 5. Deploy Verification
// ---------------------------------------------------------------------------

interface DeployVerifyConfigProps {
  onConfirm: (prompt: string) => void;
  onCancel: () => void;
}

export function DeployVerifyConfig({ onConfirm, onCancel }: DeployVerifyConfigProps) {
  const [serviceName, setServiceName] = useState("");
  const [port, setPort] = useState("");
  const [checks, setChecks] = useState<string[]>(["process", "port", "log"]);
  const [healthEndpoint, setHealthEndpoint] = useState("");

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

    onConfirm(
      `验证部署是否成功，服务：${servicePart}${portPart}。验证项：${checkItems.map((c, i) => `${i + 1}) ${c}`).join("；")}。逐项给出 ✅通过 / ❌失败，如有失败项给出原因和修复建议。`,
    );
  };

  return (
    <ConfigPanel
      title="部署验证"
      icon={<span>✅</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始验证"
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
```

- [ ] **Step 6: Add SecurityAuditConfig component and its buildPrompt**

Append to ActionConfig.tsx:

```tsx
// ---------------------------------------------------------------------------
// 6. Security Audit
// ---------------------------------------------------------------------------

interface SecurityAuditConfigProps {
  onConfirm: (prompt: string) => void;
  onCancel: () => void;
}

export function SecurityAuditConfig({ onConfirm, onCancel }: SecurityAuditConfigProps) {
  const [items, setItems] = useState<string[]>(["login", "process"]);
  const [severity, setSeverity] = useState("all");

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

    onConfirm(
      `安全巡检，检查项：${items.map((i) => itemMap[i]?.label ?? i).join("、")}。${checksText}。${severityInstruction}`,
    );
  };

  return (
    <ConfigPanel
      title="安全巡检"
      icon={<span>🛡️</span>}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      confirmLabel="开始巡检"
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
```

---

### Task 3: Rewrite QuickActions.tsx — button grid + config panel switching

**Files:**
- Rewrite: `webui/src/components/terminal/AIPanel/QuickActions.tsx`

- [ ] **Step 1: Rewrite QuickActions.tsx with view switching logic**

Replace entire file content:

```tsx
import { useState } from "react";
import {
  Heart,
  Search,
  Zap,
  FileText,
  CheckCircle,
  ShieldCheck,
} from "lucide-react";
import {
  HealthCheckConfig,
  FaultDiagnosisConfig,
  PerformanceConfig,
  LogAnalysisConfig,
  DeployVerifyConfig,
  SecurityAuditConfig,
} from "./ActionConfig";

interface Props {
  onAction: (prompt: string) => void;
}

type ActionId =
  | "health"
  | "fault"
  | "performance"
  | "log"
  | "deploy"
  | "security"
  | null;

const ACTIONS = [
  {
    id: "health" as const,
    icon: Heart,
    label: "健康巡检",
  },
  {
    id: "fault" as const,
    icon: Search,
    label: "故障诊断",
  },
  {
    id: "performance" as const,
    icon: Zap,
    label: "性能分析",
  },
  {
    id: "log" as const,
    icon: FileText,
    label: "日志分析",
  },
  {
    id: "deploy" as const,
    icon: CheckCircle,
    label: "部署验证",
  },
  {
    id: "security" as const,
    icon: ShieldCheck,
    label: "安全巡检",
  },
];

export function QuickActions({ onAction }: Props) {
  const [activeId, setActiveId] = useState<ActionId>(null);

  const handleCancel = () => setActiveId(null);
  const handleConfirm = (prompt: string) => {
    setActiveId(null);
    onAction(prompt);
  };

  if (activeId) {
    return (
      <div className="px-1 py-0.5">
        {activeId === "health" && (
          <HealthCheckConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
        {activeId === "fault" && (
          <FaultDiagnosisConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
        {activeId === "performance" && (
          <PerformanceConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
        {activeId === "log" && (
          <LogAnalysisConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
        {activeId === "deploy" && (
          <DeployVerifyConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
        {activeId === "security" && (
          <SecurityAuditConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-1">
      {ACTIONS.map((action) => (
        <button
          key={action.id}
          onClick={() => setActiveId(action.id)}
          className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition-colors"
        >
          <action.icon className="h-3 w-3 shrink-0" />
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}
```

---

### Task 4: Update AIPanel.tsx — adapt to new QuickActions

**Files:**
- Modify: `webui/src/components/terminal/AIPanel/AIPanel.tsx`

- [ ] **Step 1: Update AIPanel.tsx — adjust QuickActions container padding**

The current AIPanel wraps QuickActions in `<div className="border-b p-3">`. The new config panel needs slightly different padding. Update to use consistent spacing:

Replace the QuickActions container div:

Old:
```tsx
<div className="border-b p-3">
  <QuickActions onAction={handleQuickAction} />
</div>
```

New:
```tsx
<div className="border-b px-3 py-2">
  <QuickActions onAction={handleQuickAction} />
</div>
```

---

### Task 5: Verify and test

- [ ] **Step 1: Run TypeScript type check**

Run: `cd webui && npx tsc --noEmit` (or equivalent build check)

Expected: No type errors in the modified files.

- [ ] **Step 2: Manual visual verification**

Open the terminal module, toggle AI panel, verify:
1. 6 buttons render correctly in 2×3 grid
2. Clicking each button shows the correct config panel
3. "返回" and ✕ both return to button grid
4. Clicking "开始" sends prompt to AIChat and returns to button grid
5. Default values work without any configuration
6. Config panel conditional fields show/hide correctly (e.g., custom log path, health endpoint)
