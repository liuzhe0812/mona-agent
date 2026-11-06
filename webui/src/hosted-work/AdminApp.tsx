import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ModelSettingsPanel } from "./ModelSettingsPanel";

function getToken(): string | null {
  const valid = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
  try {
    const adminToken = sessionStorage.getItem("admin_token");
    if (valid(adminToken)) return adminToken;
    const website = JSON.parse(sessionStorage.getItem("mona-website-session-v1") || "null") as { token?: unknown } | null;
    return valid(website?.token) ? website.token : null;
  } catch {
    return null;
  }
}

export function AdminApp() {
  const [token] = useState(getToken);
  return <main className="h-full min-h-0 overflow-y-auto bg-background px-4 py-8 text-foreground">
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-title font-semibold">工作台模型与计费</h1><p className="mt-2 text-ui text-muted-foreground">管理线上工作台的模型连接与价格。</p></div>
        <Button variant="outline" asChild><a href="/admin">管理后台</a></Button>
      </header>
      {token ? <ModelSettingsPanel token={token} /> : <section className="rounded-lg border border-border bg-card p-6">
        <p className="text-ui">请先登录管理后台，再打开此页面。</p>
        <Button className="mt-4" asChild><a href="/admin">前往管理员登录</a></Button>
      </section>}
    </div>
  </main>;
}
