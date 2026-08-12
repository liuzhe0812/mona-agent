import * as React from "react";

import { cn } from "@/lib/utils";
import { SubsectionLabel } from "@/components/ui/page-header";

/**
 * 表单分组（design §5.3 分组标题 + §6.1 字段间距）。
 * 分组标题使用 SubsectionLabel，字段之间固定 16px（space-y-4）。
 */
interface FormSectionProps {
  /** 分组标题 */
  title?: React.ReactNode;
  /** 分组说明（次级文字色） */
  description?: React.ReactNode;
  /** 右侧局部动作 */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function FormSection({ title, description, actions, children, className }: FormSectionProps) {
  return (
    <section className={cn("space-y-3", className)}>
      {title || description || actions ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            {title ? <SubsectionLabel>{title}</SubsectionLabel> : null}
            {description ? (
              <p className="text-caption text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="space-y-4">{children}</div>
    </section>
  );
}
