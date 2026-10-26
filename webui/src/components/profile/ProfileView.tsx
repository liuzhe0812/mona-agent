import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageToolbar } from "@/components/ui/page-toolbar";
import { PageHeader } from "@/components/ui/page-header";
import { StatusNotice } from "@/components/ui/status-notice";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  fetchProfile,
  triggerDistill,
  type DistillResult,
  type ProfileArtifact,
  type ProfileStartRequest,
  type RichProfile,
} from "@/lib/profile-api";

import { ProfileTab } from "./ProfileTab";
import { TrajectoryTab } from "./TrajectoryTab";
import { WorkPatternTab } from "./WorkPatternTab";
import "./profile-view.css";

export interface ProfileViewProps {
  /** 兼容旧版画像入口；新建议优先使用 onStartAdvice。 */
  onAskMona?: (prompt: string) => void;
  onStartAdvice?: (request: ProfileStartRequest) => void;
  onOpenSession?: (key: string) => void;
  onOpenArtifact?: (artifact: ProfileArtifact) => void;
}

export function ProfileView({ onAskMona, onStartAdvice, onOpenSession, onOpenArtifact }: ProfileViewProps) {
  const [data, setData] = useState<RichProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateTone, setUpdateTone] = useState<"info" | "success" | "warning" | "danger">("info");
  const [tab, setTab] = useState("profile");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchProfile());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDistill = useCallback(async () => {
    setUpdating(true);
    setUpdateMessage(null);
    try {
      const result: DistillResult = await triggerDistill("all");
      const failed = result.results?.filter((item) => !item.success) ?? [];
      if (!result.ok && failed.length === 0) {
        setUpdateTone("danger");
        setUpdateMessage(`更新失败：${result.error ?? "画像服务暂不可用"}`);
      } else if (failed.length > 0) {
        const stageLabels: Record<string, string> = { dashboard: "数据汇总", "work-pattern": "协作模式", profile: "画像理解", advice: "AI 建议" };
        const failedLabels = failed.map((item) => stageLabels[item.task] ?? item.task).join("、");
        setUpdateTone("warning");
        setUpdateMessage(`部分内容已更新；${failedLabels}未完成，可稍后重试。`);
      } else if (result.status === "empty") {
        setUpdateTone("info");
        setUpdateMessage("更新完成；近期记录不足，暂未生成新内容。");
      } else {
        setUpdateTone("success");
        setUpdateMessage("画像更新完成。");
      }
      await load();
    } catch (cause) {
      setUpdateTone("danger");
      setUpdateMessage(`更新失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setUpdating(false);
    }
  }, [load]);

  return (
    <Tabs value={tab} onValueChange={setTab} className="profile-view flex h-full w-full flex-col bg-background text-foreground">
      <PageToolbar
        className="h-auto min-h-14 shrink-0 flex-wrap border-b border-border/60 px-4 py-2 sm:flex-nowrap lg:px-5"
        leading={
          <div className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
            <PageHeader title="用户画像" className="shrink-0 whitespace-nowrap font-semibold" />
            {tab !== "work-pattern" ? <><span aria-hidden>·</span><span className="whitespace-nowrap">近 30 天</span></> : null}
            {loading ? <span className="whitespace-nowrap">加载中…</span> : null}
          </div>
        }
        actions={
          <>
            <Button type="button" variant="ghost" size="icon" onClick={() => void load()} title="刷新画像"><RefreshCw className="h-4 w-4" /></Button>
            <Button type="button" size="sm" className="gap-1.5 px-3" disabled={updating} onClick={() => void handleDistill()}>
              <Sparkles className="h-3.5 w-3.5" />{updating ? "更新中…" : "更新画像"}
            </Button>
          </>
        }
      >
        <TabsList className="h-9 rounded-none bg-transparent p-0 text-muted-foreground">
          <TabsTrigger value="profile" className={TAB_CLASS}>我的画像</TabsTrigger>
          <TabsTrigger value="trajectory" className={TAB_CLASS}>变化轨迹</TabsTrigger>
          <TabsTrigger value="work-pattern" className={TAB_CLASS}>AI 建议</TabsTrigger>
        </TabsList>
      </PageToolbar>

      {updateMessage ? <div className="border-b px-3 py-1.5"><StatusNotice tone={updateTone} className="items-center rounded-md px-3 py-1.5 text-caption">{updateMessage}</StatusNotice></div> : null}
      {error && !loading ? <div className="border-b px-3 py-1.5"><StatusNotice tone="danger" className="items-center rounded-md px-3 py-1.5">{error}</StatusNotice></div> : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <TabsContent value="profile" className="mt-0 h-full overflow-auto p-3 lg:p-4">
          <ProfileTab profile={data ?? undefined} loading={loading} onOpenArtifact={onOpenArtifact} />
        </TabsContent>
        <TabsContent value="work-pattern" className="mt-0 h-full min-h-0 overflow-hidden p-3 lg:p-4">
          <WorkPatternTab data={data ?? undefined} loading={loading} onAskMona={onAskMona} onStartAdvice={onStartAdvice} onOpenSession={onOpenSession} />
        </TabsContent>
        <TabsContent value="trajectory" className="mt-0 h-full overflow-auto p-3 lg:p-4">
          <TrajectoryTab data={data ?? undefined} loading={loading} />
        </TabsContent>
      </div>
    </Tabs>
  );
}

const TAB_CLASS = "relative h-9 rounded-none !bg-transparent px-3 text-caption text-muted-foreground shadow-none transition-colors hover:!bg-transparent hover:text-foreground data-[state=active]:!bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:!shadow-none data-[state=active]:after:absolute data-[state=active]:after:inset-x-3 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-[hsl(var(--brand-red))]";
