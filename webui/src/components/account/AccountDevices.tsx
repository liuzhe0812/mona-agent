import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Monitor, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SubsectionLabel } from "@/components/ui/page-header";
import { useLicense } from "@/hooks/useLicense";
import { accountDeviceErrorMessage, devicePlatformLabel, parseLoginDevices, type LoginDevice, type LoginDeviceList } from "@/lib/account-devices";

function lastUsed(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

export function AccountDevices() {
  const { removeLoginDevice } = useLicense();
  const [data, setData] = useState<LoginDeviceList | null>(null);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [selected, setSelected] = useState<LoginDevice | null>(null);
  const [readError, setReadError] = useState("");
  const [removeError, setRemoveError] = useState("");
  const generation = useRef(0);
  const mutationPending = useRef(false);
  const mounted = useRef(false);

  const read = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setReadError("");
    try {
      const result = parseLoginDevices(await invoke("list_login_devices"));
      if (request === generation.current) setData(result);
    } catch (error) {
      if (request === generation.current) setReadError(accountDeviceErrorMessage(error, "read"));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void read();
    return () => { mounted.current = false; generation.current += 1; };
  }, [read]);

  const revoke = async () => {
    if (!selected || selected.current || mutationPending.current) return;
    const target = selected;
    const request = generation.current;
    mutationPending.current = true;
    setRemoving(true);
    setRemoveError("");
    try {
      await removeLoginDevice({ id: target.id, revision: target.revision });
      if (request !== generation.current) return;
      setSelected(null);
      setData((current) => current && ({ ...current, devices: current.devices.filter((device) => device.id !== target.id) }));
      await read();
    } catch (error) {
      if (request === generation.current) setRemoveError(accountDeviceErrorMessage(error, "remove"));
    } finally {
      mutationPending.current = false;
      if (mounted.current) setRemoving(false);
    }
  };

  return (
    <section aria-label="登录设备">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <SubsectionLabel>登录设备</SubsectionLabel>
          {data && <span className="text-caption text-muted-foreground" aria-label="设备名额">{data.devices.length} / {data.device_limit} 台</span>}
        </div>
        <Button variant="ghost" size="sm" disabled={loading || removing} aria-label="刷新登录设备" onClick={() => void read()}>
          {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
          刷新
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60 bg-card" aria-busy={loading}>
        {loading && !data && <p className="px-4 py-4 text-caption text-muted-foreground" role="status">正在读取登录设备…</p>}
        {readError && <p className="px-4 py-3 text-caption text-destructive" role="alert">{readError}</p>}
        {data && data.devices.length === 0 && !loading && !readError && <p className="px-4 py-4 text-caption text-muted-foreground">暂无已登录设备</p>}
        {data && <ul className="divide-y divide-border/50" aria-label="已登录设备">
          {[...data.devices].sort((a, b) => Number(b.current) - Number(a.current)).map((device) => (
            <li key={device.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-body font-medium" title={device.name}>{device.name}</span>
                  {device.current && <span className="shrink-0 text-caption text-muted-foreground">当前设备</span>}
                </div>
                <p className="mt-0.5 text-caption text-muted-foreground">
                  {devicePlatformLabel[device.platform]} · 最近使用 <time dateTime={device.last_seen_at} title={new Date(device.last_seen_at).toLocaleString("zh-CN")}>{lastUsed(device.last_seen_at)}</time>
                </p>
              </div>
              {!device.current && <Button variant="ghost" size="sm" className="shrink-0 text-destructive hover:text-destructive"
                disabled={loading || removing || !!readError} aria-label={`移除 ${device.name}`}
                onClick={() => { setRemoveError(""); setSelected(device); }}>移除</Button>}
            </li>
          ))}
        </ul>}
      </div>
      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open && !mutationPending.current) { setSelected(null); setRemoveError(""); } }}>
        <DialogContent className="sm:max-w-md" showCloseButton={!removing}>
          <DialogHeader>
            <DialogTitle>移除登录设备？</DialogTitle>
            <DialogDescription className="break-words">
              将退出“{selected?.name ?? ""}”的账号登录并释放名额。本地资料和任务不会删除。
            </DialogDescription>
          </DialogHeader>
          {removeError && <p role="alert" className="text-caption text-destructive">{removeError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={removing} onClick={() => { setSelected(null); setRemoveError(""); }}>取消</Button>
            {removeError ? <Button onClick={() => { setSelected(null); setRemoveError(""); void read(); }}>刷新设备列表</Button>
              : <Button variant="destructive" disabled={removing} onClick={() => void revoke()}>
                {removing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}{removing ? "移除中…" : "确认移除"}
              </Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
