import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AttachedDocument } from "@/hooks/useAttachedDocuments";
import type { DevelopmentSendAttachments, DevMessage, DevSnapshot, FileDocument } from "@/lib/development-api";
import type { SubagentPreset } from "./workspace-api";
import type { PendingCollaboration } from "./collaboration-requests";
import type { StreamPreviewSource } from "./DevelopmentStreamContext";

export type WorkTab = "review" | "terminal" | "browser" | "workspace" | "sidechat" | "subagents" | "agent";
export interface ProjectView { sessionId: string | null }
export interface SideState { expanded: boolean; tab: WorkTab | "overview"; maximized: boolean; openTabs: WorkTab[]; overviewOpen?: boolean; agentSessionId?: string; approvalDecisionId?: string; terminalMode?: "user" | "agent"; deviceSize?: { width: number; height: number } }
export interface FileBuffer { file: FileDocument; draft: string }
export interface TerminalState { id?: string; status: "opening" | "ready" | "closing" | "exited" | "error"; error?: string }
interface PendingSend { id: string; content: string; uncertain: boolean; intent?: "steering" | "follow_up"; targetRunId?: string; docPaths?: string[]; documentNames?: string[] }
interface DevelopmentState {
  projectId: string | null;
  views: Record<string, ProjectView>;
  drafts: Record<string, string>;
  documentDrafts: Record<string, AttachedDocument[]>;
  setDocumentDraft: (session: string, value: AttachedDocument[]) => void;
  sides: Record<string, SideState>;
  snapshots: Record<string, DevSnapshot>;
  errors: Record<string, string>;
  sends: Record<string, PendingSend>;
  files: Record<string, FileBuffer>;
  selectedFiles: Record<string, string>;
  streamPreviews: Record<string, StreamPreviewSource>;
  setStreamPreview: (session: string, source: StreamPreviewSource | null) => void;
  terminals: Record<string, TerminalState>;
  browserTabs: Record<string, string>;
  sideChats: Record<string, string>;
  subagentDrafts: Record<string, SubagentPreset>;
  collaborationRequests: Record<string, PendingCollaboration>;
  setCollaborationRequest: (key: string, value: PendingCollaboration | null) => void;
  setSubagentDraft: (project: string, draft: SubagentPreset | null) => void;
  selectProject: (id: string) => void;
  openSession: (project: string, session: string | null) => void;
  closeSideTab: (session: string, tab: WorkTab | "overview") => void;
  scrollOffsets: Record<string, number>;
  setScroll: (session: string, offset: number) => void;
  setDraft: (session: string, draft: string) => void;
  appendDraft: (session: string, text: string) => void;
  setSide: (session: string, value: Partial<SideState>) => void;
  setSnapshot: (session: string, value: DevSnapshot, older?: boolean) => void;
  setError: (session: string, error: string) => void;
  setSend: (session: string, value: PendingSend | null) => void;
  forgetSession: (session: string) => void;
  loadFile: (session: string, file: FileDocument) => void;
  editFile: (session: string, path: string, text: string) => void;
  setTerminal: (session: string, value: TerminalState | null) => void;
  setBrowser: (session: string, tab: string) => void;
  setSideChat: (session: string, child: string) => void;
}
export const EMPTY_VIEW: ProjectView = { sessionId: null };
export const EMPTY_DOCUMENTS: AttachedDocument[] = [];
export function attachmentDraft(source?: DevelopmentSendAttachments | null): AttachedDocument[] {
  return (source?.docPaths ?? []).map((path, index) => ({ path, name: source?.documentNames?.[index] || path.split(/[\\/]/).pop() || path }));
}
export const EMPTY_SIDE: SideState = { expanded: false, tab: "overview", maximized: false, openTabs: [] };

// Only view bindings change; task histories, drafts and pending sends are retained.
export function migrateDevelopmentViews(saved: unknown): Partial<DevelopmentState> {
  if (!saved || typeof saved !== "object") return {};
  const state = saved as Record<string, unknown>;
  const views = Object.fromEntries(Object.entries((state.views ?? {}) as Record<string, Record<string, unknown>>).map(([id, value]) => {
    const panes = Array.isArray(value.panes) ? value.panes : [];
    const selected = value.sessionId ?? panes[Number(value.focus) || 0] ?? panes[0];
    return [id, { sessionId: typeof selected === "string" ? selected : null }];
  }));
  const sides = Object.fromEntries(Object.entries((state.sides ?? {}) as Record<string, SideState>).map(([id, value]) => [id, {
    ...EMPTY_SIDE, ...value, openTabs: value.openTabs ?? (value.tab && value.tab !== "overview" ? [value.tab] : []),
  }]));
  return { ...state, views, sides } as Partial<DevelopmentState>;
}
export const fileKey = (session: string, path: string) => JSON.stringify([session, path]);

function sameMessage(a: DevMessage, b: DevMessage): boolean {
  const { toolCalls: left, media: leftMedia = [], ...leftFields } = a;
  const { toolCalls: right, media: rightMedia = [], ...rightFields } = b;
  return Object.keys({ ...leftFields, ...rightFields }).every((key) =>
    leftFields[key as keyof typeof leftFields] === rightFields[key as keyof typeof rightFields])
    && leftMedia.length === rightMedia.length && leftMedia.every((item, index) => item.kind === rightMedia[index].kind && item.url === rightMedia[index].url && item.name === rightMedia[index].name)
    && left.length === right.length && left.every((call, index) => call.id === right[index].id
      && call.function.name === right[index].function.name && call.function.arguments === right[index].function.arguments);
}

export const useDevelopmentStore = create<DevelopmentState>()(persist((set, get) => ({
  projectId: null, views: {}, drafts: {}, documentDrafts: {}, sides: {}, snapshots: {}, errors: {}, sends: {}, files: {}, selectedFiles: {}, streamPreviews: {}, terminals: {}, browserTabs: {}, sideChats: {}, scrollOffsets: {}, subagentDrafts: {}, collaborationRequests: {},
  setStreamPreview: (session, source) => set((state) => {
    const streamPreviews = { ...state.streamPreviews };
    if (source) streamPreviews[session] = source; else delete streamPreviews[session];
    return { streamPreviews };
  }),
  selectProject: (projectId) => set({ projectId }),
  openSession: (project, sessionId) => set((state) => ({ projectId: project, views: { ...state.views, [project]: { sessionId } } })),
  setCollaborationRequest: (key, value) => set((state) => {
    const collaborationRequests = { ...state.collaborationRequests };
    if (value) collaborationRequests[key] = value; else delete collaborationRequests[key];
    return { collaborationRequests };
  }),
  setSubagentDraft: (project, draft) => set((state) => {
    const subagentDrafts = { ...state.subagentDrafts };
    if (draft) subagentDrafts[project] = draft; else delete subagentDrafts[project];
    return { subagentDrafts };
  }),
  setScroll: (session, offset) => set((state) => ({ scrollOffsets: { ...state.scrollOffsets, [session]: offset } })),
  closeSideTab: (session, tab) => set((state) => {
    const side = state.sides[session] ?? EMPTY_SIDE;
    const openTabs = side.openTabs.filter((id) => id !== tab);
    const overviewOpen = tab !== "overview" && side.overviewOpen !== false;
    const empty = !overviewOpen && !openTabs.length;
    return { sides: { ...state.sides, [session]: { ...side, openTabs, overviewOpen,
      tab: side.tab === tab ? overviewOpen ? "overview" : openTabs[0] ?? "overview" : side.tab,
      expanded: empty ? false : side.expanded, maximized: empty ? false : side.maximized } } };
  }),
  setDocumentDraft: (session, value) => set((state) => ({ documentDrafts: { ...state.documentDrafts, [session]: value } })),
  setDraft: (session, draft) => set((state) => ({ drafts: { ...state.drafts, [session]: draft } })),
  appendDraft: (session, text) => get().setDraft(session, [get().drafts[session], text].filter(Boolean).join("\n\n")),
  setSide: (session, value) => set((state) => {
    const side = { ...(state.sides[session] ?? EMPTY_SIDE), ...value };
    if (value.tab === "overview" || (value.expanded && !side.openTabs.length && !value.tab)) side.overviewOpen = true;
    if (value.tab && value.tab !== "overview" && !side.openTabs.includes(value.tab)) side.openTabs = [...side.openTabs, value.tab];
    return { sides: { ...state.sides, [session]: side } };
  }),
  setSnapshot: (session, value, older = false) => set((state) => {
    if (value.session.id !== session) return state;
    const old = state.snapshots[session];
    if (!older && old && (value.session.revision < old.session.revision || value.eventCursor < old.eventCursor || value.messageCount < old.messageCount)) return state;
    const existing = new Map(old?.messages.map((message) => [message.id, message]));
    const incoming = value.messages.map((message) => {
      const previous = existing.get(message.id);
      return previous && sameMessage(previous, message) ? previous : message;
    });
    const currentIds = new Set(incoming.map((m) => m.id));
    const retained = old?.messages.filter((m) => !currentIds.has(m.id) && !m.queued) ?? [];
    const messages = older
      ? [...new Map([...incoming, ...(old?.messages ?? [])].map((m) => [m.id, m])).values()]
      : [...retained, ...incoming].slice(-Math.max(100, old?.messages.length ?? 0));
    const result = older && old ? { ...old, messages, before: value.before } : {
      ...value, messages, before: value.before == null ? null : Math.max(0, value.before - Math.max(0, messages.length - value.messages.length)) || null,
    };
    if (old && old.messages.length === result.messages.length && result.messages.every((message, index) => message === old.messages[index])) result.messages = old.messages;
    if (!older) {
      const priorEvents = new Map(old?.events.map((event) => [event.id, event]));
      result.events = [...new Map([...(old?.events ?? []), ...value.events.map((event) => priorEvents.get(event.id) ?? event)].map((event) => [event.id, event])).values()];
      if (old && old.events.length === result.events.length && result.events.every((event, index) => event === old.events[index])) result.events = old.events;
    }
    return { snapshots: { ...state.snapshots, [session]: result }, errors: { ...state.errors, [session]: "" } };
  }),
  setError: (session, error) => set((state) => ({ errors: { ...state.errors, [session]: error } })),
  setSend: (session, value) => set((state) => { const sends = { ...state.sends }; if (value) sends[session] = value; else delete sends[session]; return { sends }; }),
  forgetSession: (session) => set((state) => {
    const omit = <T>(source: Record<string, T>) => { const next = { ...source }; delete next[session]; return next; };
    const files = Object.fromEntries(Object.entries(state.files).filter(([key]) => {
      try { return JSON.parse(key)[0] !== session; } catch { return true; }
    }));
    const sideChats = Object.fromEntries(Object.entries(state.sideChats).filter(([parent, child]) => parent !== session && child !== session));
    return {
      snapshots: omit(state.snapshots), drafts: omit(state.drafts), documentDrafts: omit(state.documentDrafts), sides: omit(state.sides), errors: omit(state.errors),
      sends: omit(state.sends), selectedFiles: omit(state.selectedFiles), streamPreviews: omit(state.streamPreviews), terminals: omit(state.terminals),
      browserTabs: omit(state.browserTabs), sideChats, scrollOffsets: omit(state.scrollOffsets), files,
    };
  }),
  loadFile: (session, file) => set((state) => ({ files: { ...state.files, [fileKey(session, file.path)]: { file, draft: file.content } }, selectedFiles: { ...state.selectedFiles, [session]: file.path } })),
  editFile: (session, path, text) => set((state) => { const key = fileKey(session, path); const old = state.files[key]; return old ? { files: { ...state.files, [key]: { ...old, draft: text } } } : state; }),
  setTerminal: (session, value) => set((state) => {
    const terminals = { ...state.terminals };
    if (value) terminals[session] = value; else delete terminals[session];
    return { terminals };
  }),
  setBrowser: (session, tab) => set((state) => ({ browserTabs: { ...state.browserTabs, [session]: tab } })),
  setSideChat: (session, child) => set((state) => ({ sideChats: { ...state.sideChats, [session]: child } })),
}), {
  name: "mona.development.workbench.v1", version: 2, storage: createJSONStorage(() => localStorage),
  migrate: (saved) => migrateDevelopmentViews(saved),
  partialize: (state) => ({ projectId: state.projectId, views: state.views, drafts: state.drafts, documentDrafts: state.documentDrafts,
    sides: state.sides, sends: state.sends, files: state.files, selectedFiles: state.selectedFiles, sideChats: state.sideChats, subagentDrafts: state.subagentDrafts, collaborationRequests: state.collaborationRequests }),
}));
