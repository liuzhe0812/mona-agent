import { useMemo, useState } from "react";
import { History, Search, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RightSidebarToggleIcon } from "@/components/notes/RightSidebarToggleIcon";
import { LeftSidebarToggleIcon } from "@/components/notes/LeftSidebarToggleIcon";
import type { ConversationMeta, UIMessage } from "@/lib/types";

interface ThreadHeaderProps {
  title: string;
  onToggleSidebar: () => void;
  sidebarOpen?: boolean;
  minimal?: boolean;
  /** Multi-agent phase 2d: conversation shape of the active session. Rooms
   *  surface a member-count badge that toggles the room context panel. */
  conversation?: ConversationMeta | null;
  onToggleRoomPanel?: () => void;
  /** 右侧面板收起/展开（从边缘浮动按钮移至标题行常驻）。 */
  workspaceOpen?: boolean;
  onToggleWorkspace?: () => void;
  /** 右侧面板是否有内容（无内容时隐藏切换按钮）。 */
  workspaceHasContent?: boolean;
  messages?: UIMessage[];
  onJumpToMessage?: (messageId: string) => void;
}

function messageText(message: UIMessage): string {
  return (message.displayContent ?? message.content).trim();
}

function messageTime(createdAt: number): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function ConversationTools({
  messages,
  onJumpToMessage,
}: {
  messages: UIMessage[];
  onJumpToMessage: (messageId: string) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchable = useMemo(
    () => messages.filter((message) => (
      (message.role === "user" || message.role === "assistant") && messageText(message)
    )),
    [messages],
  );
  const results = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return [];
    return searchable.filter((message) => messageText(message).toLocaleLowerCase().includes(keyword));
  }, [query, searchable]);
  const userHistory = useMemo(
    () => searchable.filter((message) => message.role === "user").slice().reverse(),
    [searchable],
  );
  const jump = (messageId: string, close: "search" | "history") => {
    onJumpToMessage(messageId);
    if (close === "search") setSearchOpen(false);
    else setHistoryOpen(false);
  };

  return (
    <>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="搜索会话"
          title="搜索会话"
          onClick={() => setSearchOpen(true)}
          className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="用户输入历史"
          title="用户输入历史"
          onClick={() => setHistoryOpen(true)}
          className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <History className="h-3.5 w-3.5" />
        </Button>
      </div>

      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="max-w-xl gap-4">
          <DialogHeader><DialogTitle>搜索会话</DialogTitle><DialogDescription className="sr-only">搜索当前会话中的用户和助手消息</DialogDescription></DialogHeader>
          <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前会话内容" />
          <div className="max-h-[55vh] overflow-y-auto">
            {!query.trim() ? <p className="py-8 text-center text-caption text-muted-foreground">输入关键词开始搜索</p> : results.length ? (
              <div className="grid gap-1">
                {results.map((message) => (
                  <button key={message.id} type="button" onClick={() => jump(message.id, "search")} className="grid gap-1 rounded-md px-3 py-2 text-left hover:bg-muted/70">
                    <span className="text-caption text-muted-foreground">{message.role === "user" ? "你" : "助手"} · {messageTime(message.createdAt)}</span>
                    <span className="line-clamp-2 text-ui">{messageText(message)}</span>
                  </button>
                ))}
              </div>
            ) : <p className="py-8 text-center text-caption text-muted-foreground">没有匹配内容</p>}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-xl gap-4">
          <DialogHeader><DialogTitle>用户输入历史</DialogTitle><DialogDescription className="sr-only">点击一条输入可跳转到原消息</DialogDescription></DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {userHistory.length ? (
              <div className="grid gap-1">
                {userHistory.map((message) => (
                  <button key={message.id} type="button" onClick={() => jump(message.id, "history")} className="grid gap-1 rounded-md px-3 py-2 text-left hover:bg-muted/70">
                    <span className="text-caption text-muted-foreground">{messageTime(message.createdAt)}</span>
                    <span className="line-clamp-2 text-ui">{messageText(message)}</span>
                  </button>
                ))}
              </div>
            ) : <p className="py-8 text-center text-caption text-muted-foreground">当前会话还没有用户输入</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ThreadHeader({
  title,
  onToggleSidebar,
  sidebarOpen = true,
  minimal = false,
  conversation = null,
  onToggleRoomPanel,
  workspaceOpen = false,
  onToggleWorkspace,
  workspaceHasContent = false,
  messages = [],
  onJumpToMessage,
}: ThreadHeaderProps) {
  const { t } = useTranslation();
  if (minimal) {
    return (
      <div className="relative z-10 flex h-11 items-center justify-between gap-3 px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={sidebarOpen ? "收起会话列表" : "展开会话列表"}
          title={sidebarOpen ? "收起会话列表" : "展开会话列表"}
          aria-expanded={sidebarOpen}
          onClick={onToggleSidebar}
          className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <LeftSidebarToggleIcon open={sidebarOpen} className="h-3.5 w-3.5" />
        </Button>
      {workspaceHasContent && onToggleWorkspace ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={workspaceOpen ? "收起工作区" : "展开工作区"}
            title={workspaceOpen ? "收起工作区" : "展开工作区"}
            onClick={onToggleWorkspace}
            className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RightSidebarToggleIcon open={workspaceOpen} className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    );
  }

  const isRoom = conversation?.type === "room";
  const memberCount = isRoom ? (conversation?.agentIds.length ?? 0) : 0;

  return (
    <div className="relative z-10 flex items-center justify-between gap-3 px-3 py-2">
      <div className="relative flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={sidebarOpen ? "收起会话列表" : "展开会话列表"}
          title={sidebarOpen ? "收起会话列表" : "展开会话列表"}
          aria-expanded={sidebarOpen}
          onClick={onToggleSidebar}
          className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <LeftSidebarToggleIcon open={sidebarOpen} className="h-3.5 w-3.5" />
        </Button>
        <div className="flex min-w-0 items-center rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground">
          <span className="max-w-[min(60vw,32rem)] truncate">{title}</span>
        </div>
        {isRoom && onToggleRoomPanel ? (
          <button
            type="button"
            onClick={onToggleRoomPanel}
            aria-label={t("room.header.members", { count: memberCount })}
            title={t("room.header.members", { count: memberCount })}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Users className="h-3.5 w-3.5" aria-hidden />
            <span className="tabular-nums">{memberCount}</span>
          </button>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {messages.length > 0 && onJumpToMessage ? <ConversationTools messages={messages} onJumpToMessage={onJumpToMessage} /> : null}
        {workspaceHasContent && onToggleWorkspace && (!workspaceOpen || isRoom) ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={workspaceOpen ? "收起工作区" : "展开工作区"}
            title={workspaceOpen ? "收起工作区" : "展开工作区"}
            onClick={onToggleWorkspace}
            className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RightSidebarToggleIcon open={workspaceOpen} className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-4" />
    </div>
  );
}
