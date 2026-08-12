import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 页面级标题组件（design §5.3 / §12.1）。
 * 业务页面不得复制三者的字号和间距字符串，统一从这里消费。
 */

interface PageHeaderProps {
  /** 页面唯一 h1 文案 */
  title: React.ReactNode;
  /** 标题下方的辅助说明（次级文字色） */
  description?: React.ReactNode;
  /** 右侧主要动作区 */
  actions?: React.ReactNode;
  className?: string;
}

/** 页面标题：每页最多一个，text-title + 可选说明 + 右侧动作 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-title">{title}</h1>
        {description ? (
          <p className="text-body text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

interface SectionHeaderProps {
  /** 并列区块标题（h2） */
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 局部动作（链接、小按钮） */
  actions?: React.ReactNode;
  className?: string;
}

/** 区块标题：同页并列区块使用，text-title-sm + 可选说明 + 局部动作 */
export function SectionHeader({ title, description, actions, className }: SectionHeaderProps) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <div className="min-w-0 space-y-0.5">
        <h2 className="text-title-sm">{title}</h2>
        {description ? (
          <p className="text-caption text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** 分组标题/眉题：表单组、列表组、表头，text-caption 600 + 克制字距 */
export function SubsectionLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-caption font-semibold tracking-wide text-muted-foreground", className)}
      {...props}
    />
  );
}
