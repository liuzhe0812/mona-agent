import { Plus } from "lucide-react";
import terminalIcon from "@/assets/icons/sidebar-terminal.png";
import databaseIcon from "@/assets/icons/sidebar-database.png";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useDbStore } from "@/components/db/store/dbStore";
import { useTerminalStore } from "@/components/terminal/store/terminalStore";

export function OperationsCreateMenu() {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="新建连接" title="新建连接"><Plus className="h-3.5 w-3.5" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem onSelect={() => useTerminalStore.getState().setNewConnectionDialogOpen(true, "ssh")}><img src={terminalIcon} alt="" draggable={false} className="mr-2 h-4 w-4 shrink-0 object-contain" />SSH 连接</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => useDbStore.getState().setNewConnectionDialogOpen(true)}><img src={databaseIcon} alt="" draggable={false} className="mr-2 h-4 w-4 shrink-0 object-contain" />数据库</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
