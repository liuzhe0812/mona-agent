import {
  BriefcaseBusiness,
  Code2,
  Gamepad2,
  Globe2,
  MessageCircle,
  Music2,
  Package,
  Palette,
  Search,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusNotice } from "@/components/ui/status-notice";
import { cn } from "@/lib/utils";

import { curatedApps, discoverSections, type StoreCategory } from "./appStoreCatalog";
import { useAppStore, type InstalledSoftware, type StoreApp } from "./useSystemData";

interface StoreSection {
  id: string;
  title: string;
  apps: StoreApp[];
}

const iconify = (name: string, color?: string) =>
  `https://api.iconify.design/${name.replace(":", "/")}.svg${color ? `?color=${encodeURIComponent(color)}` : ""}`;

const categories: { id: StoreCategory; label: string; icon: typeof Package }[] = [
  { id: "discover", label: "发现", icon: Package },
  { id: "browser", label: "浏览器", icon: Globe2 },
  { id: "office", label: "办公效率", icon: BriefcaseBusiness },
  { id: "social", label: "社交通讯", icon: MessageCircle },
  { id: "media", label: "影音娱乐", icon: Music2 },
  { id: "utilities", label: "实用工具", icon: Wrench },
  { id: "development", label: "开发工具", icon: Code2 },
  { id: "creative", label: "设计创作", icon: Palette },
  { id: "games", label: "游戏平台", icon: Gamepad2 },
];

const curatedById = new Map(curatedApps.map((app) => [app.id.toLocaleLowerCase(), app]));
const officialIconUrls = new Map([
  ["bytedance.feishu", "https://www.feishu.cn/favicon.ico"],
  ["bytedance.douyin", "https://www.douyin.com/favicon.ico"],
  ["kingsoft.wpsoffice.cn", "https://www.wps.cn/favicon.ico"],
  ["tencent.wecom", "https://work.weixin.qq.com/favicon.ico"],
  ["tencent.tencentmeeting", "https://meeting.tencent.com/favicon.ico"],
  ["tencent.qqmusic", "https://y.qq.com/favicon.ico"],
  ["liule.snipaste", "https://www.snipaste.com/favicon.ico"],
]);

const inferredIcons: { match: RegExp; icon: string }[] = [
  { match: /google\.chrome/i, icon: iconify("logos:chrome") },
  { match: /mozilla\.firefox/i, icon: iconify("logos:firefox") },
  { match: /microsoft\.edge/i, icon: iconify("logos:microsoft-edge") },
  { match: /python\.python/i, icon: iconify("logos:python") },
  { match: /openjs\.nodejs/i, icon: iconify("logos:nodejs-icon") },
  { match: /docker\.dockerdesktop/i, icon: iconify("logos:docker-icon") },
  { match: /obsproject\.obsstudio/i, icon: iconify("logos:obs") },
  { match: /telegram/i, icon: iconify("logos:telegram") },
  { match: /discord/i, icon: iconify("logos:discord-icon") },
  { match: /spotify/i, icon: iconify("logos:spotify-icon") },
  { match: /microsoft\.powershell/i, icon: iconify("logos:powershell") },
];

const ICON_CACHE_KEY = "system.appStoreIconCache.v1";
const onlineIconCache = new Map<string, string>();
const pendingIconRequests = new Map<string, Promise<string | undefined>>();
let iconCacheLoaded = false;

function loadIconCache() {
  if (iconCacheLoaded) return;
  iconCacheLoaded = true;
  try {
    const cached = JSON.parse(localStorage.getItem(ICON_CACHE_KEY) ?? "{}") as Record<string, string>;
    Object.entries(cached).forEach(([key, value]) => onlineIconCache.set(key, value));
  } catch {
    // 缓存损坏不影响图标在线解析。
  }
}

function saveIconCache() {
  try {
    const successful = [...onlineIconCache].filter((entry) => Boolean(entry[1])).slice(-300);
    localStorage.setItem(ICON_CACHE_KEY, JSON.stringify(Object.fromEntries(successful)));
  } catch {
    // 存储空间不足时继续使用内存缓存。
  }
}

function iconCacheKey(app: StoreApp) {
  return `${app.id}|${app.name}`.toLocaleLowerCase();
}

function chooseOnlineIcon(icons: unknown): string | undefined {
  if (!Array.isArray(icons)) return undefined;
  const priority = ["logos:", "thesvg-color:", "skill-icons:", "simple-icons:", "devicon:", "tdesign:", "arcticons:"];
  const valid = icons.filter((icon): icon is string => typeof icon === "string" && /^[a-z0-9-]+:[a-z0-9-]+$/i.test(icon));
  return valid.sort((left, right) => {
    const leftRank = priority.findIndex((prefix) => left.startsWith(prefix));
    const rightRank = priority.findIndex((prefix) => right.startsWith(prefix));
    return (leftRank < 0 ? priority.length : leftRank) - (rightRank < 0 ? priority.length : rightRank);
  })[0];
}

async function findOnlineIcon(app: StoreApp): Promise<string | undefined> {
  loadIconCache();
  const key = iconCacheKey(app);
  if (onlineIconCache.has(key)) return onlineIconCache.get(key) || undefined;
  const pending = pendingIconRequests.get(key);
  if (pending) return pending;

  const request = fetch(`https://api.iconify.design/search?query=${encodeURIComponent(app.name)}&limit=32`)
    .then(async (response) => {
      if (!response.ok) return undefined;
      const result = await response.json() as { icons?: unknown };
      const iconName = chooseOnlineIcon(result.icons);
      return iconName ? iconify(iconName) : undefined;
    })
    .catch(() => undefined)
    .then((url) => {
      onlineIconCache.set(key, url ?? "");
      saveIconCache();
      return url;
    })
    .finally(() => pendingIconRequests.delete(key));
  pendingIconRequests.set(key, request);
  return request;
}

function appMetadata(app: StoreApp) {
  return curatedById.get(app.id.toLocaleLowerCase());
}

function appIconUrl(app: StoreApp): string | undefined {
  const metadata = appMetadata(app);
  return metadata?.iconUrl
    ?? officialIconUrls.get(app.id.toLocaleLowerCase())
    ?? (metadata?.icon ? iconify(metadata.icon) : undefined)
    ?? inferredIcons.find((entry) => entry.match.test(app.id))?.icon;
}

function AppIcon({ app, large = false }: { app: StoreApp; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [triedOnlineFallback, setTriedOnlineFallback] = useState(false);
  const directIconUrl = appIconUrl(app);
  const [iconUrl, setIconUrl] = useState(directIconUrl);
  const size = large ? "h-16 w-16" : "h-12 w-12";

  useEffect(() => {
    let active = true;
    setFailed(false);
    setTriedOnlineFallback(false);
    setIconUrl(directIconUrl);
    if (!directIconUrl) {
      void findOnlineIcon(app).then((url) => {
        if (active) setIconUrl(url);
      });
    }
    return () => { active = false; };
  }, [app.id, app.name, directIconUrl]);

  const handleIconError = () => {
    if (triedOnlineFallback) {
      setFailed(true);
      return;
    }
    setTriedOnlineFallback(true);
    void findOnlineIcon(app).then((url) => {
      if (url && url !== iconUrl) setIconUrl(url);
      else setFailed(true);
    });
  };

  return (
    <div className={cn("grid shrink-0 place-items-center overflow-hidden rounded-lg bg-secondary", size)}>
      {iconUrl && !failed ? (
        <img
          src={iconUrl}
          alt={`${app.name} 图标`}
          className={cn("object-contain", large ? "h-12 w-12" : "h-9 w-9")}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={handleIconError}
        />
      ) : (
        <span className={cn("font-semibold text-foreground", large ? "text-title" : "text-body")} aria-hidden>
          {app.name.trim().slice(0, 1).toLocaleUpperCase()}
        </span>
      )}
    </div>
  );
}

function isInstalled(app: StoreApp, installed: InstalledSoftware[]) {
  const id = app.id.toLocaleLowerCase();
  const name = app.name.toLocaleLowerCase();
  return installed.some((item) => item.id.toLocaleLowerCase() === id || item.name.toLocaleLowerCase() === name);
}

export function AppStorePanel({
  installed,
  onInstalled,
  showDetails,
}: {
  installed: InstalledSoftware[];
  onInstalled: () => Promise<void>;
  showDetails: boolean;
}) {
  const store = useAppStore();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<StoreCategory>("discover");
  const [selected, setSelected] = useState<StoreApp>(curatedApps[0]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handle = window.setTimeout(() => void store.search(query), 350);
    return () => window.clearTimeout(handle);
  // search is stable for the lifetime of this hook instance; query is the trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const sections = useMemo<StoreSection[]>(() => {
    if (query.trim()) return [{ id: "search", title: `“${query.trim()}”的搜索结果`, apps: store.results }];
    if (category !== "discover") {
      return [{
        id: category,
        title: categories.find((item) => item.id === category)?.label ?? "应用",
        apps: curatedApps.filter((app) => app.category === category),
      }];
    }
    return discoverSections.map((section) => ({
      id: section.id,
      title: section.title,
      apps: curatedApps.filter((app) => app.section === section.id).slice(0, section.limit),
    }));
  }, [category, query, store.results]);

  const selectedMetadata = appMetadata(selected);
  const selectedInstalled = completedIds.has(selected.id) || isInstalled(selected, installed);
  const selectedInstalling = store.installingIds.has(selected.id);

  const install = async (app: StoreApp) => {
    const result = await store.install(app);
    if (result?.success) {
      setCompletedIds((current) => new Set(current).add(app.id));
      setSelected(app);
      await onInstalled();
    }
  };

  return (
    <div className={cn(
      "grid min-h-[620px] grid-cols-[140px_minmax(0,1fr)]",
      showDetails && "xl:grid-cols-[140px_minmax(0,1fr)_280px]",
    )}>
      <nav aria-label="应用分类" className="border-r border-border/70 py-4 pr-3">
        {categories.map((item) => {
          const Icon = item.icon;
          return (
            <Button
              key={item.id}
              type="button"
              variant="ghost"
              aria-current={category === item.id ? "page" : undefined}
              onClick={() => { setCategory(item.id); setQuery(""); }}
              className={cn(
                "mb-1 h-auto w-full justify-start gap-2.5 px-3 py-2 text-left text-caption",
                category === item.id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />{item.label}
            </Button>
          );
        })}
      </nav>

      <section className="min-w-0 px-4 py-4 xl:px-5">
        <div className="mb-4 flex items-center justify-end gap-3">
          {store.searching ? <span className="text-caption text-muted-foreground">正在搜索</span> : null}
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="搜索全部应用"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索全部应用"
              className="pl-9"
            />
          </div>
        </div>
        {store.searchError ? <StatusNotice tone="danger" className="mb-3">搜索失败：{store.searchError}</StatusNotice> : null}
        {store.installError ? <StatusNotice tone="danger" className="mb-3">安装失败：{store.installError}</StatusNotice> : null}

        <div className="space-y-6">
          {sections.map((section) => (
            <div key={section.id}>
              <h2 className="mb-3 text-body font-semibold">{section.title}</h2>
              <div className={cn(
                "grid gap-3 md:grid-cols-2 2xl:grid-cols-3",
              )}>
                {section.apps.map((app) => {
                  const installedApp = completedIds.has(app.id) || isInstalled(app, installed);
                  const installing = store.installingIds.has(app.id);
                  const metadata = appMetadata(app);
                  return (
                    <article
                      key={app.id}
                      className={cn(
                        "flex min-w-0 items-center gap-3 rounded-lg border border-border/70 bg-card p-3 transition-colors hover:bg-accent/50",
                        selected.id === app.id && "border-foreground/15 bg-secondary/45",
                      )}
                      onClick={() => setSelected(app)}
                    >
                      <AppIcon app={app} />
                      <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-start p-0 text-left hover:bg-transparent" onClick={() => setSelected(app)}>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-caption font-medium">{app.name}</span>
                          <span className="block truncate text-micro text-muted-foreground">{metadata?.description ?? app.id}</span>
                          {installing ? <span className="mt-1 block truncate text-micro text-muted-foreground">{store.installProgress[app.id] ?? "正在安装"}</span> : null}
                        </span>
                      </Button>
                      <Button
                        size="sm"
                        variant={installedApp ? "secondary" : "interaction"}
                        disabled={installedApp || installing}
                        onClick={(event) => { event.stopPropagation(); void install(app); }}
                        aria-label={`${installedApp ? "已安装" : installing ? "正在安装" : "获取"} ${app.name}`}
                      >
                        {installedApp ? "已安装" : installing ? "安装中" : "获取"}
                      </Button>
                    </article>
                  );
                })}
              </div>
              {!store.searching && section.apps.length === 0 ? (
                <p className="py-12 text-center text-caption text-muted-foreground">没有找到相关应用，请尝试其他名称</p>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <aside className={cn("hidden border-l border-border/70 px-5 py-5", showDetails && "xl:block")} aria-label="应用详情">
        <div className="flex justify-end">
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="关闭应用详情" onClick={() => setSelected(curatedApps[0])}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <AppIcon app={selected} large />
        <h3 className="mt-4 text-title-sm font-semibold">{selected.name}</h3>
        <p className="mt-1 text-caption text-muted-foreground">{selectedMetadata?.publisher ?? selected.id.split(".")[0]}</p>
        <Button className="mt-5 w-full" disabled={selectedInstalled || selectedInstalling} onClick={() => void install(selected)}>
          {selectedInstalled ? "已安装" : selectedInstalling ? "正在安装" : "获取"}
        </Button>
        {selectedInstalling ? <p className="mt-2 text-micro text-muted-foreground">{store.installProgress[selected.id] ?? "正在准备安装"}</p> : null}
        <p className="mt-5 text-caption leading-6">{selectedMetadata?.description ?? "由软件发布者提供的 Windows 应用。"}</p>
        <dl className="mt-6 space-y-3 text-caption">
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">来源</dt><dd>应用目录</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">应用标识</dt><dd className="max-w-[170px] truncate" title={selected.id}>{selected.id}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">版本</dt><dd>{selected.version || "安装时获取最新版"}</dd></div>
        </dl>
        <p className="mt-8 text-micro leading-5 text-muted-foreground">安装即表示你同意软件发布者提供的许可条款，部分功能可能需要付费。</p>
      </aside>
    </div>
  );
}
