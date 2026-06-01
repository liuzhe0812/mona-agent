import { create } from "zustand";
import type { DeliveredFile } from "@/lib/types";

interface FilePreviewState {
  file: DeliveredFile | null;
  splitRatio: number;
  open: (file: DeliveredFile) => void;
  close: () => void;
  setSplitRatio: (ratio: number) => void;
}

export const useFilePreviewStore = create<FilePreviewState>((set) => ({
  file: null,
  splitRatio: 0.45,
  open: (file) => set({ file }),
  close: () => set({ file: null }),
  setSplitRatio: (splitRatio) => set({ splitRatio }),
}));
