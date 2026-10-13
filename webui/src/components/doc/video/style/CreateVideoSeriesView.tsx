import { useEffect, useState } from "react";
import { ArrowLeft, Check, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createVideoSeries,
  fetchVideoBrandKits,
  type VideoAspectVariant,
  type VideoBrandKit,
  type VideoSeries,
  type VideoStyleDraft,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";

const TEMPLATES = [
  {
    id: "minimal-business",
    name: "简洁浅色",
    description: "浅底色、稳重字体",
    preview: "/video-templates/minimal-business.png",
  },
  {
    id: "tech-dark",
    name: "专业深色",
    description: "深底色、清晰对比",
    preview: "/video-templates/tech-dark.png",
  },
  {
    id: "editorial-magazine",
    name: "编辑排版",
    description: "衬线正文、清晰层级",
    preview: "/video-templates/editorial-magazine.png",
  },
  {
    id: "knowledge-cards",
    name: "清晰教学",
    description: "适合步骤和知识讲解",
    preview: "/video-templates/knowledge-cards.png",
  },
  {
    id: "custom",
    name: "自定义",
    description: "自选颜色、字体和背景",
    preview: null,
  },
] as const;

interface CreateVideoSeriesViewProps {
  onCancel: () => void;
  onCreated: (series: VideoSeries, draft: VideoStyleDraft) => void;
}

export function CreateVideoSeriesView({
  onCancel,
  onCreated,
}: CreateVideoSeriesViewProps) {
  const { token } = useClient();
  const [name, setName] = useState("");
  const [aspect, setAspect] = useState<VideoAspectVariant>("16:9");
  const [templateId, setTemplateId] = useState("tech-dark");
  const [brandKits, setBrandKits] = useState<VideoBrandKit[]>([]);
  const [brandKitId, setBrandKitId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchVideoBrandKits(token)
      .then((result) => {
        if (!cancelled) {
          setBrandKits(
            (result.brandKits ?? []).filter((kit) => kit.latestVersion > 0),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setBrandKits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const brandKit = brandKits.find((kit) => kit.id === brandKitId);
      const result = await createVideoSeries(token, {
        name: name.trim(),
        baseTemplateId: templateId,
        defaultAspectRatio: aspect,
        ...(brandKit
          ? {
              brandKitId: brandKit.id,
              brandKitVersion: brandKit.latestVersion,
            }
          : {}),
      });
      if (!result.ok || !result.series || !result.draft) {
        throw new Error(result.error || "新建风格失败");
      }
      onCreated(result.series, result.draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <Button
        type="button"
        variant="ghost"
        className="mb-4 h-auto !justify-start gap-1 px-0 !text-caption text-muted-foreground hover:text-foreground"
        onClick={onCancel}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回新建视频
      </Button>
      <div className="mx-auto max-w-[820px]">
        <div className="text-center">
          <h1 className="text-title-sm font-semibold">新建风格</h1>
          <p className="mt-1 text-caption text-muted-foreground">
            设定常用画面样式，之后可以在创作时选用；新视频也可直接开始。
          </p>
        </div>

        <div className="mt-6 space-y-5">
          <section>
            <label className="mb-1.5 block text-ui font-medium">风格名称</label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：品牌宣传视频"
              autoFocus
            />
          </section>

          <section>
            <div className="mb-1.5 text-ui font-medium">常用画幅</div>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {(["16:9", "9:16", "1:1"] as VideoAspectVariant[]).map(
                (value) => (
                  <Button
                    key={value}
                    type="button"
                    variant="ghost"
                    className={cn(
                      "!text-caption",
                      aspect === value
                        ? "bg-card text-foreground"
                        : "text-muted-foreground",
                    )}
                    onClick={() => setAspect(value)}
                  >
                    {value === "16:9"
                      ? "横屏"
                      : value === "9:16"
                        ? "竖屏"
                        : "方形"}
                  </Button>
                ),
              )}
            </div>
          </section>

          <section>
            <div className="mb-1.5 text-ui font-medium">选择一个起始风格</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {TEMPLATES.map((template) => {
                const selected = template.id === templateId;
                return (
                  <Button
                    key={template.id}
                    type="button"
                    variant="ghost"
                    aria-pressed={selected}
                    className={cn(
                      "relative h-auto min-h-32 flex-col items-stretch gap-2 overflow-hidden rounded-lg border p-2 text-left !text-caption transition-colors",
                      selected
                        ? "border-foreground bg-accent"
                        : "border-border/70 hover:bg-accent/60",
                    )}
                    onClick={() => setTemplateId(template.id)}
                  >
                    {selected ? (
                      <Check className="absolute right-2 top-2 h-3.5 w-3.5" />
                    ) : null}
                    {template.preview ? (
                      <img
                        src={template.preview}
                        alt={`${template.name}效果预览`}
                        className="aspect-video w-full rounded-md border border-black/10 object-cover"
                      />
                    ) : (
                      <div className="flex aspect-video w-full items-center justify-center rounded-md border border-border/70 bg-muted/30 text-micro text-muted-foreground">
                        自行调整颜色和背景
                      </div>
                    )}
                    <span className="px-1">
                      <span className="block font-medium">{template.name}</span>
                      <span className="mt-0.5 block text-micro text-muted-foreground">
                        {template.description}
                      </span>
                    </span>
                  </Button>
                );
              })}
            </div>
          </section>

          {brandKits.length > 0 ? (
            <details className="rounded-md border border-border/70 px-3 py-2">
              <summary className="cursor-pointer text-ui font-medium">
                标识与配色（可选）
              </summary>
              <div className="mt-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={brandKitId === null}
                    className={cn(
                      "h-auto min-h-16 items-start justify-start rounded-lg border p-3 text-left",
                      brandKitId === null
                        ? "border-foreground bg-accent"
                        : "border-border/70",
                    )}
                    onClick={() => setBrandKitId(null)}
                  >
                    <span>
                      <span className="block text-caption font-medium">
                        暂不使用
                      </span>
                      <span className="mt-1 block text-micro text-muted-foreground">
                        先使用所选风格，之后仍可添加
                      </span>
                    </span>
                  </Button>
                  {brandKits.map((kit) => {
                    const selected = brandKitId === kit.id;
                    return (
                      <Button
                        key={kit.id}
                        type="button"
                        variant="ghost"
                        aria-pressed={selected}
                        className={cn(
                          "h-auto min-h-16 items-start justify-start gap-2 rounded-lg border p-3 text-left",
                          selected
                            ? "border-foreground bg-accent"
                            : "border-border/70",
                        )}
                        onClick={() => setBrandKitId(kit.id)}
                      >
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="min-w-0">
                          <span className="block truncate text-caption font-medium">
                            {kit.name}
                          </span>
                          <span className="mt-1 block text-micro text-muted-foreground">
                            使用已保存的颜色和图片
                          </span>
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            </details>
          ) : null}

          {error ? (
            <div className="text-caption text-destructive">{error}</div>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button
              type="button"
              disabled={!name.trim() || creating}
              onClick={() => void handleCreate()}
            >
              {creating ? "创建中…" : "继续编辑风格"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
