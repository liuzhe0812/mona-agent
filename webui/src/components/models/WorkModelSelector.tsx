import { useClientContextOrNull } from "@/providers/ClientProvider";
import { ModelSelector } from "./ModelSelector";
import { useWorkModelSelection } from "./useWorkModelSelection";

/** Model control for module assistants that use the ordinary Work source. */
export function WorkModelSelector({ disabled, onOpenSettings, collisionBoundary }: {
  disabled?: boolean;
  onOpenSettings?: (section?: string) => void;
  collisionBoundary?: HTMLElement | null;
}) {
  const context = useClientContextOrNull();
  const model = useWorkModelSelection({
    token: context?.token ?? "",
    modelName: context?.modelName ?? null,
    enabled: Boolean(context),
  });
  return <ModelSelector options={model.modelOptions} label={model.modelLabel ?? "选择模型"}
    disabled={disabled || !context} onSelect={model.selectModel}
    onManage={onOpenSettings ? () => onOpenSettings("models_providers") : undefined}
    collisionBoundary={collisionBoundary}
    className="max-w-full rounded-md border-0 bg-transparent px-2" />;
}
