import { useCallback, useRef, useState } from "react";
import { ArrowLeft, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useClient } from "@/providers/ClientProvider";

interface PptPptxTemplateImportViewProps {
  onBack: () => void;
  onSaved: () => void;
}

export function PptPptxTemplateImportView({ onBack, onSaved }: PptPptxTemplateImportViewProps) {
  const { client } = useClient();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true);
    setError(null);

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      let handled = false;
      const timeout = setTimeout(() => {
        if (handled) return;
        handled = true;
        setUploading(false);
        setError("导入超时");
      }, 180_000);

      const unsub = client.onPptImportNativeResult((result) => {
        if (handled) return;
        handled = true;
        clearTimeout(timeout);
        unsub();

        if (result.ok) {
          setUploading(false);
          onSaved();
        } else {
          setUploading(false);
          setError(result.error || "导入失败");
        }
      });

      client.sendPptImportNative({
        name: file.name,
        data_url: dataUrl,
      });
    };
    reader.onerror = () => {
      setUploading(false);
      setError("文件读取失败");
    };
    reader.readAsDataURL(file);
  }, [client, onSaved]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h3 className="text-[13px] font-medium">
          自定义模板
        </h3>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-3">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".pptx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) handleUpload(file);
          }}
        />
        <button
          type="button"
          className="flex min-h-[120px] w-full items-center justify-center rounded-lg border border-dashed border-border/70 text-[12px] text-muted-foreground hover:border-border hover:bg-muted/30"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在导入并保存...
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              选择 PPTX 文件
            </>
          )}
        </button>
        <p className="text-[10px] text-muted-foreground">
          上传 PPTX 文件，系统将保留源 PPT 的页面结构，生成时按这些页面版式来做
        </p>
      </div>
    </div>
  );
}
