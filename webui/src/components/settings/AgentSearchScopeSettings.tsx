import { useEffect, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";

import { listAccounts, getFolders } from "@/components/email/lib/emailApi";
import { getFolderDisplayName } from "@/components/email/lib/folderUtils";
import type { EmailAccount, EmailFolder } from "@/components/email/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { SubsectionLabel } from "@/components/ui/page-header";
import {
  getAgentSearchScope,
  getNotesVaultPath,
  loadDesktopNotesState,
  setAgentSearchScope,
  type AgentSearchScope,
} from "@/lib/tauri";

interface NotebookOption {
  id: string;
  name: string;
}

interface NotesMetadata {
  vaultReady: boolean;
  notebooks: NotebookOption[];
}

interface EmailAccountMetadata {
  id: string;
  label: string;
  folders: EmailFolder[];
}

type SourceScope = AgentSearchScope["notes"] | AgentSearchScope["email"];

interface AgentSearchScopeSettingsProps {
  source: "notes" | "email";
  onConfigureNotesVault?: () => void;
}

const modeOptions = [
  { value: "all", label: "全部允许" },
  { value: "none", label: "全部不允许" },
  { value: "specific", label: "指定文件夹允许" },
];

const modeDescriptions: Record<"notes" | "email", Record<string, string>> = {
  notes: {
    all: "所有笔记（含根目录与全部文件夹）均可被 Agent 检索。",
    none: "Agent 无法检索任何笔记。",
    specific: "仅勾选的文件夹（含根目录）参与检索，新增文件夹默认不参与。",
  },
  email: {
    all: "所有邮件文件夹均可被 Agent 检索。",
    none: "Agent 无法检索任何邮件。",
    specific: "仅勾选的文件夹参与检索，新增文件夹默认不参与。",
  },
};

const readErrorText = "搜索范围暂时无法读取，请点击“重试”后再试。";
const saveErrorText = "搜索范围保存失败，请重试。";

function normalizeScope(value: AgentSearchScope): AgentSearchScope {
  if (!value || typeof value !== "object" || !value.notes || !value.email) {
    throw new Error("Invalid search scope");
  }
  const validMode = (mode: string) => ["", "all", "none", "specific"].includes(mode);
  if (!validMode(value.notes.mode)
    || !Array.isArray(value.notes.allowedNotebookIds)
    || !value.notes.allowedNotebookIds.every((item) => typeof item === "string")
    || !validMode(value.email.mode)
    || !Array.isArray(value.email.allowedFolders)
    || !value.email.allowedFolders.every((item) => typeof item === "string")) {
    throw new Error("Invalid search scope");
  }
  return {
    notes: { mode: value.notes.mode, allowedNotebookIds: [...value.notes.allowedNotebookIds] },
    email: { mode: value.email.mode, allowedFolders: [...value.email.allowedFolders] },
  };
}

async function loadNotesMetadata(): Promise<NotesMetadata> {
  const vaultPath = await getNotesVaultPath();
  if (!vaultPath) return { vaultReady: false, notebooks: [] };
  const state = await loadDesktopNotesState() as { notebooks?: unknown } | null;
  if (!state || !Array.isArray(state.notebooks)
    || !state.notebooks.every((item) => item && typeof item === "object"
      && typeof (item as NotebookOption).id === "string"
      && typeof (item as NotebookOption).name === "string")) {
    throw new Error("Notebook list unavailable");
  }
  return { vaultReady: true, notebooks: state.notebooks as NotebookOption[] };
}

async function loadEmailMetadata(): Promise<EmailAccountMetadata[]> {
  const accounts = await listAccounts();
  return Promise.all(accounts.map(async (account: EmailAccount) => ({
    id: account.id,
    label: account.displayName || account.fromAddress || account.imapUsername,
    folders: await getFolders(account.id),
  })));
}

export function AgentSearchScopeSettings({
  source,
  onConfigureNotesVault,
}: AgentSearchScopeSettingsProps) {
  const [scope, setScope] = useState<AgentSearchScope | null>(null);
  const [notesMetadata, setNotesMetadata] = useState<NotesMetadata | null>(null);
  const [emailMetadata, setEmailMetadata] = useState<EmailAccountMetadata[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingSave, setPendingSave] = useState<SourceScope | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setScope(null);
    setNotesMetadata(null);
    setEmailMetadata(null);
    setReadError(false);
    setSaveError(false);
    setPendingSave(null);

    void (async () => {
      try {
        const [loadedScope, metadata] = await Promise.all([
          getAgentSearchScope().then(normalizeScope),
          source === "notes" ? loadNotesMetadata() : loadEmailMetadata(),
        ]);
        if (!active) return;
        setScope(loadedScope);
        if (source === "notes") setNotesMetadata(metadata as NotesMetadata);
        else setEmailMetadata(metadata as EmailAccountMetadata[]);
      } catch {
        if (active) setReadError(true);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [source, retryRevision]);

  const persist = async (nextSourceScope: SourceScope) => {
    setSaving(true);
    setSaveError(false);
    setPendingSave(nextSourceScope);
    try {
      const latest = normalizeScope(await getAgentSearchScope());
      const next = source === "notes"
        ? { ...latest, notes: nextSourceScope as AgentSearchScope["notes"] }
        : { ...latest, email: nextSourceScope as AgentSearchScope["email"] };
      await setAgentSearchScope(next);
      setScope(next);
      setPendingSave(null);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const retryDisabled = loading || saving;
  const currentMode = scope ? scope[source].mode || "all" : "all";
  const canEdit = !!scope && !loading && !saving && !pendingSave && !readError;
  const sourceLabel = source === "notes" ? "笔记搜索范围" : "邮件搜索范围";
  const sourceDescription = modeDescriptions[source][currentMode] ?? modeDescriptions[source].all;
  const allowedIds = source === "notes"
    ? new Set(scope?.notes.allowedNotebookIds ?? [])
    : new Set(scope?.email.allowedFolders ?? []);

  const setMode = (mode: string) => {
    if (!scope || !canEdit) return;
    void persist(source === "notes"
      ? { ...scope.notes, mode }
      : { ...scope.email, mode });
  };

  const toggleAllowed = (id: string) => {
    if (!scope || !canEdit) return;
    if (source === "notes") {
      const next = new Set(scope.notes.allowedNotebookIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      void persist({ mode: "specific", allowedNotebookIds: Array.from(next) });
    } else {
      const next = new Set(scope.email.allowedFolders);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      void persist({ mode: "specific", allowedFolders: Array.from(next) });
    }
  };

  const retrySave = () => {
    if (pendingSave) void persist(pendingSave);
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <SubsectionLabel>{sourceLabel}</SubsectionLabel>
        {saving ? <span className="text-caption text-muted-foreground">正在保存…</span> : null}
      </div>

      {loading ? (
        <div className="flex min-h-20 items-center justify-center text-caption text-muted-foreground" role="status">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />正在读取搜索范围…
        </div>
      ) : readError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p role="alert" className="text-caption text-destructive">{readErrorText}</p>
          <Button type="button" variant="outline" size="sm" disabled={retryDisabled} onClick={() => setRetryRevision((value) => value + 1)}>
            重试
          </Button>
        </div>
      ) : scope ? (
        <div className="rounded-lg border border-border/60 bg-card">
          {source === "notes" && notesMetadata && !notesMetadata.vaultReady ? (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-body font-medium">未配置笔记仓库</p>
                <p className="mt-0.5 text-caption text-muted-foreground">请先选择仓库目录，再设置 Agent 可检索的笔记范围。</p>
              </div>
              {onConfigureNotesVault ? (
                <Button type="button" variant="outline" size="sm" onClick={onConfigureNotesVault}>
                  <FolderOpen className="mr-1.5 h-3.5 w-3.5" />选择仓库目录
                </Button>
              ) : null}
            </div>
          ) : source === "email" && emailMetadata?.length === 0 ? (
            <div className="px-4 py-3">
              <p className="text-body font-medium">未配置邮件账号</p>
              <p className="mt-0.5 text-caption text-muted-foreground">请先在邮件模块添加账号，再设置 Agent 可检索的邮件范围。</p>
            </div>
          ) : (
            <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium">{sourceLabel}</p>
                <p className="mt-0.5 text-caption text-muted-foreground">{sourceDescription}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Select
                  value={currentMode}
                  options={modeOptions}
                  onValueChange={setMode}
                  disabled={!canEdit}
                  aria-label={sourceLabel}
                  className="h-8 w-[180px] rounded-full text-ui"
                />
                {currentMode === "specific" ? (
                  <Button type="button" variant="outline" size="sm" disabled={!canEdit} onClick={() => setConfiguring(true)}>
                    配置
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {saveError && !configuring ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p role="alert" className="text-caption text-destructive">{saveErrorText}</p>
          <Button type="button" variant="outline" size="sm" disabled={retryDisabled} onClick={retrySave}>
            重试
          </Button>
        </div>
      ) : null}

      <Dialog open={configuring} onOpenChange={setConfiguring}>
        <DialogContent className="max-h-[75vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{source === "notes" ? "配置允许检索的笔记文件夹" : "配置允许检索的邮件文件夹"}</DialogTitle>
            <DialogDescription>仅勾选的文件夹会参与 Agent 搜索。</DialogDescription>
          </DialogHeader>
          {saveError && configuring ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <p role="alert" className="text-caption text-destructive">{saveErrorText}</p>
              <Button type="button" variant="outline" size="sm" disabled={retryDisabled} onClick={retrySave}>
                重试
              </Button>
            </div>
          ) : null}
          {source === "notes" ? (
            <div className="divide-y divide-border/60 rounded-xl border border-border/60">
              <label className="flex cursor-pointer select-none items-center gap-2.5 px-4 py-3 text-ui text-foreground/85 hover:bg-muted/35">
                <Checkbox checked={allowedIds.has("")} disabled={!canEdit} onCheckedChange={() => toggleAllowed("")} />
                <span>根目录（未分类笔记）</span>
              </label>
              {(notesMetadata?.notebooks ?? []).map((notebook) => (
                <label key={notebook.id} className="flex cursor-pointer select-none items-center gap-2.5 px-4 py-3 text-ui text-foreground/85 hover:bg-muted/35">
                  <Checkbox checked={allowedIds.has(notebook.id)} disabled={!canEdit} onCheckedChange={() => toggleAllowed(notebook.id)} />
                  <span className="truncate">{notebook.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {(emailMetadata ?? []).map((account) => (
                <div key={account.id} className="rounded-xl border border-border/60">
                  <div className="border-b border-border/60 px-4 py-2.5 text-ui font-medium text-foreground">{account.label}</div>
                  <div className="divide-y divide-border/50">
                    {account.folders.length === 0 ? (
                      <div className="px-4 py-3 text-caption text-muted-foreground">暂无文件夹缓存</div>
                    ) : account.folders.map((folder) => (
                      <label key={folder.name} className="flex cursor-pointer select-none items-center gap-2.5 px-4 py-2.5 text-ui text-foreground/85 hover:bg-muted/35">
                        <Checkbox checked={allowedIds.has(folder.name)} disabled={!canEdit} onCheckedChange={() => toggleAllowed(folder.name)} />
                        <span className="truncate">{getFolderDisplayName(folder.name)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
