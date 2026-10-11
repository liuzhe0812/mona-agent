import { Folder, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { DevelopmentLoading } from "./DevelopmentLoading";
import type { AttachedDocument } from "@/hooks/useAttachedDocuments";
import { EMPTY_DOCUMENTS } from "./store";
import type { DevelopmentSendAttachments, DevExecutor, DevProject, ExecutorId } from "@/lib/development-api";
import { developmentModels, developmentModelRoute } from "./development-models";

export interface NewTaskRoute {
  executor: ExecutorId;
  model: string | null;
  provider: string | null;
  effort: string | null;
}

export interface NewTaskDraft extends NewTaskRoute {
  draft: string;
  documents?: AttachedDocument[];
}

export function DevelopmentNewTask({ project, executors, modelsLoading = false, value, busy, error, onChange, onSubmit, onToggleProjects, onManageModels }: {
  project: DevProject;
  executors: DevExecutor[];
  modelsLoading?: boolean;
  value: NewTaskDraft;
  busy: boolean;
  error?: string;
  onChange: (value: NewTaskDraft) => void;
  onSubmit: (content: string, attachments?: DevelopmentSendAttachments) => Promise<boolean>;
  onToggleProjects?: () => void;
  onManageModels?: () => void;
}) {
  const options = developmentModels(executors).map((option) => {
    const route = developmentModelRoute(option, option.reasoningEffort);
    const active = route.executor === value.executor && route.model === value.model && route.provider === value.provider;
    return {
      ...option,
      active,
      reasoningEffort: active ? value.effort ?? option.defaultReasoningEffort : option.reasoningEffort,
    };
  });
  const selected = options.find((option) => option.active);
  const executor = executors.find((item) => item.id === value.executor);

  return <section data-testid="development-new-task" aria-label="新建开发任务" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 px-4">
      {onToggleProjects && <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="切换项目列表" onClick={onToggleProjects}><PanelLeft className="h-4 w-4" /></Button>}
      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-ui font-medium">{project.displayName}</span>
    </header>
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-20 text-center">
      <h1 className="max-w-2xl text-title-lg font-medium">你想让我们在 {project.displayName} 中构建什么？</h1>
    </div>
    <footer className="mx-auto w-full max-w-4xl shrink-0 px-5 pb-5">
      <ThreadComposer value={value.draft} onValueChange={(draft) => onChange({ ...value, draft })}
        chatId={`new:${project.id}`} documentDraft={value.documents ?? EMPTY_DOCUMENTS}
        onDocumentDraftChange={(documents) => onChange({ ...value, documents })} awaitSendResult
        onSend={(content, _images, options) => onSubmit(content, {
          docPaths: options?.docPaths, documentNames: options?.documentNames,
        })} clearOnSend={false} autoFocus inputLabel="新开发任务输入" sendLabel="创建并发送开发任务"
        sendDisabled={modelsLoading || busy || !executor?.available} imageInputEnabled={false}
        modelOptions={options} modelLabel={selected?.label ?? value.model ?? "选择模型"} modelDisabled={modelsLoading || busy} currentExecutor={value.executor}
        onModelSelect={(option, effort) => onChange({ ...value, ...developmentModelRoute(option, effort) })}
        onOpenSettings={onManageModels} />
      {modelsLoading ? <DevelopmentLoading label="正在读取模型…" variant="inline" /> : executors.length > 0 && !executor?.available && <p role="status" className="mt-2 text-caption text-muted-foreground">{executor?.reason ?? "当前模型不可用"}</p>}
      {error && <p role="alert" className="mt-2 text-caption text-destructive">{error}</p>}
    </footer>
  </section>;
}
