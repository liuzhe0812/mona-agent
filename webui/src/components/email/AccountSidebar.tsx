import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEmailStore } from "./store/emailStore";
import sidebarEmailIcon from "@/assets/icons/sidebar-email.png";

interface AccountSidebarProps {
  onAddAccount: () => void;
}

export function AccountSidebar({ onAddAccount }: AccountSidebarProps) {
  const accounts = useEmailStore((s) => s.accounts);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const selectAccount = useEmailStore((s) => s.selectAccount);
  const removeAccount = useEmailStore((s) => s.removeAccount);

  return (
    <div className="flex h-full flex-col bg-sidebar/35">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 px-3">
        <span className="text-[12px] font-semibold text-foreground">邮箱账号</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={onAddAccount}
          aria-label="添加账号"
          title="添加账号"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-8 text-center">
            <img src={sidebarEmailIcon} className="h-6 w-6 object-contain opacity-50" alt="" draggable={false} />
            <p className="text-[12px] text-muted-foreground">还没有账号</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[12px]"
              onClick={onAddAccount}
            >
              <Plus className="h-3 w-3" />
              添加
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {accounts.map((account) => (
              <div
                key={account.id}
                className={cn(
                  "group flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer",
                  account.id === selectedAccountId
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
                onClick={() => selectAccount(account.id)}
              >
                <img src={sidebarEmailIcon} className="h-3.5 w-3.5 shrink-0 object-contain" alt="" draggable={false} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">
                    {account.displayName}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {account.fromAddress}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 opacity-0 text-muted-foreground hover:text-destructive group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeAccount(account.id);
                  }}
                  aria-label="删除账号"
                  title="删除账号"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
