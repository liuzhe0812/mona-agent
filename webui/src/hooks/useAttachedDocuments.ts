import { useCallback, useEffect, useRef, useState } from "react";

import { readFileAsDataUrl } from "@/components/doc/office/useDocDrop";
import { useClientContextOrNull } from "@/providers/ClientProvider";

type AttachmentSource = File | { name: string; localPath: string };

export interface AttachedDocument {
  name: string;
  path: string;
  size?: number;
}

export function useAttachedDocuments(chatId?: string | null, controlled?: AttachedDocument[], onChange?: (value: AttachedDocument[]) => void) {
  const client = useClientContextOrNull()?.client;
  const [localDocuments, setLocalDocuments] = useState<AttachedDocument[]>([]);
  const documents = controlled ?? localDocuments;
  const documentsRef = useRef(documents); documentsRef.current = documents;
  const controlledRef = useRef(controlled !== undefined); controlledRef.current = controlled !== undefined;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const setDocuments = useCallback((update: AttachedDocument[] | ((previous: AttachedDocument[]) => AttachedDocument[])) => {
    const value = typeof update === "function" ? update(documentsRef.current) : update;
    documentsRef.current = value;
    if (!controlledRef.current) setLocalDocuments(value);
    changeRef.current?.(value);
  }, []);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadIdRef = useRef<string | null>(null);

  const clear = useCallback(() => {
    uploadIdRef.current = null;
    setDocuments([]);
    setUploading(false);
    setError(null);
  }, []);

  useEffect(() => {
    uploadIdRef.current = null;
    setUploading(false);
    setError(null);
    if (!controlledRef.current) setLocalDocuments([]);
    return () => { uploadIdRef.current = null; };
  }, [chatId]);

  useEffect(() => client?.onDocUploadResult((result) => {
    if (!uploadIdRef.current || result.chatId !== uploadIdRef.current) return;
    uploadIdRef.current = null;
    setUploading(false);
    if (!result.ok) {
      setError(result.error ?? "文件上传失败");
      return;
    }
    setDocuments((current) => [...current, ...(result.files ?? [])]);
    setError(null);
  }), [client]);

  const add = useCallback(async (files: AttachmentSource[]) => {
    if (files.length === 0 || uploadIdRef.current) return;
    if (!client) {
      setError("连接尚未就绪，请稍后重试");
      return;
    }
    // An upload needs no conversation yet; a unique scope also isolates
    // simultaneous composers and late results after switching chats.
    const uploadId = `ephemeral:${crypto.randomUUID()}`;
    uploadIdRef.current = uploadId;
    setUploading(true);
    setError(null);
    try {
      const payload = await Promise.all(files.map(async (file) => {
        if ("localPath" in file) return { name: file.name, local_path: file.localPath };
        const localPath = (file as File & { path?: unknown }).path;
        if (typeof localPath === "string" && /^(?:[A-Za-z]:[\\/]|\/)/.test(localPath)) {
          return { name: file.name, local_path: localPath };
        }
        return { name: file.name, data_url: await readFileAsDataUrl(file) };
      }));
      if (uploadIdRef.current === uploadId) client.sendDocUpload(uploadId, payload);
    } catch (cause) {
      if (uploadIdRef.current !== uploadId) return;
      uploadIdRef.current = null;
      setUploading(false);
      setError(cause instanceof Error ? cause.message : "文件读取失败");
    }
  }, [client]);

  const remove = useCallback((path: string) => {
    setDocuments((current) => current.filter((document) => document.path !== path));
  }, []);

  return { documents, uploading, error, add, remove, clear };
}
