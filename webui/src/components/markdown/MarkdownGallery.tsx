import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ImageLightbox } from "@/components/ImageLightbox";
import type { UIImage } from "@/lib/types";

interface Entry { image: UIImage; element: HTMLElement }
const GalleryContext = createContext<{
  register: (id: string, entry: Entry) => () => void;
  open: (id: string) => void;
} | null>(null);
export const useMarkdownGallery = () => useContext(GalleryContext);

export function MarkdownGallery({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, Entry>());
  const [images, setImages] = useState<UIImage[]>([]);
  const [index, setIndex] = useState<number | null>(null);
  const register = useCallback((id: string, entry: Entry) => {
    entries.current.set(id, entry);
    return () => { entries.current.delete(id); };
  }, []);
  const open = useCallback((id: string) => {
    const ordered = [...entries.current].sort(([, a], [, b]) =>
      a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const selected = ordered.findIndex(([key]) => key === id);
    if (selected < 0) return;
    setImages(ordered.map(([, entry]) => entry.image)); setIndex(selected);
  }, []);
  const context = useMemo(() => ({ register, open }), [register, open]);
  return <GalleryContext.Provider value={context}>{children}
    {!!images.length && <ImageLightbox images={images} index={index} onIndexChange={setIndex} onOpenChange={(opened) => { if (!opened) setIndex(null); }} />}
  </GalleryContext.Provider>;
}
