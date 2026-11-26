import type { ComponentProps } from "react";
import { useClient } from "@/providers/ClientProvider";
import { DocChatPanel } from "../DocChatPanel";
import { VideoModelControl } from "./VideoModelControl";
import { useVideoModelBinding } from "./useVideoModelBinding";

export function VideoChatPanel(props: ComponentProps<typeof DocChatPanel>) {
  const { token } = useClient();
  const model = useVideoModelBinding(props.chatId);
  const unavailable = model.loading || model.saving || Boolean(model.error);
  return <DocChatPanel {...props} showWorkModelSelector={false} disabled={props.disabled || unavailable}
    modelControl={<VideoModelControl token={token} value={model.binding} onChange={model.changeBinding}
      disabled={props.disabled || model.saving} loading={model.loading} error={model.error} onRetry={model.reload} />} />;
}
