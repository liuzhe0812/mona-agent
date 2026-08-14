import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  LogIn,
  LogOut,
  MessageSquareText,
  MoreHorizontal,
  Settings,
  Sparkles,
  User,
  UserCog,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentLogo } from "@/components/AgentLogo";
import { mergeSidebarModules, MODULE_DEFS } from "@/components/Sidebar";
import { useEmailStore } from "@/components/email/store/emailStore";
import { useTodoStore } from "@/components/schedule/todoStore";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLicense } from "@/hooks/useLicense";
import type { SidebarModuleConfig } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * 企业微信式窄功能栏（阶段 4.5）：固定 64px，无展开/折叠态。
 * 头像置顶，消息/伙伴在前，其余模块跟随其后，账号置底。
 * 高度不足时模块从尾部收进「更多」，底部区域 shrink-0 永不压缩。
 */
interface AppRailProps {
  /** 当前主视图 id（chat / partners / note / email / ...）。 */
  activeView: string;
  onGoHome: () => void;
  onOpenMessages: () => void;
  onOpenPartners: () => void;
  onOpenNote: () => void;
  onOpenDoc: () => void;
  onOpenSSH: () => void;
  onOpenDb: () => void;
  onOpenEmail: () => void;
  onOpenSchedule: () => void;
  onOpenSystem: () => void;
  onOpenProfile: () => void;
  onOpenSettings: (section?: string) => void;
  onOpenLogin?: () => void;
  onOpenSubscribe?: () => void;
  onStartUpdate?: () => void;
  updateAvailable?: boolean;
  runningChatIds?: string[];
  modules?: SidebarModuleConfig[];
}

function isMacOS() {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform.toLowerCase();
  return platform.includes("mac") || platform.includes("iphone") || platform.includes("ipad");
}

// 单项槽位高度：py-1.5(12) + 图标 h-5(20) + gap-1(4) + 10px 标签 + 列表 gap-0.5(2)
const RAIL_ITEM_PITCH_PX = 48;

function RailItem({
  label,
  icon,
  active,
  badge,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "relative flex w-full flex-col items-center gap-1 rounded-lg px-1 py-1.5 transition-colors",
        active
          ? "bg-[hsl(var(--sidebar-active-surface)/0.07)] text-primary"
          : "text-sidebar-foreground/80 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
      )}
    >
      <span className="relative flex h-5 w-5 items-center justify-center" aria-hidden>
        {icon}
        {badge !== undefined && badge > 0 && (
          <span className="absolute -right-2 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-[8px] font-semibold leading-none text-white">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      <span className="max-w-full truncate text-[10px] leading-none">{label}</span>
    </button>
  );
}

export function AppRail(props: AppRailProps) {
  const { t } = useTranslation();
  const { loggedIn, licenseInfo, licenseActive, serverTrial, logout } = useLicense();
  const emailUnreadCount = useEmailStore((s) => s.totalUnreadCount);
  const planInboxCount = useTodoStore((s) => s.inboxCount);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const agentLogoState = props.runningChatIds?.length ? "working" : "idle";

  const moduleHandlers: Record<string, () => void> = {
    note: props.onOpenNote,
    doc: props.onOpenDoc,
    ssh: props.onOpenSSH,
    db: props.onOpenDb,
    email: props.onOpenEmail,
    schedule: props.onOpenSchedule,
    system: props.onOpenSystem,
    profile: props.onOpenProfile,
  };
  // 「消息」替代原 chat 模块入口，chat 不再重复出现在模块列表
  const merged = mergeSidebarModules(props.modules).filter((m) => m.key !== "chat");
  const defMap = new Map(MODULE_DEFS.map((d) => [d.key, d]));
  const visible = merged
    .filter((m) => m.visible)
    .map((m) => defMap.get(m.key))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .filter((d) => !isMacOS() || !d.windowsOnly);

  // 直出槽位容量 = 中间区可用高度 ÷ 单槽位高度。中间区 flex-1 min-h-0，
  // 其 clientHeight 即真实可用高度，用 ResizeObserver 跟踪（窗口缩放、
  // 底部区域内容变化都会触发）。useLayoutEffect 保证首帧绘制前完成首测，
  // 无「先全直出再收敛」的闪烁。无布局环境（jsdom，高度为 0）不收敛，全部直出。
  const UNLIMITED = Number.MAX_SAFE_INTEGER;
  const middleRef = useRef<HTMLDivElement>(null);
  const [slotCapacity, setSlotCapacity] = useState(UNLIMITED);
  useLayoutEffect(() => {
    const el = middleRef.current;
    if (!el) return;
    const update = () => {
      const h = el.clientHeight;
      if (h === 0) {
        setSlotCapacity(UNLIMITED);
        return;
      }
      setSlotCapacity(Math.max(2, Math.floor(h / RAIL_ITEM_PITCH_PX)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 槽位分配：「消息/伙伴」固定 2 槽，其余给模块；放不下时留 1 槽给「更多」
  const moduleCapacity = Math.max(0, slotCapacity - 2);
  const primaryCount =
    visible.length > moduleCapacity ? Math.max(0, moduleCapacity - 1) : visible.length;
  const primary = visible.slice(0, primaryCount);
  const secondary = visible.slice(primaryCount);

  return (
    <TooltipProvider delayDuration={0}>
      <nav
        aria-label={t("rail.navigation")}
        className="flex h-full w-16 shrink-0 flex-col items-center bg-transparent pb-2 pt-2 text-sidebar-foreground"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("rail.home")}
              onClick={props.onGoHome}
              className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full transition-colors hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)]"
            >
              <AgentLogo state={agentLogoState} className="h-9 w-9" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("rail.home")}</TooltipContent>
        </Tooltip>

        <div ref={middleRef} className="mt-3 flex min-h-0 w-full flex-1 flex-col gap-0.5 overflow-hidden px-2">
          <RailItem
            label={t("rail.messages")}
            icon={<MessageSquareText className="h-5 w-5" />}
            active={props.activeView === "chat"}
            onClick={props.onOpenMessages}
          />
          <RailItem
            label={t("rail.partners")}
            icon={<Users className="h-5 w-5" />}
            active={props.activeView === "partners"}
            onClick={props.onOpenPartners}
          />
          {primary.map((item) => (
            <RailItem
              key={item.key}
              label={t(`rail.modules.${item.key}`, item.label)}
              icon={item.icon}
              active={props.activeView === item.key}
              badge={
                item.key === "email" && emailUnreadCount > 0
                  ? emailUnreadCount
                  : item.key === "schedule" && planInboxCount > 0
                    ? planInboxCount
                    : undefined
              }
              onClick={moduleHandlers[item.key] ?? (() => {})}
            />
          ))}
          {secondary.length > 0 && (
            <DropdownMenu open={overflowOpen} onOpenChange={setOverflowOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("rail.more")}
                  className="relative flex w-full flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-sidebar-foreground/80 transition-colors hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground"
                >
                  <span className="flex h-5 w-5 items-center justify-center" aria-hidden>
                    <MoreHorizontal className="h-5 w-5" />
                  </span>
                  <span className="text-[10px] leading-none">{t("rail.more")}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="center" sideOffset={8} className="min-w-[160px]">
                {secondary.map((item) => (
                  <DropdownMenuItem
                    key={item.key}
                    className="gap-2 px-2.5 py-1.5 text-[13px]"
                    onSelect={() => (moduleHandlers[item.key] ?? (() => {}))()}
                  >
                    <span className="flex h-4 w-4 items-center justify-center [&_img]:h-4 [&_img]:w-4" aria-hidden>
                      {item.icon}
                    </span>
                    <span>{t(`rail.modules.${item.key}`, item.label)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="flex w-full shrink-0 flex-col items-center gap-0.5 px-2">
          {props.updateAvailable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("rail.updateAvailable")}
                  onClick={() => props.onStartUpdate?.()}
                  className="relative flex h-8 w-8 items-center justify-center rounded-lg text-blue-500 transition-colors hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)]"
                >
                  <Sparkles className="h-4 w-4 animate-pulse [animation-duration:2s]" />
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blue-500" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{t("rail.updateAvailable")}</TooltipContent>
            </Tooltip>
          )}
          {loggedIn ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={licenseInfo?.account ?? licenseInfo?.email ?? t("rail.account")}
                  className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sidebar-foreground/85 transition-colors hover:bg-[hsl(var(--sidebar-hover-surface)/0.08)]"
                >
                  <User className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="center" sideOffset={8} className="min-w-[200px]">
                <DropdownMenuLabel className="px-2.5 py-2 font-normal">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400">
                      <User className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold text-foreground">
                          {licenseInfo?.account ?? licenseInfo?.email ?? t("rail.account")}
                        </span>
                        {licenseActive && !serverTrial && (
                          <span className="shrink-0 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-1 py-px text-[8px] font-bold leading-tight text-white">
                            Pro
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="gap-2 px-2.5 py-1.5 text-[13px]"
                  onSelect={() => props.onOpenLogin?.()}
                >
                  <UserCog className="h-4 w-4" />
                  <span>{t("rail.manageAccount")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2 px-2.5 py-1.5 text-[13px]"
                  onSelect={() => props.onOpenSettings()}
                >
                  <Settings className="h-4 w-4" />
                  <span>{t("rail.settings")}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="gap-2 px-2.5 py-1.5 text-[13px] text-destructive focus:text-destructive"
                  onSelect={() => void logout()}
                >
                  <LogOut className="h-4 w-4" />
                  <span>{t("rail.logout")}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("rail.login")}
                  onClick={props.onOpenLogin ?? (() => {})}
                  className="mt-0.5 h-9 w-9 rounded-full text-sidebar-foreground/85 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)]"
                >
                  <LogIn className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t("rail.login")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </nav>
    </TooltipProvider>
  );
}
