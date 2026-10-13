import { useState } from "react";
import { Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { type DeviceLimitError, type DeviceReplacement } from "@/lib/account-devices";

export function LoginDeviceSelection({ conflict, busy, onConfirm, onBack, onSelectionChange }: {
  conflict: DeviceLimitError; busy: boolean;
  onConfirm: (devices: DeviceReplacement[]) => void;
  onBack: () => void; onSelectionChange: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  return <div className="space-y-4">
    <p className="text-caption text-muted-foreground">当前最多登录 {conflict.deviceLimit} 台设备，请选择退出 {conflict.requiredReplacements} 台后继续。</p>
    <div className="divide-y divide-border">
      {conflict.devices.map((device) => <label key={device.id} className="flex cursor-pointer items-center gap-3 py-3">
        <Checkbox aria-label={`退出 ${device.name}`} disabled={busy} checked={selected.includes(device.id)} onCheckedChange={(checked) => {
          setSelected((ids) => checked ? [...ids, device.id] : ids.filter((id) => id !== device.id)); onSelectionChange();
        }} />
        <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-body">{device.name}</span>
        <span className="text-caption text-muted-foreground">{device.platform}</span>
      </label>)}
    </div>
    <div className="flex justify-end gap-2">
      <Button variant="outline" disabled={busy} onClick={onBack}>返回登录</Button>
      <Button disabled={busy || selected.length !== conflict.requiredReplacements} onClick={() => onConfirm(
        conflict.devices.filter((d) => selected.includes(d.id)).map(({ id, revision }) => ({ id, revision })),
      )}>{busy ? "登录中…" : "退出所选设备并登录"}</Button>
    </div>
  </div>;
}
