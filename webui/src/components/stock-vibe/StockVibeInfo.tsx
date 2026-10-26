import type { ReactNode } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface StockVibeInfoProps {
  title: ReactNode;
  label?: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function StockVibeInfo({ title, label, children, open, onOpenChange, className }: StockVibeInfoProps) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogTrigger asChild><Button type="button" variant="ghost" size="sm" className={cn("h-auto max-w-full justify-start whitespace-normal px-0 py-1 text-left font-normal", className)}>{label ?? title}</Button></DialogTrigger>
    <DialogContent showCloseButton={false} aria-describedby={undefined} className="scrollbar-scope flex max-h-[80vh] max-w-3xl flex-col">
      <DialogHeader className="pr-8"><DialogTitle>{title}</DialogTitle></DialogHeader>
      <DialogClose asChild><Button type="button" variant="ghost" size="icon" className="absolute right-3 top-3" aria-label="关闭信息"><X className="h-4 w-4" aria-hidden="true" /></Button></DialogClose>
      <div className="min-h-0 space-y-3 overflow-y-auto text-caption">{children}</div>
    </DialogContent>
  </Dialog>;
}
