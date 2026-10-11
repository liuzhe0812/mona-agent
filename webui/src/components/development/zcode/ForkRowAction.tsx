import { memo, useCallback, useRef, useState } from "react";
import { LoaderCircle, TrendingUpDownIcon } from "zcode-lucide-react";
import { MessageAction } from "./markdown/ai-elements/message";
import { useZCodeIntl } from "./primitives/intl";

export const ForkRowAction = memo(function ForkRowAction({
  messageId,
  label,
  disabled = false,
  onFork,
  onError,
}: {
  messageId: string;
  label?: string;
  disabled?: boolean;
  onFork: (messageId: string, requestId: string) => Promise<void>;
  onError: (cause: unknown) => void;
}) {
  const { intl } = useZCodeIntl();
  const actionLabel = label ?? intl.formatMessage({ id: "chat.message.fork" });
  const busyLabel = intl.formatMessage({ id: "chat.message.forking" });
  const busyRef = useRef(false);
  const requestIdsRef = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);

  const handleFork = useCallback(async () => {
    if (disabled || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      let requestId = requestIdsRef.current.get(messageId);
      if (!requestId) {
        requestId = `fork_${crypto.randomUUID().replace(/-/g, "")}`;
        requestIdsRef.current.set(messageId, requestId);
      }
      await onFork(messageId, requestId);
    } catch (cause) {
      onError(cause);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [disabled, messageId, onError, onFork]);

  return (
    <MessageAction
      aria-label={busy ? busyLabel : actionLabel}
      aria-busy={busy}
      label={actionLabel}
      tooltip={actionLabel}
      data-testid={`v4-fork-${messageId}`}
      disabled={disabled || busy}
      onClick={() => void handleFork()}
    >
      {busy ? (
        <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
      ) : (
        <TrendingUpDownIcon className="size-3.5" />
      )}
    </MessageAction>
  );
});
