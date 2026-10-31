// Modified for local integration. See the accompanying NOTICE for license information.
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent, type WheelEvent as ReactWheelEvent } from "react";
import { anchorActionAfterContentChange, historyPrefetchTriggerPx, initialFollowing,
  reconcileFollowingForContentAnchor, resolveFollowingAfterScroll, shouldShowBackToBottom,
  shouldTriggerLoadOlder, timelineKeyboardScrollIntent, timelineTouchScrollIntent,
  timelineWheelScrollIntent, type TimelineUserScrollIntent } from "./timelineScrollAnchor";
import { readChatSessionScrollMemoryState, resolveChatSessionScrollRestoreTop, saveChatSessionScrollMemoryState } from "./chatSessionScrollMemory";
import { canReleasePendingScrollMemoryRestore, resolvePendingScrollMemoryRestoreWait, type PendingScrollMemoryRestore } from "./scrollMemoryRestore";

const USER_SCROLL_INTENT_TTL_MS = 1200;
const LAYOUT_SCROLL_GUARD_MS = 250;
const CONTENT_WIDTH_RESIZE_SETTLE_MS = 120;
function isEditableScrollTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

export function useTimelineScroll({ scrollRef, contentRef, followingRef, sessionKey, visible, rowCount, revision, rowWindowKey = String(rowCount), onFollowingChange, canLoadOlder, loadingOlder, onLoadOlder }: {
  scrollRef: RefObject<HTMLDivElement | null>; contentRef: RefObject<HTMLDivElement | null>; followingRef: RefObject<boolean>;
  sessionKey: string | null; visible: boolean; rowCount: number; revision: unknown;
  rowWindowKey?: string;
  onFollowingChange: (showBackToBottom: boolean) => void; canLoadOlder: boolean;
  loadingOlder: RefObject<boolean>; onLoadOlder: () => void;
}) {
  const current = useRef({ rowCount, rowWindowKey, onFollowingChange, canLoadOlder, onLoadOlder });
  current.current = { rowCount, rowWindowKey, onFollowingChange, canLoadOlder, onLoadOlder };
  const pendingRestoreRef = useRef<PendingScrollMemoryRestore | null>(null);
  const restoringRef = useRef(false);
  const lastObservedScrollTopRef = useRef(0);
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const layoutScrollGuardUntilRef = useRef(0);
  const userScrollIntentRef = useRef<{ intent: TimelineUserScrollIntent; observedAt: number }>({ intent: "none", observedAt: 0 });
  const touchClientYRef = useRef<number | null>(null);
  const scrollbarPointerIdRef = useRef<number | null>(null);
  const contentWidthChangingUntilRef = useRef(0);
  const restoredRef = useRef(false);
  const markProgrammaticScroll = useCallback(() => {
    if (programmaticScrollFrameRef.current !== null) window.cancelAnimationFrame(programmaticScrollFrameRef.current);
    programmaticScrollFrameRef.current = window.requestAnimationFrame(() => { programmaticScrollFrameRef.current = null; });
  }, []);
  const commitFollowing = useCallback((following: boolean) => {
    if (followingRef.current === following) return;
    followingRef.current = following;
    current.current.onFollowingChange(shouldShowBackToBottom(following, current.current.rowCount));
  }, [followingRef]);
  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = { intent: "none", observedAt: 0 };
    touchClientYRef.current = null; scrollbarPointerIdRef.current = null;
  }, []);
  const getActiveUserScrollIntent = useCallback((): TimelineUserScrollIntent => {
    const state = userScrollIntentRef.current;
    const interactionActive = touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null;
    if (interactionActive) return state.intent === "none" ? "unknown" : state.intent;
    return Date.now() - state.observedAt <= USER_SCROLL_INTENT_TTL_MS ? state.intent : "none";
  }, []);
  const markLayoutScrollGuard = useCallback(() => { layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS; }, []);
  const markUserScrollIntent = useCallback((intent: TimelineUserScrollIntent) => {
    if (intent === "none") return;
    userScrollIntentRef.current = { intent, observedAt: Date.now() };
    pendingRestoreRef.current = null; restoringRef.current = false;
    const element = scrollRef.current;
    if (intent === "awayFromBottom" && element && element.scrollHeight > element.clientHeight) commitFollowing(false);
  }, [commitFollowing, scrollRef]);
  const saveCurrentScrollMemory = useCallback(() => {
    const element = scrollRef.current;
    if (pendingRestoreRef.current?.key === sessionKey) {
      saveChatSessionScrollMemoryState(sessionKey, pendingRestoreRef.current.state);
      return;
    }
    if (element) saveChatSessionScrollMemoryState(sessionKey, { scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, wasPinnedToBottom: followingRef.current, updatedAt: Date.now() });
  }, [sessionKey, scrollRef, followingRef]);
  const recordLayoutScroll = useCallback((element: HTMLDivElement) => {
    markLayoutScrollGuard();
    lastObservedScrollTopRef.current = element.scrollTop;
    saveCurrentScrollMemory();
    const notify = () => { if (scrollRef.current === element) element.dispatchEvent(new Event("scroll")); };
    if (typeof globalThis.queueMicrotask === "function") globalThis.queueMicrotask(notify);
    else void Promise.resolve().then(notify);
  }, [markLayoutScrollGuard, saveCurrentScrollMemory, scrollRef]);
  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    markProgrammaticScroll(); element.scrollTop = element.scrollHeight;
    lastObservedScrollTopRef.current = element.scrollTop;
    recordLayoutScroll(element);
  }, [markProgrammaticScroll, recordLayoutScroll, scrollRef]);
  const handleBackToBottom = useCallback(() => {
    pendingRestoreRef.current = null; restoringRef.current = false;
    clearUserScrollIntent(); commitFollowing(true); scrollToBottom(); saveCurrentScrollMemory();
  }, [clearUserScrollIntent, commitFollowing, scrollToBottom, saveCurrentScrollMemory]);
  const detachForNavigation = useCallback(() => {
    pendingRestoreRef.current = null; restoringRef.current = false;
    clearUserScrollIntent(); commitFollowing(false); markProgrammaticScroll();
  }, [clearUserScrollIntent, commitFollowing, markProgrammaticScroll]);
  const anchorContent = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    markLayoutScrollGuard();
    const pending = pendingRestoreRef.current;
    if (pending) {
      markProgrammaticScroll(); element.scrollTop = resolveChatSessionScrollRestoreTop(pending.state, element);
      lastObservedScrollTopRef.current = element.scrollTop;
      commitFollowing(false);
      if (canReleasePendingScrollMemoryRestore(pending, element, current.current.rowCount, current.current.canLoadOlder, current.current.rowWindowKey)) {
        pendingRestoreRef.current = null; restoringRef.current = false;
      }
      recordLayoutScroll(element);
      return;
    }
    const following = reconcileFollowingForContentAnchor({ following: followingRef.current,
      metrics: { scrollTop: element.scrollTop, viewportHeight: element.clientHeight, contentHeight: element.scrollHeight },
      lastObservedScrollTop: lastObservedScrollTopRef.current, userScrollIntent: getActiveUserScrollIntent() });
    commitFollowing(following);
    if (anchorActionAfterContentChange(following, Date.now() < contentWidthChangingUntilRef.current) === "stickToBottom") scrollToBottom();
  }, [scrollRef, followingRef, markLayoutScrollGuard, getActiveUserScrollIntent, commitFollowing, scrollToBottom, markProgrammaticScroll, recordLayoutScroll]);
  useLayoutEffect(() => {
    restoredRef.current = false; followingRef.current = initialFollowing(); current.current.onFollowingChange(false); clearUserScrollIntent();
    pendingRestoreRef.current = null; restoringRef.current = false;
    const saved = readChatSessionScrollMemoryState(sessionKey);
    const waitFor = resolvePendingScrollMemoryRestoreWait(saved, scrollRef.current, current.current.rowCount > 0);
    if (sessionKey && saved && waitFor) {
      pendingRestoreRef.current = { key: sessionKey, state: saved, waitFor, rowWindowKey: current.current.rowWindowKey };
      restoringRef.current = true;
    }
  }, [sessionKey, visible, followingRef, clearUserScrollIntent, scrollRef]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!visible || !element || !rowCount) return;
    if (!restoredRef.current) {
      const saved = readChatSessionScrollMemoryState(sessionKey);
      if (saved && saved.wasPinnedToBottom !== true) {
        markProgrammaticScroll(); element.scrollTop = resolveChatSessionScrollRestoreTop(saved, element);
        lastObservedScrollTopRef.current = element.scrollTop;
        commitFollowing(false);
      }
      restoredRef.current = true;
    }
    anchorContent();
  }, [sessionKey, visible, rowCount, revision, scrollRef, anchorContent, commitFollowing, markProgrammaticScroll]);
  useEffect(() => {
    const element = contentRef.current;
    if (!visible || !element || typeof ResizeObserver === "undefined") return;
    let observedWidth = element.getBoundingClientRect().width;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth !== observedWidth) {
        observedWidth = nextWidth; contentWidthChangingUntilRef.current = Date.now() + CONTENT_WIDTH_RESIZE_SETTLE_MS;
        clearTimeout(settleTimer); settleTimer = setTimeout(anchorContent, CONTENT_WIDTH_RESIZE_SETTLE_MS);
      }
      anchorContent();
    });
    observer.observe(element);
    return () => { observer.disconnect(); clearTimeout(settleTimer); };
  }, [sessionKey, visible, contentRef, anchorContent]);
  useEffect(() => () => { if (programmaticScrollFrameRef.current !== null) window.cancelAnimationFrame(programmaticScrollFrameRef.current); }, []);
  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const programmaticScroll = programmaticScrollFrameRef.current !== null && Math.abs(element.scrollTop - lastObservedScrollTopRef.current) < 1;
    const intent = getActiveUserScrollIntent();
    const source = intent !== "none" ? "user" : programmaticScroll ? "programmatic" : Date.now() <= layoutScrollGuardUntilRef.current ? "layout" : "user";
    lastObservedScrollTopRef.current = element.scrollTop;
    commitFollowing(resolveFollowingAfterScroll({ following: followingRef.current, source,
      metrics: { scrollTop: element.scrollTop, viewportHeight: element.clientHeight, contentHeight: element.scrollHeight } }));
    if (source === "user") { pendingRestoreRef.current = null; restoringRef.current = false; saveCurrentScrollMemory(); }
    if (shouldTriggerLoadOlder({ scrollTop: element.scrollTop, canLoadOlder: current.current.canLoadOlder,
      loadingOlder: loadingOlder.current, triggerPx: historyPrefetchTriggerPx(element.clientHeight) })) current.current.onLoadOlder();
  }, [scrollRef, followingRef, loadingOlder, commitFollowing, getActiveUserScrollIntent, saveCurrentScrollMemory]);
  return { handleBackToBottom, detachForNavigation, recordLayoutScroll, restoringRef, props: {
    onScroll: handleScroll,
    onWheelCapture: (event: ReactWheelEvent<HTMLDivElement>) => markUserScrollIntent(timelineWheelScrollIntent(event.deltaY)),
    onTouchStartCapture: (event: ReactTouchEvent<HTMLDivElement>) => { touchClientYRef.current = event.touches[0]?.clientY ?? null; },
    onTouchMoveCapture: (event: ReactTouchEvent<HTMLDivElement>) => {
      const next = event.touches[0]?.clientY; const previous = touchClientYRef.current;
      if (next === undefined || previous === null) return;
      markUserScrollIntent(timelineTouchScrollIntent(previous, next)); touchClientYRef.current = next;
    },
    onTouchEndCapture: () => { touchClientYRef.current = null; },
    onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => markUserScrollIntent(timelineKeyboardScrollIntent({ key: event.key, shiftKey: event.shiftKey, editableTarget: isEditableScrollTarget(event.target) })),
    onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => { if (event.target !== event.currentTarget) return; scrollbarPointerIdRef.current = event.pointerId; markUserScrollIntent("unknown"); },
    onPointerUpCapture: (event: ReactPointerEvent<HTMLDivElement>) => { if (scrollbarPointerIdRef.current === event.pointerId) scrollbarPointerIdRef.current = null; },
    onPointerCancelCapture: () => { scrollbarPointerIdRef.current = null; },
  } };
}
