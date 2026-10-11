import { useEffect, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ModelEngine = "mona" | "codex" | "claude";

export interface ModelEngineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: {
    id: string;
    name: string;
    engine?: ModelEngine;
    context_window?: number | null;
    input_modalities?: string[] | null;
    description?: string | null;
  };
  providerLabel: string;
  engineOptions: Array<{
    id: ModelEngine;
    label: string;
    supported: boolean;
    reason?: string;
  }>;
  onSave: (engine: ModelEngine) => Promise<void>;
}

export function ModelEngineDialog({
  open,
  onOpenChange,
  model,
  providerLabel,
  engineOptions,
  onSave,
}: ModelEngineDialogProps) {
  const [selectedEngine, setSelectedEngine] = useState<ModelEngine>(model.engine ?? "mona");
  const [isSaving, setIsSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedEngine(model.engine ?? "mona");
    setSaveFailed(false);
  }, [open, model.id, model.engine]);

  const selectedOption = engineOptions.find((option) => option.id === selectedEngine);
  const supportedOptions = engineOptions.filter((option) => option.supported);

  const moveEngineSelection = (event: KeyboardEvent<HTMLButtonElement>, currentId: ModelEngine) => {
    const direction =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    const currentIndex = supportedOptions.findIndex((option) => option.id === currentId);
    const nextOption =
      event.key === "Home"
        ? supportedOptions[0]
        : event.key === "End"
          ? supportedOptions[supportedOptions.length - 1]
          : direction
            ? supportedOptions[(currentIndex + direction + supportedOptions.length) % supportedOptions.length]
            : undefined;
    if (!nextOption) return;
    event.preventDefault();
    setSelectedEngine(nextOption.id);
    document.getElementById(`model-engine-${nextOption.id}`)?.focus();
  };

  const saveEngine = async () => {
    if (isSaving || !selectedOption?.supported) return;
    setIsSaving(true);
    setSaveFailed(false);
    try {
      await onSave(selectedEngine);
      onOpenChange(false);
    } catch {
      setSaveFailed(true);
    } finally {
      setIsSaving(false);
    }
  };

  const supportsImage = model.input_modalities?.some((modality) => /image/i.test(modality));

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen || !isSaving) onOpenChange(nextOpen);
        }}
      >
        <DialogContent showCloseButton={false} className="relative max-h-[85vh] max-w-4xl gap-0 overflow-hidden p-0">
          <DialogClose asChild><Button variant="ghost" size="icon" className="absolute right-4 top-4" aria-label="关闭引擎设置" disabled={isSaving}><X className="h-4 w-4" /></Button></DialogClose>
          <DialogHeader className="border-b border-border/60 px-6 py-5 pr-16 text-left">
            <DialogTitle>{model.name}</DialogTitle>
            <DialogDescription>{providerLabel}</DialogDescription>
          </DialogHeader>

          <div className="grid min-h-0 overflow-y-auto md:grid-cols-2">
            <section className="space-y-4 border-b border-border/60 p-6 md:border-b-0 md:border-r">
              <div>
                <h3 className="text-ui font-medium">执行引擎</h3>
                <p className="mt-1 text-caption text-muted-foreground">
                  选择用于开发任务的执行引擎。默认使用 Mona 引擎。
                </p>
              </div>
              <div className="space-y-2" role="radiogroup" aria-label="执行引擎">
                {engineOptions.map((option) => (
                  <Button
                    key={option.id}
                    id={`model-engine-${option.id}`}
                    type="button"
                    variant="outline"
                    role="radio"
                    aria-checked={selectedEngine === option.id}
                    tabIndex={option.supported && (selectedEngine === option.id || (!selectedOption?.supported && supportedOptions[0]?.id === option.id)) ? 0 : -1}
                    disabled={!option.supported || isSaving}
                    onClick={() => setSelectedEngine(option.id)}
                    onKeyDown={(event) => moveEngineSelection(event, option.id)}
                    className={`h-auto w-full justify-start gap-3 whitespace-normal rounded-lg border px-3 py-3 text-left transition-colors disabled:opacity-100 ${selectedEngine === option.id ? "border-foreground/40 bg-muted/60" : "border-border/70"}`}
                  >
                    <span className="flex items-center gap-3">
                      <span
                        aria-hidden="true"
                        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${selectedEngine === option.id ? "border-foreground" : "border-muted-foreground/60"}`}
                      >
                        {selectedEngine === option.id ? (
                          <span className="h-2 w-2 rounded-full bg-foreground" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-ui font-medium ${option.supported ? "text-foreground" : "text-muted-foreground"}`}>
                          {option.label}
                          {option.id === "mona" ? (
                            <span className="ml-2 text-caption font-normal text-muted-foreground">
                              默认
                            </span>
                          ) : null}
                        </span>
                        {option.reason || option.id === "mona" ? (
                          <span className="mt-1 block text-caption text-muted-foreground">
                            {option.reason ??
                              (option.id === "mona" ? "由 Mona 执行任务并调用工具。" : "")}
                          </span>
                        ) : null}
                        {!option.supported && !option.reason ? (
                          <span className="mt-1 block text-caption text-muted-foreground">
                            当前模型不支持此引擎。
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </Button>
                ))}
              </div>
            </section>

            <section className="space-y-5 p-6">
              <h3 className="text-ui font-medium">模型信息</h3>
              <dl className="divide-y divide-border/60">
                <div className="flex items-start justify-between gap-4 py-3 first:pt-0">
                  <dt className="text-body text-muted-foreground">模型 ID</dt>
                  <dd className="break-all text-right font-mono text-body text-foreground">
                    {model.id}
                  </dd>
                </div>
                {model.context_window != null ? (
                  <div className="flex items-start justify-between gap-4 py-3">
                    <dt className="text-body text-muted-foreground">上下文窗口</dt>
                    <dd className="text-right text-body text-foreground">
                      {model.context_window.toLocaleString()} tokens
                    </dd>
                  </div>
                ) : null}
                {model.input_modalities != null ? (
                  <div className="flex items-start justify-between gap-4 py-3">
                    <dt className="text-body text-muted-foreground">图片输入</dt>
                    <dd className="text-right text-body text-foreground">
                      {supportsImage ? "支持" : "不支持"}
                    </dd>
                  </div>
                ) : null}
                {model.description ? (
                  <div className="space-y-1 py-3">
                    <dt className="text-body text-muted-foreground">说明</dt>
                    <dd className="break-words text-body text-foreground">{model.description}</dd>
                  </div>
                ) : null}
              </dl>
            </section>
          </div>

          <DialogFooter className="border-t border-border/60 px-6 py-4">
            <Button
              type="button"
              disabled={isSaving || !selectedOption?.supported}
              onClick={() => void saveEngine()}
            >
              {isSaving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={saveFailed} onOpenChange={setSaveFailed}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>保存失败</AlertDialogTitle>
            <AlertDialogDescription>
              未能确认引擎设置已保存，请重试。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void saveEngine()}>重试</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
