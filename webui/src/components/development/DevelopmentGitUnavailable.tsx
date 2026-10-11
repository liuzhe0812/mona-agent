import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GitSummary } from "@/lib/development-api";
import { openExternalUrl } from "@/lib/tauri";

export function DevelopmentGitUnavailable({ reasonCode, reason, checking, onRecheck }: {
  reasonCode?: GitSummary["reasonCode"]; reason?: string; checking: boolean; onRecheck: () => void;
}) {
  const [instructions, setInstructions] = useState(false);
  const [error, setError] = useState("");
  const missing = reasonCode === "git_unavailable";
  return <section aria-label="Git 环境状态" className="space-y-3 text-ui">
    <h3 className="font-medium">{missing ? "未检测到 Git" : "当前目录不是 Git 仓库"}</h3>
    <p className="text-caption leading-relaxed text-muted-foreground">{missing
      ? "未找到可运行的 Git，暂时无法查看 Git 差异、暂存、提交或推送。文件编辑与开发会话仍可使用。"
      : reason ?? "Git 已就绪，但当前目录没有仓库信息。可以打开已有 Git 项目，或在终端中自行初始化仓库。"}</p>
    <div className="flex flex-wrap gap-2">
      {missing && <Button variant="outline" size="sm" aria-expanded={instructions} onClick={() => setInstructions(!instructions)}>安装说明</Button>}
      <Button variant="outline" size="sm" disabled={checking} onClick={onRecheck}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />{checking ? "正在检测…" : "重新检测"}</Button>
    </div>
    {missing && instructions && <div className="space-y-3 border-t border-border/60 pt-3 text-caption leading-relaxed text-muted-foreground">
      <p>从 Git 官方安装页选择对应系统。Windows 常见安装目录会自动识别，也支持当前系统 PATH 中的 Git。</p>
      <p>安装完成后点击“重新检测”。若安装在非默认位置，且新 PATH 尚未被 Mona 读取，保存工作后重新打开 Mona 再试。</p>
      <p>这里不会自动下载、安装 Git，也不会修改系统配置。</p>
      <Button variant="ghost" size="sm" className="h-auto px-0" onClick={() => {
        setError(""); void openExternalUrl("https://git-scm.com/install/").catch(() => setError("无法打开安装页，请在浏览器访问 Git 官方网站。"));
      }}><ExternalLink className="mr-1.5 h-3.5 w-3.5" />打开 Git 官方安装页</Button>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>}
  </section>;
}
