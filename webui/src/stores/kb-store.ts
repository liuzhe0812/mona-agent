import { create } from "zustand"
import * as api from "@/lib/kb-api"
import { getReviews, saveReviews } from "@/lib/kb-api"
import { ingestFiles, type IngestProgress } from "@/lib/ingest"
import {
  extractEntitySummaries,
  detectDuplicateGroups,
  mergeDuplicateGroup,
  type DuplicateGroup,
} from "@/lib/dedup"
import type {
  KbProject,
  KbFile,
  WikiPage,
  WikiPageContent,
  GraphData,
  EmbedStatus,
} from "@/lib/kb-api"
import { triggerEmbed, getEmbedStatus } from "@/lib/kb-api"

interface KbState {
  // Projects
  projects: KbProject[]
  currentProject: KbProject | null
  loading: boolean

  // Files
  files: KbFile[]

  // Wiki
  wikiPages: WikiPage[]
  currentWikiPage: WikiPageContent | null

  // Graph
  graphData: GraphData | null

  // Ingest
  ingesting: boolean
  ingestErrors: string[]
  ingestProgress: IngestProgress | null
  ingestAbortController: AbortController | null

  // Chat with Wiki
  selectedKbForChat: string | null

  // Dedup
  dedupGroups: DuplicateGroup[]

  // Embedding
  embedStatus: EmbedStatus | null
  embedding: boolean

  // Actions
  loadProjects: () => Promise<void>
  selectProject: (id: string) => Promise<void>
  createProject: (name: string) => Promise<void>
  renameProject: (name: string) => Promise<void>
  importFiles: (files: File[]) => Promise<void>
  deleteFile: (path: string) => Promise<void>
  triggerIngest: (file?: string) => Promise<void>
  cancelIngest: () => void
  loadWikiPage: (path: string) => Promise<void>
  loadGraph: () => Promise<void>
  setSelectedKbForChat: (id: string | null) => void
  runLint: () => Promise<void>
  runDedup: () => Promise<void>
  mergeGroup: (group: DuplicateGroup) => Promise<void>
  dismissGroup: (group: DuplicateGroup) => void
  persistReviews: () => Promise<void>
  loadEmbedStatus: () => Promise<void>
  triggerEmbed: () => Promise<{ indexed: number; failed: number } | undefined>
}

export const useKbStore = create<KbState>()((set, get) => ({
  projects: [],
  currentProject: null,
  loading: false,
  files: [],
  wikiPages: [],
  currentWikiPage: null,
  graphData: null,
  ingesting: false,
  ingestErrors: [],
  ingestProgress: null,
  ingestAbortController: null,
  selectedKbForChat: null,
  dedupGroups: [],
  embedStatus: null,
  embedding: false,

  loadProjects: async () => {
    set({ loading: true })
    try {
      const projects = await api.listProjects()
      set({ projects })
    } finally {
      set({ loading: false })
    }
  },

  selectProject: async (id: string) => {
    set({ loading: true })
    try {
      const project = get().projects.find((p) => p.id === id)
      if (!project) return
      set({ currentProject: project })
      const [files, wikiPages, graphData] = await Promise.all([
        api.listFiles(id).catch(() => []),
        api.listWikiPages(id).catch(() => []),
        api.getGraph(id).catch(() => null),
      ])
      set({ files, wikiPages, graphData, currentWikiPage: null })
      // Load persisted reviews
      try {
        const items = await getReviews(id)
        const { useReviewStore } = await import("@/stores/review-store")
        useReviewStore.getState().setItems(items as any)
      } catch {
        // Reviews not available yet, that's fine
      }
    } finally {
      set({ loading: false })
    }
  },

  createProject: async (name: string) => {
    const project = await api.createProject(name)
    set((s) => ({ projects: [...s.projects, project] }))
    await get().selectProject(project.id)
  },

  renameProject: async (name: string) => {
    const project = get().currentProject
    if (!project) return
    const updated = await api.renameProject(project.id, name)
    set((s) => ({
      projects: s.projects.map((p) => (p.id === project.id ? updated : p)),
      currentProject: updated,
    }))
  },

  importFiles: async (files: File[]) => {
    const project = get().currentProject
    if (!project) return
    await api.importFiles(project.id, project.path, files)
    const updated = await api.listFiles(project.id)
    set({ files: updated })
  },

  deleteFile: async (path: string) => {
    const project = get().currentProject
    if (!project) return
    await api.deleteFile(project.id, path)
    set((s) => ({ files: s.files.filter((f) => f.path !== path) }))
  },

  triggerIngest: async (file?: string) => {
    const project = get().currentProject
    if (!project) return

    // Cancel any previous ingest
    get().ingestAbortController?.abort()

    const abortController = new AbortController()
    set({
      ingesting: true,
      ingestErrors: [],
      ingestProgress: null,
      ingestAbortController: abortController,
    })

    try {
      // Get the list of files to ingest
      const filesToIngest = file
        ? [file]
        : get().files.map((f) => f.path)

      if (filesToIngest.length === 0) return

      // Run frontend ingest (calls LLM directly, writes pages via API)
      const result = await ingestFiles(
        project.id,
        filesToIngest,
        (progress) => {
          set({ ingestProgress: { ...progress } })
        },
        abortController.signal,
      )

      if (result.errors.length > 0) {
        console.error("KB ingest errors:", result.errors)
        set({ ingestErrors: result.errors })
      }

      // Store parsed REVIEW items in review-store
      if (result.reviews.length > 0) {
        const { useReviewStore } = await import("@/stores/review-store")
        useReviewStore.getState().addItems(
          result.reviews.map((r) => ({
            ...r,
            sourcePath: r.sourcePath,
          })),
        )
        // Persist all reviews to backend
        try {
          const allItems = useReviewStore.getState().items
          await saveReviews(project.id, allItems as any)
        } catch (err) {
          console.warn("[kb-store] Failed to persist reviews:", err)
        }
      }

      // Refresh wiki pages and graph after ingest completes
      const [wikiPages, graphData] = await Promise.all([
        api.listWikiPages(project.id).catch(() => []),
        api.getGraph(project.id).catch(() => null),
      ])
      set({ wikiPages, graphData })

      // Auto-embed after ingest using global embedding config
      try {
        await get().triggerEmbed()
      } catch (err) {
        console.warn("[kb] Auto-embed after ingest failed:", err)
      }
    } finally {
      set({ ingesting: false, ingestProgress: null, ingestAbortController: null })
    }
  },

  cancelIngest: () => {
    get().ingestAbortController?.abort()
    set({ ingesting: false, ingestProgress: null, ingestAbortController: null })
  },

  loadWikiPage: async (path: string) => {
    const project = get().currentProject
    if (!project) return
    const page = await api.getWikiPage(project.id, path)
    set({ currentWikiPage: page })
  },

  loadGraph: async () => {
    const project = get().currentProject
    if (!project) return
    const graphData = await api.getGraph(project.id)
    set({ graphData })
  },

  setSelectedKbForChat: (id) => set({ selectedKbForChat: id }),

  runLint: async () => {
    const project = get().currentProject
    if (!project) return

    const { useLintStore } = await import("@/stores/lint-store")
    useLintStore.getState().setRunning(true)
    useLintStore.getState().setResults([])

    try {
      const results = await api.runLint(project.id)
      useLintStore.getState().setResults(results)
    } finally {
      useLintStore.getState().setRunning(false)
    }
  },

  runDedup: async () => {
    const project = get().currentProject
    if (!project) return

    try {
      const pages = await api.listWikiPages(project.id)

      // Read page contents for entity/concept pages
      const pageContents = new Map<string, WikiPageContent>()
      for (const page of pages) {
        try {
          const content = await api.getWikiPage(project.id, page.path)
          pageContents.set(page.path, content)
        } catch {
          // skip unreadable pages
        }
      }

      const summaries = extractEntitySummaries(pages, pageContents)
      if (summaries.length < 2) {
        set({ dedupGroups: [] })
        return
      }

      // Fetch LLM config via the ingest helper pattern
      const { getGatewayBaseUrl } = await import("@/lib/bootstrap")
      const { getKbToken } = await import("@/lib/kb-api")
      const { httpFetch } = await import("@/lib/tauri")
      const baseUrl = await getGatewayBaseUrl()
      const token = getKbToken()
      const resp = await httpFetch(`${baseUrl}/api/kb/llm-config`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!resp.ok) throw new Error(`Failed to fetch LLM config: ${resp.status}`)
      const data = await resp.json()
      const llmConfig = {
        model: data.model,
        apiKey: data.apiKey,
        apiBase: data.apiBase,
        providerName: data.providerName,
      }

      const groups = await detectDuplicateGroups(summaries, llmConfig)
      set({ dedupGroups: groups })
    } catch (err) {
      console.error("[kb] runDedup failed:", err)
      set({ dedupGroups: [] })
    }
  },

  mergeGroup: async (group: DuplicateGroup) => {
    const project = get().currentProject
    if (!project) return

    // Read page contents for the group
    const pageContents = new Map<string, WikiPageContent>()
    for (const path of group.slugs) {
      try {
        const content = await api.getWikiPage(project.id, path)
        pageContents.set(path, content)
      } catch {
        // skip
      }
    }

    try {
      await mergeDuplicateGroup(project.id, group, pageContents)

      // Remove the merged group from the list
      set((s) => ({
        dedupGroups: s.dedupGroups.filter(
          (g) => g.slugs.join(",") !== group.slugs.join(","),
        ),
      }))

      // Refresh wiki pages and graph
      const [wikiPages, graphData] = await Promise.all([
        api.listWikiPages(project.id).catch(() => []),
        api.getGraph(project.id).catch(() => null),
      ])
      set({ wikiPages, graphData })
    } catch (err) {
      console.error("[kb] mergeGroup failed:", err)
    }
  },

  dismissGroup: (group: DuplicateGroup) => {
    set((s) => ({
      dedupGroups: s.dedupGroups.filter(
        (g) => g.slugs.join(",") !== group.slugs.join(","),
      ),
    }))
  },

  persistReviews: async () => {
    const project = get().currentProject
    if (!project) return
    try {
      const { useReviewStore } = await import("@/stores/review-store")
      const items = useReviewStore.getState().items
      await saveReviews(project.id, items as any)
    } catch (err) {
      console.warn("[kb-store] Failed to persist reviews:", err)
    }
  },

  loadEmbedStatus: async () => {
    const project = get().currentProject
    if (!project) return
    try {
      const status = await getEmbedStatus(project.id)
      set({ embedStatus: status })
    } catch {
      // ignore
    }
  },

  triggerEmbed: async () => {
    const project = get().currentProject
    if (!project) return
    set({ embedding: true })
    try {
      const result = await triggerEmbed(project.id)
      const status = await getEmbedStatus(project.id)
      set({ embedStatus: status, embedding: false })
      return result
    } catch (err) {
      set({ embedding: false })
      throw err
    }
  },
}))
