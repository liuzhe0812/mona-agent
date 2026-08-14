import { useMemo, useState } from "react";
import { MessageSquarePlus, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentAvatar, MONA_AGENT_ID } from "@/components/room/AgentAvatar";
import { Button } from "@/components/ui/button";
import type { AgentSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 伙伴视图（阶段 4.5）：左侧已安装 Agent 列表列（Mona 固定第一），
 * 右侧伙伴详情主区（简介 + 开始私聊 / 创建房间操作）。
 * 布局与 SessionListPanel + 对话区同构，遵循企微三栏壳层。
 */
interface PartnersViewProps {
  agents: AgentSummary[];
  onStartDirect: (agentId: string) => void;
  onCreateRoom: (agentId: string) => void;
}

export function PartnersView({ agents, onStartDirect, onCreateRoom }: PartnersViewProps) {
  const { t } = useTranslation();
  const sorted = useMemo(() => {
    const enabled = agents.filter((a) => a.enabled);
    return [...enabled].sort((a, b) => {
      if (a.id === MONA_AGENT_ID) return -1;
      if (b.id === MONA_AGENT_ID) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [agents]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sorted.find((a) => a.id === selectedId) ?? sorted[0] ?? null;

  return (
    <>
      {/* 列表列 */}
      <section
        aria-label={t("rail.partners")}
        className="flex h-full w-[260px] shrink-0 flex-col overflow-hidden border-r border-border/45 bg-transparent"
      >
        <div className="flex items-center px-3 pb-1.5 pt-3">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-sidebar-foreground">
            {t("rail.partners")}
          </h2>
        </div>
        <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {sorted.length === 0 ? (
            <p className="px-2 py-8 text-center text-[13px] text-muted-foreground">
              {t("partners.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sorted.map((agent) => {
                const active = selected?.id === agent.id;
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => setSelectedId(agent.id)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
                        active
                          ? "bg-[hsl(var(--sidebar-active-surface)/0.07)]"
                          : "hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)]",
                      )}
                    >
                      <AgentAvatar
                        agentId={agent.id}
                        displayName={agent.displayName}
                        className="h-9 w-9"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-sidebar-foreground">
                          {agent.displayName}
                        </span>
                        {agent.description ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {agent.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* 详情主区 */}
      <section
        aria-label={t("partners.detailAria")}
        className="flex h-full min-w-0 flex-1 flex-col items-center justify-center overflow-y-auto bg-background px-8"
      >
        {selected ? (
          <div className="flex w-full max-w-md flex-col items-center text-center">
            <AgentAvatar
              agentId={selected.id}
              displayName={selected.displayName}
              className="h-20 w-20 text-2xl"
            />
            <h1 className="mt-4 truncate text-lg font-semibold text-foreground">
              {selected.displayName}
            </h1>
            <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">
              {selected.description || t("partners.noDescription")}
            </p>
            <div className="mt-6 flex items-center gap-2.5">
              <Button className="gap-2" onClick={() => onStartDirect(selected.id)}>
                <MessageSquarePlus className="h-4 w-4" />
                {t("partners.startDirect")}
              </Button>
              {selected.id !== MONA_AGENT_ID && (
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() => onCreateRoom(selected.id)}
                >
                  <UsersRound className="h-4 w-4" />
                  {t("partners.createRoom")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">{t("partners.empty")}</p>
        )}
      </section>
    </>
  );
}
