import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError, createVideoProject, createVideoSeries, createVideoStyleDraftFromVersion, deleteVideoSeries, fetchVideoProject, fetchVideoStyleDraft, fetchVideoSeriesDetail, getServicesHttpBase,
  importVideoProjectAsset, lockVideoStyle, saveVideoChatId, saveVideoStyleDraft, updateVideoProjectSettings, updateVideoSeries,
  type VideoAspectVariant, type VideoStyleDraft, type VideoStyleTemplate, type VideoStyleVersion, type VideoTtsConfig,
} from "@/lib/api";
import { bindVideoStyleSample, fetchVideoStyleReference, fetchVideoStyleSample } from "@/lib/video-style-api";
import { isTauri } from "@/lib/tauri";
import { encodeImage } from "@/lib/imageEncode";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { useClient } from "@/providers/ClientProvider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { DocChatPanel } from "../../DocChatPanel";
import { CustomVideoStyleEditor } from "./CustomVideoStyleEditor";
import type { AgentModelBinding } from "@/lib/types";
import { RoomCommandError } from "@/lib/mona-client";
import { useVideoModelBinding } from "../useVideoModelBinding";
import { VideoModelControl } from "../VideoModelControl";

export interface StyleConversationState { chatId: string | null; visible: boolean; ready: boolean }

interface Props {
  initialSeriesId?: string | null;
  baseStyle?: VideoStyleTemplate;
  aspectRatio: VideoAspectVariant;
  topic?: string;
  tts?: VideoTtsConfig;
  visible?: boolean;
  useOnSave?: boolean;
  conversationRequest?: number;
  uploadChatId?: string | null;
  initialModelBinding?: AgentModelBinding | null;
  onBack: () => void;
  onSaved: (version: VideoStyleVersion) => void;
  onConversationChange?: (state: StyleConversationState | null) => void;
}

async function readReferenceFiles(paths: string[]): Promise<File[]> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  return Promise.all(paths.map(async (path) => {
    const name = path.split(/[\\/]/).pop() || "参考图.png";
    const ext = name.split(".").pop()?.toLowerCase();
    return new File([await readFile(path)], name, { type: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png" });
  }));
}

type VisualEdit = { primaryColor?: string; backgroundColor?: string; fontFamily?: string };
function applyVisualEdit(draft: VideoStyleDraft, patch: VisualEdit | null): VideoStyleDraft {
  if (!patch) return draft;
  return { ...draft, tokens: { ...draft.tokens,
    colors: { ...draft.tokens?.colors, ...(patch.primaryColor ? { primary: patch.primaryColor } : {}), ...(patch.backgroundColor ? { background: patch.backgroundColor } : {}) },
    typography: { ...draft.tokens?.typography, ...(patch.fontFamily ? { headingFamily: patch.fontFamily, bodyFamily: patch.fontFamily } : {}) },
  } };
}

export function VideoStyleWorkspace({ initialSeriesId, baseStyle, aspectRatio, topic, tts, visible = true, useOnSave = true, conversationRequest, uploadChatId, initialModelBinding = null, onBack, onSaved, onConversationChange }: Props) {
  const { client, token } = useClient();
  const workspacePath = useWorkspaceStore((state) => state.workspacePath);
  const [draft, setDraft] = useState<VideoStyleDraft | null>(null);
  const draftRef = useRef(draft);
  const creationId = useRef(`style-${crypto.randomUUID().replace(/-/g, "")}`);
  const [name, setName] = useState("未命名风格");
  const [description, setDescription] = useState("");
  const [referencePaths, setReferencePaths] = useState<string[]>([]);
  const [referencePreviews, setReferencePreviews] = useState<Record<string, string>>({});
  const [storedReferencePreviews, setStoredReferencePreviews] = useState<Record<string, string>>({});
  const [basePoster, setBasePoster] = useState<string>();
  const referenceInput = useRef<HTMLInputElement>(null);
  const [aspect, setAspect] = useState(aspectRatio);
  const requestedAspect = useRef<VideoAspectVariant | null>(null);
  const [sample, setSample] = useState<{ html: string; duration: number }>();
  const [sampleCurrent, setSampleCurrent] = useState(false);
  const [savedRevision, setSavedRevision] = useState<number>();
  const [editableFields, setEditableFields] = useState<Array<"primaryColor" | "backgroundColor" | "fontFamily">>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const styleModel = useVideoModelBinding(chatId, initialModelBinding);
  const [running, setRunning] = useState(false);
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [missingStyle, setMissingStyle] = useState(false);
  const [retryAction, setRetryAction] = useState<(() => Promise<void>) | null>(null);
  const [chatVisible, setChatVisible] = useState(false);
  const [readyChat, setReadyChat] = useState<string | null>(null);
  const [history, setHistory] = useState<VideoStyleVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const latestSavedVersion = useRef(0);
  const previewKey = useRef("");
  const importedReferences = useRef(new Set<string>());
  const dirty = useRef(false);
  const pendingVisual = useRef<VisualEdit | null>(null);
  const persisting = useRef<Promise<VideoStyleDraft> | null>(null);
  const latest = useRef({ name, description, referencePaths, modelBinding: styleModel.binding });
  latest.current = { name, description, referencePaths, modelBinding: styleModel.binding };
  const conversationCallback = useRef(onConversationChange);
  conversationCallback.current = onConversationChange;

  const acceptDraft = useCallback((value: VideoStyleDraft) => {
    const merged = applyVisualEdit(value, pendingVisual.current);
    draftRef.current = merged;
    setDraft(merged);
  }, []);

  useEffect(() => {
    let active = true;
    if (baseStyle?.preview?.poster) void getServicesHttpBase().then((base) => { if (active) setBasePoster(`${base}${baseStyle.preview!.poster}`); }).catch(() => {});
    return () => { active = false; };
  }, [baseStyle?.preview?.poster]);

  const storedReferencePaths = JSON.stringify(draft?.authoring?.referencePaths ?? []);
  useEffect(() => {
    const abort = new AbortController();
    const urls: string[] = [];
    setStoredReferencePreviews({});
    const paths = JSON.parse(storedReferencePaths) as string[];
    if (draft?.seriesId) void Promise.all(paths.map(async (path, index) => {
      try {
        const blob = await fetchVideoStyleReference(token, draft.seriesId, index, abort.signal);
        if (abort.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        setStoredReferencePreviews((current) => ({ ...current, [path]: url }));
      } catch { /* The file name remains available when its thumbnail cannot be read. */ }
    }));
    return () => { abort.abort(); urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [draft?.seriesId, storedReferencePaths, token]);

  useEffect(() => {
    let active = true;
    if (initialSeriesId) {
      setWorking(true);
      setStatus("正在读取风格…");
      void Promise.all([fetchVideoStyleDraft(token, initialSeriesId), fetchVideoSeriesDetail(token, initialSeriesId)]).then(async ([value, record]) => {
        if (!active) return;
        acceptDraft(value);
        setName(record.name || value.name || "未命名风格");
        setDescription(value.authoring?.description || `保留${record.name || value.name || "原风格"}的视觉特点，制作清楚的讲解动画。`);
        styleModel.setBinding(value.authoring?.modelBinding ?? initialModelBinding);
        setHistory(record.styles ?? []);
        latestSavedVersion.current = record.latestStyleVersion ?? 0;
        const references = value.authoring?.referencePaths;
        if (Array.isArray(references)) setReferencePaths(references.filter((p): p is string => typeof p === "string"));
        if (value.authoring?.rules && !value.authoring.projectName && record.latestStyleVersion) {
          const resumed = await setupSample(value, record.latestStyleVersion);
          if (active) acceptDraft(resumed.draft);
        }
      }).catch((failure) => { if (active) {
        setMissingStyle(failure instanceof ApiError && failure.status === 404);
        setError(failure instanceof ApiError && failure.status === 404 ? "这套风格已删除，请返回风格列表。" : "风格暂时无法读取，请返回后重试。");
      } })
        .finally(() => { if (active) setWorking(false); });
    }
    return () => { active = false; };
  }, [acceptDraft, initialSeriesId, token]);

  async function setupSample(current: VideoStyleDraft, seedVersion?: number) {
    const projectName = current.authoring?.projectName || `风格样片-${current.seriesId}`;
    let project;
    try { project = await fetchVideoProject(token, projectName); }
    catch (failure) {
      if (!(failure instanceof ApiError) || failure.status !== 404) throw failure;
      await createVideoProject(token, projectName, aspect === "9:16" ? "1080x1920" : aspect === "1:1" ? "1080x1080" : "1920x1080", {
        templateId: baseStyle?.id ?? (current.baseTemplateId === "custom" ? "huashu-keynote" : current.baseTemplateId) ?? "huashu-keynote", narrationEnabled: true, ...tts,
      });
      project = await fetchVideoProject(token, projectName);
    }
    const boundChat = project.chatId || await client.newChat(45000, false, null, "video", current.authoring?.modelBinding ?? styleModel.binding);
    if (!project.chatId) await saveVideoChatId(token, projectName, boundChat);
    setChatId(boundChat);
    for (const path of referencePaths) {
      if (importedReferences.current.has(path)) continue;
      await importVideoProjectAsset(token, projectName, path, { sourceType: "user-upload", rightsStatus: "unknown" });
      importedReferences.current.add(path);
    }
    const bound = await bindVideoStyleSample(token, current.seriesId, projectName, current.revision, current.authoring?.description ?? description, Boolean(seedVersion), seedVersion);
    return { draft: bound.draft, projectName, boundChat };
  }

  useEffect(() => {
    conversationCallback.current?.({ chatId, visible: visible && chatVisible, ready: readyChat === chatId && Boolean(chatId) });
  }, [chatId, chatVisible, readyChat, visible]);
  useEffect(() => () => conversationCallback.current?.(null), []);

  useEffect(() => {
    if (!chatId) return;
    if (client.getRunStartedAt(chatId) !== null) setRunning(true);
    const offStatus = client.onRunStatus((id, startedAt) => {
      if (id === chatId) { setRunning(startedAt !== null); if (startedAt === null) setStatus(""); }
    });
    const offChat = client.onChat(chatId, (event) => {
      if (event.event === "error") { setRunning(false); setError("样片制作未完成，已保留当前内容，可以重试。"); }
      if (event.event === "turn_end") { setRunning(false); setStatus(""); previewKey.current = ""; }
      if (event.event === "file_edit") setStatus("正在制作动画样片…");
      if (event.event === "message") {
        const action = [...(event.tool_events ?? [])].reverse().find((tool) => tool.name === "video")?.arguments as { action?: string } | undefined;
        if (action?.action === "audio") setStatus("正在准备样片声音…");
        if (action?.action === "preview") setStatus("正在检查动画效果…");
        if (action?.action === "style_rules") setStatus("正在整理风格…");
      }
    });
    return () => { offStatus(); offChat(); };
  }, [chatId, client]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = draftRef.current;
    const projectName = current?.authoring?.projectName;
    if (!current || !projectName) return;
    const [updated, project] = await Promise.all([fetchVideoStyleDraft(token, current.seriesId), fetchVideoProject(token, projectName)]);
    if (signal?.aborted) return;
    if (!dirty.current) acceptDraft(updated);
    if (project.chatId) setChatId(project.chatId);
    const meta = project.meta as { scenes?: { sourceHash?: string; motionReviewSourceHash?: string }[]; resolution?: string };
    const actualAspect = ({ "1920x1080": "16:9", "1080x1920": "9:16", "1080x1080": "1:1" } as const)[meta?.resolution as "1920x1080" | "1080x1920" | "1080x1080"];
    if (actualAspect && (!requestedAspect.current || requestedAspect.current === actualAspect)) {
      setAspect(actualAspect);
      requestedAspect.current = null;
    }
    const scenes = meta?.scenes ?? [];
    const ready = scenes.length > 0 && scenes.every((scene) => scene.sourceHash && scene.sourceHash === scene.motionReviewSourceHash);
    if (!ready) { setSampleCurrent(false); return; }
    const key = JSON.stringify([updated.revision, scenes.map((scene) => scene.sourceHash), meta.resolution]);
    if (previewKey.current === key) return;
    const result = await fetchVideoStyleSample(token, current.seriesId, { signal });
    if (signal?.aborted) return;
    setSavedRevision(undefined);
    previewKey.current = key;
    setSample({ html: result.html, duration: result.duration });
    setEditableFields(result.editableFields ?? []);
    setSampleCurrent(!dirty.current);
  }, [acceptDraft, token]);

  useEffect(() => {
    if (!draft?.authoring?.projectName) return;
    const controller = new AbortController();
    let refreshing = false;
    const tick = async () => {
      if (refreshing) return;
      refreshing = true;
      try { await refresh(controller.signal); }
      catch (failure) {
        if (!controller.signal.aborted && failure instanceof ApiError && failure.status >= 500) setStatus("样片暂时无法读取，可稍后重试。");
      } finally { refreshing = false; }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [draft?.authoring?.projectName, refresh]);

  const persist = useCallback(() => {
    const task = (persisting.current ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const values = latest.current;
    let current = draftRef.current;
    if (!current && initialSeriesId) {
      current = await fetchVideoStyleDraft(token, initialSeriesId);
      acceptDraft(current);
    }
    if (!current) {
      const options = {
        id: creationId.current,
        name: values.name === "未命名风格" ? values.description.trim().slice(0, 12) || baseStyle?.name || "我的风格" : values.name.trim() || "我的风格",
        baseTemplateId: baseStyle?.id ?? "custom", defaultAspectRatio: aspect,
      };
      let created;
      try { created = await createVideoSeries(token, options); }
      catch (failure) {
        try { created = { draft: await fetchVideoStyleDraft(token, creationId.current), series: { name: options.name } }; }
        catch { throw failure; }
      }
      if (!created.draft) throw new Error("风格尚未创建，请重试。");
      current = { ...created.draft, name: created.series?.name || values.name };
      setName(current.name || "我的风格");
      acceptDraft(current);
    }
    const targetName = values.name === "未命名风格" ? current.name : values.name.trim() || "我的风格";
    const patch = pendingVisual.current;
    const fresh = await fetchVideoStyleDraft(token, current.seriesId);
    const changed = applyVisualEdit(fresh, patch);
    const saved = await saveVideoStyleDraft(token, current.seriesId, {
      revision: fresh.revision, name: targetName,
      ...(patch ? { tokens: changed.tokens } : {}),
      authoring: { description: values.description, referencePaths: values.referencePaths, modelBinding: values.modelBinding },
      aspectVariants: { "16:9": { enabled: true }, "9:16": { enabled: true }, "1:1": { enabled: true } },
    });
    if (!saved.draft) throw new Error("草稿未能保留，请重试。");
    if (saved.draft.name) await updateVideoSeries(token, saved.draft.seriesId, { name: saved.draft.name });
    if (pendingVisual.current === patch) pendingVisual.current = null;
    acceptDraft(saved.draft);
    const currentValues = { ...latest.current, name: latest.current.name === "未命名风格" ? targetName : latest.current.name };
    dirty.current = JSON.stringify({ ...values, name: targetName }) !== JSON.stringify(currentValues) || pendingVisual.current !== null;
    return saved.draft;
    });
    persisting.current = task;
    return task;
  }, [acceptDraft, aspect, baseStyle?.id, baseStyle?.name, initialSeriesId, token]);

  useEffect(() => {
    if (!dirty.current || running || working || saving) return;
    const timer = setTimeout(() => { void persist().catch(() => setError("草稿未能保留，请重试。")); }, 700);
    return () => clearTimeout(timer);
  }, [name, description, referencePaths, styleModel.binding, persist, running, working, saving]);

  const generate = async () => {
    if (working || running || styleModel.loading || styleModel.saving || styleModel.error) return;
    if (missingStyle) { setError("这套风格已删除，请返回后选择或创建风格。"); return; }
    setWorking(true); setStatus("正在准备样片…"); setError(null); setRetryAction(null); setSampleCurrent(false);
    try {
      let current = await persist();
      const prepared = await setupSample(current);
      const { projectName, boundChat } = prepared;
      current = prepared.draft;
      acceptDraft(current);
      previewKey.current = "";
      setRunning(true); setStatus("正在制作样片…");
      client.sendMessage(boundChat,
        `为已存在的项目「${projectName}」制作或继续修改自定义风格样片。先inspect当前结果，保留可复用的已完成工作。用户要求：${description || `以${baseStyle?.name ?? current.name}为起点制作风格`}。参考图片已导入该项目，仅作为画法依据，不自动嵌入样片。演示内容：${topic || "用一个具体事物和它的变化解释一个简单概念"}。制作约12秒有声动画，按实际口播时间安排；只做这个短样片。用style_rules保存画法、材质、文字和动画规律及匹配的tokens；使用--mona-primary、--mona-bg、--mona-heading-family、--mona-body-family使界面设置真实生效。创建短方案后依据inspect中的样片授权继续配音、使用内置Huashu模板与资源制作连贯HTML动画和完整preview，查看真实画面再修正；不要只做文字幻灯片。不要导出，也不要要求第二次导演确认。`,
        undefined, { agentKind: "video", displayContent: description || `以${baseStyle?.name ?? current.name}创建风格` });
    } catch (failure) { setRunning(false); setError(failure instanceof ApiError || failure instanceof RoomCommandError ? failure.message : "样片未能准备好，已保留现有内容，请重试。"); setRetryAction(() => generate); }
    finally { setWorking(false); }
  };

  const back = async () => {
    if (working || saving) return;
    if (missingStyle) { onBack(); return; }
    setWorking(true);
    setStatus("正在保留草稿…");
    try { if (dirty.current && (draftRef.current || description.trim() || referencePaths.length)) await persist(); onBack(); }
    catch { setError("草稿未能保留，请重试后再返回。"); setRetryAction(() => back); }
    finally { setWorking(false); }
  };

  const save = async () => {
    if (!draftRef.current || !sampleCurrent || running || working) return;
    setSaving(true);
    try {
      const current = dirty.current ? await persist() : draftRef.current;
      const saved = await lockVideoStyle(token, current.seriesId, current);
      if (!saved.version) throw new Error("保存未完成");
      latestSavedVersion.current = saved.version.version;
      if (useOnSave) onSaved(saved.version);
      else { setHistory((versions) => [saved.version!, ...versions.filter((v) => v.version !== saved.version!.version)]); setSavedRevision(current.revision); }
    } catch (failure) { setError(failure instanceof ApiError ? failure.message : "风格未能保存，已保留样片，请重试。"); setRetryAction(() => save); }
    finally { setSaving(false); }
  };

  const changeStyle = async (patch: VisualEdit) => {
    const current = draftRef.current;
    if (!current || running || working) return;
    pendingVisual.current = { ...pendingVisual.current, ...patch };
    acceptDraft(current); dirty.current = true; setSampleCurrent(false);
    setWorking(true);
    setStatus("正在更新样片…");
    try {
      let saved = await persist();
      if (saved.authoring?.projectName) {
        saved = (await bindVideoStyleSample(token, saved.seriesId, saved.authoring.projectName, saved.revision, description, true)).draft;
        acceptDraft(saved);
        previewKey.current = "";
        await refresh();
      }
    } catch { setError("样式未能更新，已保留修改，请重试。"); setRetryAction(() => () => changeStyle(patch)); }
    finally { setWorking(false); }
  };

  const uploadReferences = async (files: File[]) => {
    if (working || running || !files.length) return;
    if (!workspacePath) { setError("工作区正在准备，请稍后重试添加参考图。"); return; }
    setWorking(true);
    setStatus("正在添加参考图…");
    try {
      const encoded = await Promise.all(files.slice(0, Math.max(0, 6 - referencePaths.length)).map(async (file) => {
        const result = await encodeImage(file);
        if (!result.ok) throw new Error("图片未能读取，请使用 PNG、JPEG 或 WebP 图片。");
        return { name: file.name, data_url: result.dataUrl };
      }));
      if (!encoded.length) throw new Error("最多添加六张参考图片。");
      const owner = chatId || uploadChatId || client.defaultChatId || await client.newChat(5000, false, null, "video");
      const uploaded = await new Promise<Array<{ name: string; path: string }>>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error("参考图上传超时，请重试。")); }, 30000);
        const off = client.onDocUploadResult((result) => {
          if (result.chatId && result.chatId !== owner) return;
          clearTimeout(timer); off();
          if (result.ok && result.files?.length) resolve(result.files);
          else reject(new Error("参考图未能上传，请重试。"));
        });
        client.sendDocUpload(owner, encoded);
      });
      const previews: Record<string, string> = {};
      const paths = uploaded.map((file) => {
        const path = `${workspacePath.replace(/\\/g, "/").replace(/\/+$/, "")}/${file.path}`;
        const source = encoded.find((item) => item.name === file.name);
        if (source) previews[path] = source.data_url;
        return path;
      });
      setReferencePreviews((current) => ({ ...current, ...previews }));
      setReferencePaths((current) => [...new Set([...current, ...paths])]);
      dirty.current = true; setSampleCurrent(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "参考图未能添加，请重试。"); }
    finally { setWorking(false); }
  };

  const addReference = async () => {
    if (!isTauri()) { referenceInput.current?.click(); return; }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await uploadReferences(await readReferenceFiles(paths));
    } catch { setError("参考图未能读取，请重试。"); }
  };

  const uploadRef = useRef(uploadReferences);
  uploadRef.current = uploadReferences;
  useEffect(() => {
    if (!visible || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      unlisten = await getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type !== "drop") return;
        const images = payload.paths.filter((path) => /\.(png|jpe?g|webp)$/i.test(path));
        if (!images.length) return;
        void readReferenceFiles(images).then((files) => uploadRef.current(files)).catch(() => setError("参考图未能读取，请重试。"));
      });
      if (disposed) unlisten();
    }).catch(() => setError("图片拖入暂时不可用，请使用添加参考图。"));
    return () => { disposed = true; unlisten?.(); };
  }, [visible]);

  const changeAspect = async (value: VideoAspectVariant) => {
    requestedAspect.current = value;
    setAspect(value);
    const projectName = draftRef.current?.authoring?.projectName;
    if (!projectName) return;
    setSampleCurrent(false); setWorking(true); setStatus("正在调整画幅…");
    try { await updateVideoProjectSettings(token, projectName, { resolution: value === "9:16" ? "1080x1920" : value === "1:1" ? "1080x1080" : "1920x1080" }); const current = draftRef.current!; acceptDraft((await bindVideoStyleSample(token, current.seriesId, projectName, current.revision, description, true)).draft); previewKey.current = ""; await refresh(); }
    catch { requestedAspect.current = null; setError("画幅预览未能更新，已保留当前内容，请重试。"); setRetryAction(() => () => changeAspect(value)); }
    finally { setWorking(false); }
  };

  const restoreVersion = async (version: number) => {
    const current = draftRef.current;
    if (!current || running || working) return;
    setWorking(true); setStatus("正在恢复样片…"); setHistoryOpen(false); setSampleCurrent(false);
    try {
      const result = await createVideoStyleDraftFromVersion(token, current.seriesId, version);
      if (!result.draft) throw new Error("版本未读取");
      const resumed = await setupSample(result.draft, version);
      acceptDraft(resumed.draft); setDescription(resumed.draft.authoring?.description ?? "");
      setReferencePaths((resumed.draft.authoring?.referencePaths as string[] | undefined) ?? []);
      previewKey.current = "";
      await refresh();
    } catch { setError("历史版本未能恢复，已保留当前内容，请重试。"); setRetryAction(() => () => restoreVersion(version)); }
    finally { setWorking(false); }
  };

  const discard = async () => {
    const current = draftRef.current;
    if (!current || working || running || saving) return;
    setDiscardOpen(false); setWorking(true); setStatus("正在放弃草稿…");
    try {
      if (latestSavedVersion.current) {
        const restored = await createVideoStyleDraftFromVersion(token, current.seriesId, latestSavedVersion.current);
        if (!restored.draft) throw new Error("未能恢复");
        await setupSample(restored.draft, latestSavedVersion.current);
      } else await deleteVideoSeries(token, current.seriesId);
      dirty.current = false;
      onBack();
    } catch { setError("草稿未能放弃，已保留当前内容，请重试。"); setRetryAction(() => discard); }
    finally { setWorking(false); }
  };

  return <>
    <CustomVideoStyleEditor name={name} onNameChange={(value) => { setName(value); dirty.current = true; }}
      description={description} onDescriptionChange={(value) => { setDescription(value); dirty.current = true; setSampleCurrent(false); }}
      referencePaths={referencePaths} onAddReference={() => void addReference()} onRemoveReference={(path) => { setReferencePaths((paths) => paths.filter((item) => item !== path)); dirty.current = true; setSampleCurrent(false); }}
      referencePreviews={{ ...storedReferencePreviews, ...referencePreviews }} onReferenceFiles={(files) => void uploadReferences(files)}
      baseStyle={baseStyle ? { name: baseStyle.name, posterUrl: basePoster } : undefined} sample={sample} busy={working || running} status={status} saving={saving}
      modelControl={<VideoModelControl token={token} value={styleModel.binding} onChange={async (value) => { if (!chatId) dirty.current = true; await styleModel.changeBinding(value); }} disabled={working || running || saving || Boolean(draft?.authoring?.projectName && !chatId)} loading={styleModel.loading} error={styleModel.error} onRetry={styleModel.reload} />}
      generationDisabled={styleModel.loading || styleModel.saving || Boolean(styleModel.error)}
      onGenerate={generate} onRetry={generate} onSave={() => void save()} onBack={() => void back()} backDisabled={working || saving} onStop={running && chatId ? () => { setStatus("正在停止…"); client.sendMessage(chatId, "/stop"); } : undefined}
      editableFields={draft?.brandKit ? [] : editableFields} canSave={sampleCurrent && (dirty.current || draft?.revision !== savedRevision)} sampleNeedsUpdate={!sampleCurrent} aspectRatio={aspect} onAspectRatioChange={(value) => void changeAspect(value)}
      conversationStarted={Boolean(draft?.authoring?.projectName)}
      openConversationRequest={conversationRequest}
      saveLabel={useOnSave ? "保存并使用" : "保存风格"}
      actions={draft ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6" aria-label="风格更多操作"><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent>{history.length ? <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>历史记录</DropdownMenuItem> : null}{!latestSavedVersion.current || history.some((v) => v.version === latestSavedVersion.current && v.authoring?.samplePath) ? <DropdownMenuItem disabled={working || running || saving} onSelect={() => setDiscardOpen(true)}>放弃草稿</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu> : null}
      style={{ primaryColor: draft?.tokens?.colors?.primary || "#315d91", backgroundColor: draft?.tokens?.colors?.background || "#ffffff", fontFamily: draft?.tokens?.typography?.bodyFamily || "Microsoft YaHei" }}
      onStyleChange={(patch) => void changeStyle(patch)} onChatVisibleChange={setChatVisible}
      chat={<DocChatPanel chatId={chatId} onReadyChange={setReadyChat} hideStop getSendOptions={() => ({ agentKind: "video" })} prepareContent={(content) => `当前正在编辑风格样片项目「${draft?.authoring?.projectName ?? ""}」。请先inspect现有结果，依据用户消息回答或修改；只有明确修改要求才执行修改，保留未涉及的旁白、声音和素材，不生成整片。用户消息：${content}`} placeholder="告诉 Mona 想怎样调整这个风格…" />} />
    <Dialog open={visible && Boolean(error)} onOpenChange={(open) => { if (!open) { setError(null); setRetryAction(null); } }}><DialogContent><DialogHeader><DialogTitle>风格操作未完成</DialogTitle><DialogDescription>{error}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => { setError(null); setRetryAction(null); }}>关闭</Button>{retryAction ? <Button size="sm" onClick={() => { const retry = retryAction; setError(null); setRetryAction(null); void retry(); }}>重试</Button> : null}</div></DialogContent></Dialog>
    <input ref={referenceInput} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" aria-label="选择参考图片" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void uploadReferences(files); }} />
    <Dialog open={visible && historyOpen} onOpenChange={setHistoryOpen}><DialogContent><DialogHeader><DialogTitle>风格历史记录</DialogTitle><DialogDescription>恢复后可以继续调整，已有视频不受影响。</DialogDescription></DialogHeader><div className="space-y-2">{history.map((version) => <div key={version.version} className="flex items-center justify-between text-caption"><span>版本 {version.version}</span><Button variant="outline" size="sm" disabled={working || running || !version.authoring?.samplePath} onClick={() => void restoreVersion(version.version)}>恢复</Button></div>)}</div></DialogContent></Dialog>
    <Dialog open={visible && discardOpen} onOpenChange={setDiscardOpen}><DialogContent><DialogHeader><DialogTitle>放弃当前草稿？</DialogTitle><DialogDescription>{latestSavedVersion.current ? "将恢复上次保存的风格，已有视频不受影响。" : "这份尚未保存的风格将被删除。"}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => setDiscardOpen(false)}>取消</Button><Button variant="destructive" size="sm" onClick={() => void discard()}>放弃草稿</Button></div></DialogContent></Dialog>
  </>;
}
