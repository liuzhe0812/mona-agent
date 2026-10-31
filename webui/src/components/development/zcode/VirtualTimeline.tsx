// Modified for local integration. See the accompanying NOTICE for license information.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { splitConversationTimelineLiveTail } from "./conversationTimelineLiveTail";
import { DEFAULT_ROW_HEIGHT_ESTIMATE_PX, TimelineRowHeightCache } from "./timelineRowHeightCache";
import { prependVirtualAnchorAdjustment, shouldAdjustVirtualizerForItemSizeChange, type PrependVirtualAnchor } from "./timelineScrollAnchor";

export interface TimelineUnit { key: string; isRunning: boolean; messageIds: string[]; content: ReactNode }
export interface TimelineNavigation {
  scrollToMessage: (id: string) => boolean;
  capturePrependAnchor: () => boolean;
}
function measureRowHeight(element: Element, entry: ResizeObserverEntry | undefined): number {
  const boxSize = entry?.borderBoxSize?.[0];
  if (boxSize) return Math.round(boxSize.blockSize);
  return Math.round(element.getBoundingClientRect().height);
}

export function VirtualTimeline({ units, scrollRef, followingRef, navigationRef, onLayoutScroll, restoringRef }: {
  units: TimelineUnit[]; scrollRef: RefObject<HTMLDivElement | null>; followingRef: RefObject<boolean>;
  navigationRef?: RefObject<TimelineNavigation | null>;
  onLayoutScroll?: (element: HTMLDivElement) => void;
  restoringRef?: RefObject<boolean>;
}) {
  const { virtualizedUnits, liveUnit, liveUnitIndex } = splitConversationTimelineLiveTail(units);
  const virtualizedUnitsRef = useRef(virtualizedUnits);
  virtualizedUnitsRef.current = virtualizedUnits;
  const root = useRef<HTMLDivElement>(null);
  const liveTailRef = useRef<HTMLDivElement>(null);
  const heightCacheRef = useRef(new TimelineRowHeightCache());
  const pendingAnchorRef = useRef<PrependVirtualAnchor | null>(null);
  const pendingMessageRef = useRef<string | null>(null);
  const contentWidthChangingUntilRef = useRef(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [headerSlotHeight, setHeaderSlotHeight] = useState(0);
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef]);
  const getItemKey = useCallback((index: number) => virtualizedUnitsRef.current[index]?.key ?? index, []);
  const estimateSize = useCallback((index: number) => heightCacheRef.current.estimate(
    virtualizedUnitsRef.current[index]?.key, DEFAULT_ROW_HEIGHT_ESTIMATE_PX), []);
  const measureElement = useCallback((element: Element, entry: ResizeObserverEntry | undefined) => {
    const height = measureRowHeight(element, entry);
    const indexAttr = element.getAttribute("data-index");
    const unit = indexAttr === null ? undefined : virtualizedUnitsRef.current[Number(indexAttr)];
    if (unit) heightCacheRef.current.set(unit.key, height);
    return height;
  }, []);
  const virtualizer = useVirtualizer({ count: virtualizedUnits.length, getScrollElement,
    estimateSize, overscan: 8, getItemKey, measureElement, scrollMargin: headerSlotHeight,
    enabled: viewportHeight > 0 });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => shouldAdjustVirtualizerForItemSizeChange({
    suppressAdjustment: pendingAnchorRef.current !== null || restoringRef?.current === true, following: followingRef.current,
    contentWidthChanging: Date.now() < contentWidthChangingUntilRef.current,
    itemEnd: item.end, scrollTop: scrollRef.current?.scrollTop ?? 0,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const element = liveTailRef.current;
    const cacheKey = liveUnit?.key;
    if (!element || cacheKey === undefined) return;
    const cacheHeight = (entry?: ResizeObserverEntry) => heightCacheRef.current.set(cacheKey, measureRowHeight(element, entry));
    cacheHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => cacheHeight(entries[0]));
    observer.observe(element);
    return () => observer.disconnect();
  }, [liveUnit?.key, viewportHeight]);
  useEffect(() => {
    const element = scrollRef.current;
    const column = root.current;
    if (!element || !column) return;
    let width = element.clientWidth;
    const update = () => {
      if (element.clientWidth !== width) { width = element.clientWidth; contentWidthChangingUntilRef.current = Date.now() + 120; }
      setViewportHeight(element.clientHeight);
      setHeaderSlotHeight(column.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element); observer.observe(column);
    return () => observer.disconnect();
  }, [scrollRef]);
  const firstKey = units[0]?.key;
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current, element = scrollRef.current;
    if (!anchor || !element || restoringRef?.current) return;
    const measurement = virtualizer.measurementsCache.find((item) => item.key === anchor.key);
    if (!measurement) return;
    const delta = prependVirtualAnchorAdjustment(anchor, { key: anchor.key, start: measurement.start,
      offsetTop: measurement.start - element.scrollTop }, element.scrollTop);
    if (delta !== null) { element.scrollTop += delta; onLayoutScroll?.(element); }
    pendingAnchorRef.current = null;
  }, [firstKey, scrollRef, virtualizer, onLayoutScroll, restoringRef]);
  useLayoutEffect(() => {
    if (!navigationRef) return;
    const api: TimelineNavigation = {
      capturePrependAnchor: () => {
        const element = scrollRef.current;
        if (!element || viewportHeight <= 0 || restoringRef?.current) return false;
        const measurement = virtualizer.getVirtualItemForOffset(element.scrollTop);
        const unit = measurement ? virtualizedUnitsRef.current[measurement.index] : undefined;
        pendingAnchorRef.current = measurement && unit?.key === measurement.key
          ? { key: unit.key, offsetTop: measurement.start - element.scrollTop, start: measurement.start } : null;
        return pendingAnchorRef.current !== null;
      },
      scrollToMessage: (id) => {
        const index = units.findIndex((unit) => unit.messageIds.includes(id));
        if (index < 0) return false;
        pendingMessageRef.current = id;
        if (liveUnitIndex === index && scrollRef.current) scrollRef.current.scrollTop = headerSlotHeight + totalSize;
        else virtualizer.scrollToIndex(index, { align: "start" });
        return true;
      },
    };
    navigationRef.current = api;
    return () => { if (navigationRef.current === api) navigationRef.current = null; };
  }, [units, virtualizer, navigationRef, scrollRef, liveUnitIndex, headerSlotHeight, totalSize, viewportHeight, restoringRef]);
  useLayoutEffect(() => {
    const id = pendingMessageRef.current, element = scrollRef.current;
    if (!id || !element) return;
    const anchor = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find((node) => node.dataset.messageId === id);
    if (!anchor) return;
    element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - 16;
    onLayoutScroll?.(element);
    pendingMessageRef.current = null;
  }, [virtualRows, scrollRef, onLayoutScroll]);
  if (viewportHeight <= 0) return <div ref={root}>{units.map((unit) => <div key={unit.key}>{unit.content}</div>)}</div>;
  return <div ref={root}>
    <div className="relative mx-auto w-full shrink-0" style={{ height: totalSize }}>
      {virtualRows.map((virtualRow) => {
        const unit = virtualizedUnits[virtualRow.index];
        if (!unit) return null;
        return <div key={virtualRow.key} ref={virtualizer.measureElement} data-index={virtualRow.index}
          data-v4-turn-unit="true" data-turn-id={unit.key} className="absolute left-0 top-0 w-full"
          style={{ transform: `translateY(${virtualRow.start - headerSlotHeight}px)` }}>{unit.content}</div>;
      })}
    </div>
    {liveUnit !== null && liveUnitIndex !== null && <div key={liveUnit.key} ref={liveTailRef} data-index={liveUnitIndex}
      data-v4-running-live-tail="true" data-v4-turn-unit="true" data-turn-id={liveUnit.key}
      className="relative mx-auto w-full shrink-0">{liveUnit.content}</div>}
  </div>;
}
