import type {
  BootHistoryResult,
  DiagnosticCheck,
  MaintenanceHistory,
  SoftwareCheckResult,
  StartupListResult,
  StorageScanResult,
} from "./useSystemData";
import { DIAGNOSTIC_CHECKS } from "./useSystemData";
import type { SystemTab } from "./systemTabs";

export type InspectionCardTone = "info" | "warning" | "success";

export interface InspectionCard {
  id: string;
  tone: InspectionCardTone;
  priority: number;
  title: string;
  detail: string;
  metric: string;
  /** 一键处理目标；null 表示该卡仅支持「查看」跳转 */
  goal: string | null;
  actionLabel: string | null;
  tab: SystemTab;
}

export interface InspectionInput {
  diagnostics: DiagnosticCheck[];
  storage: StorageScanResult | null;
  software: SoftwareCheckResult | null;
  startup: StartupListResult | null;
  boot: BootHistoryResult | null;
  maintenance: MaintenanceHistory | null;
  /** 当前毫秒时间戳，测试可注入 */
  now?: number;
}

const MAX_CARDS = 3;
/** 开机变慢超过该阈值才出卡 */
const BOOT_SLOWDOWN_MS = 3_000;
/** 可清理空间低于该值不出卡（单位 GB） */
const MIN_CLEANABLE_GB = 0.1;
/** 维护事件超过该窗口不再计入「最近维护」 */
const MAINTENANCE_RECENT_MS = 7 * 24 * 3_600_000;

// 后端返回短 id（如 pending_reboot），命令名为 system_check_<id>
export function diagnosticLabel(id: string): string {
  return DIAGNOSTIC_CHECKS.find((item) => item.command === id || item.command === `system_check_${id}`)?.label ?? id;
}

function formatDeltaMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} 秒`;
}

function formatRelativeTime(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return `${days} 天前`;
}

export function buildInspectionCards(input: InspectionInput): InspectionCard[] {
  const cards: InspectionCard[] = [];

  // 健康检查异常：每个 attention 检查项一张卡，优先级最高
  for (const check of input.diagnostics) {
    if (check.status !== "attention") continue;
    cards.push({
      id: `diagnostic:${check.id}`,
      tone: "warning",
      priority: 100,
      title: diagnosticLabel(check.id),
      detail: check.summary,
      metric: "需关注",
      goal: null,
      actionLabel: null,
      tab: "overview",
    });
  }

  // 可清理空间（有扫描结果时）
  const cleanable = (input.storage?.cleanupItems ?? []).filter((item) => item.cleanable);
  const cleanableGb = cleanable.reduce((sum, item) => sum + item.sizeGb, 0);
  if (cleanable.length > 0 && cleanableGb >= MIN_CLEANABLE_GB) {
    cards.push({
      id: "storage",
      tone: "info",
      priority: 80,
      title: "可清理空间",
      detail: `${cleanable.length} 类缓存/临时文件可安全清理`,
      metric: `${cleanableGb.toFixed(1)} GB`,
      goal: "释放磁盘可清理空间",
      actionLabel: "一键清理",
      tab: "storage",
    });
  }

  // 软件更新
  const updateCount = input.software?.updates.length ?? 0;
  if (updateCount > 0) {
    cards.push({
      id: "software",
      tone: "info",
      priority: 60,
      title: "软件更新",
      detail: "WinGet 检测到可用更新",
      metric: `${updateCount} 项`,
      goal: "更新所有可升级的软件",
      actionLabel: "一键更新",
      tab: "software",
    });
  }

  // 新增启动项
  const newItems = (input.startup?.items ?? []).filter((item) => item.isNew);
  if (newItems.length > 0) {
    const names = newItems.slice(0, 2).map((item) => item.name).join("、");
    cards.push({
      id: "startup",
      tone: "warning",
      priority: 50,
      title: "新增启动项待审查",
      detail: newItems.length > 2 ? `${names} 等 ${newItems.length} 项` : names,
      metric: `${newItems.length} 项`,
      goal: "审查并禁用不需要的新增启动项",
      actionLabel: "一键审查",
      tab: "startup",
    });
  }

  // 开机变慢
  const bootDelta = input.boot?.lastDeltaMs ?? null;
  if (bootDelta !== null && bootDelta >= BOOT_SLOWDOWN_MS) {
    cards.push({
      id: "boot",
      tone: "info",
      priority: 40,
      title: "开机变慢",
      detail: "最近一次启动耗时高于近期均值",
      metric: `慢 ${formatDeltaMs(bootDelta)}`,
      goal: "分析开机变慢的原因",
      actionLabel: "一键诊断",
      tab: "startup",
    });
  }

  // 最近维护（闭环回流）
  const now = input.now ?? Date.now();
  const recentEvents = (input.maintenance?.events ?? [])
    .filter((event) => now - event.ts * 1000 <= MAINTENANCE_RECENT_MS)
    .sort((a, b) => b.ts - a.ts);
  const recent = recentEvents[0];

  // 维护回流：某类当前无问题且近期维护过 → success 卡（"已保持正常"的连续记忆）
  const maintained = (
    issueId: string,
    categories: string[],
    title: string,
    tab: SystemTab,
  ) => {
    if (cards.some((card) => card.id === issueId)) return;
    const event = recentEvents.find((item) => categories.includes(item.category));
    if (!event) return;
    cards.push({
      id: `maintained:${issueId}`,
      tone: "success",
      priority: 20,
      title,
      detail: `最近维护：${event.title}`,
      metric: formatRelativeTime(now - event.ts * 1000),
      goal: null,
      actionLabel: null,
      tab,
    });
  };
  maintained("storage", ["清理"], "存储空间状态良好", "storage");
  maintained("software", ["更新", "卸载"], "软件已全部是最新", "software");
  maintained("startup", ["启动项"], "启动项无异常新增", "startup");

  if (recent) {
    cards.push({
      id: "maintenance",
      tone: "success",
      priority: 10,
      title: "最近维护",
      detail: recent.title,
      metric: formatRelativeTime(now - recent.ts * 1000),
      goal: null,
      actionLabel: null,
      tab: "maintenance",
    });
  }

  return cards.sort((a, b) => b.priority - a.priority).slice(0, MAX_CARDS);
}
