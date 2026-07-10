/** 用户画像可视化主视图：3 个 Tab 切换 + 蒸馏控制。 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  fetchProfile,
  triggerDistill,
  type DistillResult,
  type RichProfile,
} from "@/lib/profile-api";

import { ProfileTab } from "./ProfileTab";
import { ProfileStyles } from "./ProfileStyles";
import { TrajectoryTab } from "./TrajectoryTab";
import { WorkPatternTab } from "./WorkPatternTab";

function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return "尚未蒸馏";
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

export function ProfileView() {
  const [data, setData] = useState<RichProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [distilling, setDistilling] = useState(false);
  const [distillMsg, setDistillMsg] = useState<string | null>(null);
  const [tab, setTab] = useState("profile");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await fetchProfile();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDistill = useCallback(async () => {
    setDistilling(true);
    setDistillMsg(null);
    try {
      const result: DistillResult = await triggerDistill("all");
      if (result.results) {
        const successes = result.results.filter((r) => r.success).length;
        const total = result.results.length;
        setDistillMsg(`蒸馏完成：${successes}/${total} 项成功`);
      } else if (result.ok) {
        setDistillMsg(
          `蒸馏完成：${result.task ?? ""}${
            result.confidence != null ? ` · 置信度 ${(result.confidence * 100).toFixed(0)}%` : ""
          }`,
        );
      } else {
        setDistillMsg(`蒸馏失败：${result.error ?? "未知错误"}`);
      }
      // 重新拉取数据
      await load();
    } catch (e) {
      setDistillMsg(`蒸馏出错：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDistilling(false);
      window.setTimeout(() => setDistillMsg(null), 5000);
    }
  }, [load]);

  const lastDistilled = data?.last_distilled_at ?? null;

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full w-full flex-col bg-background">
      <ProfileStyles />
      {/* 顶部栏：Tab 居中 + 操作按钮两端对齐，单行紧凑布局 */}
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="whitespace-nowrap">
            {`上次蒸馏：${formatTimestamp(lastDistilled)}`}
          </span>
          {loading && <span className="whitespace-nowrap">加载中…</span>}
        </div>
        <div className="flex flex-1 justify-center">
          <TabsList className="h-7 p-0.5">
            <TabsTrigger value="profile" className="h-6 px-2.5 text-xs">人物画像</TabsTrigger>
            <TabsTrigger value="trajectory" className="h-6 px-2.5 text-xs">成长轨迹</TabsTrigger>
            <TabsTrigger value="work-pattern" className="h-6 px-2.5 text-xs">工作模式</TabsTrigger>
          </TabsList>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void load()}
            title="刷新"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={distilling}
            onClick={() => void handleDistill()}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {distilling ? "蒸馏中…" : "立即蒸馏"}
          </Button>
        </div>
      </div>

      {/* 蒸馏结果提示 */}
      {distillMsg && (
        <div className="border-b bg-blue-500/10 px-4 py-1.5 text-xs text-blue-700 dark:text-blue-300">
          {distillMsg}
        </div>
      )}

      {/* 错误提示 */}
      {error && !loading && (
        <div className="border-b bg-destructive/10 px-4 py-1.5 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 内容区域 */}
      <div className="min-h-0 flex-1 overflow-auto">
        <TabsContent value="profile" className="mt-0 h-full overflow-auto p-4">
          <ProfileTab
            data={data?.profile}
            loading={loading}
          />
        </TabsContent>
        <TabsContent value="trajectory" className="mt-0 h-full overflow-auto p-4">
          <TrajectoryTab
            data={data ?? undefined}
            loading={loading}
          />
        </TabsContent>
        <TabsContent value="work-pattern" className="mt-0 h-full overflow-auto p-4">
          <WorkPatternTab
            data={data ?? undefined}
            loading={loading}
          />
        </TabsContent>
      </div>
    </Tabs>
  );
}
