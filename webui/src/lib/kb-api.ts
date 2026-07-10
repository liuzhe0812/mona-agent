/** Knowledge base API client — talks to Mona gateway via websocket channel HTTP. */

import { getGatewayBaseUrl } from "./bootstrap"
import { httpFetch } from "./tauri"

let _kbBase: string | null = null
let _apiToken: string = ""

/** Set the API token for KB requests (obtained from bootstrap). */
export function setKbToken(token: string) {
  _apiToken = token
}

/** Get the current API token for KB requests. */
export function getKbToken(): string {
  return _apiToken
}

async function getBase(): Promise<string> {
  if (_kbBase) return _kbBase
  const gatewayBase = await getGatewayBaseUrl()
  _kbBase = gatewayBase
  return _kbBase
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const base = await getBase()
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (_apiToken) {
    headers["Authorization"] = `Bearer ${_apiToken}`
  }
  const resp = await httpFetch(`${base}${url}`, {
    headers,
    ...init,
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }))
    throw new Error(err.error ?? resp.statusText)
  }
  return resp.json()
}

// Projects
export interface KbProject {
  id: string
  name: string
  path: string
}

export const listProjects = async (): Promise<KbProject[]> => {
  const data = await fetchJSON<{ projects: KbProject[] }>("/api/kb/projects")
  return data.projects
}

export const createProject = async (name: string): Promise<KbProject> => {
  const data = await fetchJSON<KbProject>(
    `/api/kb/projects/create?name=${encodeURIComponent(name)}`,
  )
  return data
}

export const renameProject = async (id: string, name: string): Promise<KbProject> => {
  const data = await fetchJSON<KbProject>(
    `/api/kb/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`,
  )
  return data
}

// Files
export interface KbFile {
  path: string
  size: number
}

export const listFiles = async (id: string): Promise<KbFile[]> => {
  const data = await fetchJSON<{ files: KbFile[] }>(`/api/kb/${encodeURIComponent(id)}/files`)
  return data.files
}

export const deleteFile = (id: string, path: string) =>
  fetchJSON<{ deleted: string }>(
    `/api/kb/${encodeURIComponent(id)}/files/delete?path=${encodeURIComponent(path)}`,
  )

export interface CascadeDeleteResult {
  deletedSource: string
  deletedPages: string[]
}

export const cascadeDeleteSource = (id: string, path: string) =>
  fetchJSON<CascadeDeleteResult>(
    `/api/kb/${encodeURIComponent(id)}/source/cascade?path=${encodeURIComponent(path)}`,
  )

/** Import files by writing them via Tauri fs plugin directly to the project's raw directory. */
export const importFiles = async (_projectId: string, projectPath: string, files: File[]) => {
  const { writeFile, mkdir } = await import("@tauri-apps/plugin-fs")
  const rawDir = `${projectPath}/raw`
  await mkdir(rawDir, { recursive: true }).catch(() => {})
  const imported: string[] = []
  for (const file of files) {
    const destPath = `${rawDir}/${file.name}`
    const data = await file.arrayBuffer()
    await writeFile(destPath, new Uint8Array(data))
    imported.push(file.name)
  }
  return { imported }
}

// Wiki
export interface WikiPage {
  path: string
  title: string
  type: string
  tags: string[]
}

export interface WikiPageContent {
  path: string
  frontmatter: Record<string, unknown>
  body: string
  raw: string
}

export const listWikiPages = async (id: string): Promise<WikiPage[]> => {
  const data = await fetchJSON<{ pages: WikiPage[] }>(`/api/kb/${encodeURIComponent(id)}/wiki`)
  return data.pages
}

export const getWikiPage = (id: string, path: string) =>
  fetchJSON<WikiPageContent>(
    `/api/kb/${encodeURIComponent(id)}/wiki/${path.split("/").map(encodeURIComponent).join("/")}`,
  )

export const updateWikiPage = (id: string, path: string, content: string) =>
  fetchJSON<{ success: boolean }>(
    `/api/kb/${encodeURIComponent(id)}/wiki/update/${path.split("/").map(encodeURIComponent).join("/")}`,
    { method: "POST", body: JSON.stringify({ content }) },
  )

// Graph
export interface GraphNode {
  id: string
  path: string
  label: string
  type: string
  tags: string[]
  sources: string[]
}

export interface GraphEdge {
  source: string
  target: string
  type: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const getGraph = (id: string) =>
  fetchJSON<GraphData>(`/api/kb/${encodeURIComponent(id)}/graph`)

// Search
export interface SearchResult {
  path: string
  title: string
  type: string
  tags: string[]
  snippet: string
  score: number
}

export const searchKb = async (
  id: string,
  query: string,
  count = 10,
): Promise<{ mode: string; results: SearchResult[] }> => {
  const params = new URLSearchParams({
    q: query,
    count: String(count),
  })
  const data = await fetchJSON<{ mode: string; results: SearchResult[] }>(
    `/api/kb/${encodeURIComponent(id)}/search?${params}`,
  )
  return data
}

// Lint
export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks"
  severity: "warning" | "info"
  page: string
  detail: string
}

export const runLint = async (id: string): Promise<LintResult[]> => {
  const data = await fetchJSON<{ results: LintResult[] }>(
    `/api/kb/${encodeURIComponent(id)}/lint`,
  )
  return data.results
}

// Reviews
export interface ReviewItemData {
  id: string
  type: "contradiction" | "duplicate" | "missing-page" | "suggestion" | "confirm"
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: Array<{ label: string; action: string }>
  resolved: boolean
  resolvedAction?: string
  createdAt: number
}

export const getReviews = async (id: string): Promise<ReviewItemData[]> => {
  const data = await fetchJSON<{ items: ReviewItemData[] }>(`/api/kb/${encodeURIComponent(id)}/reviews`)
  return data.items
}

export const saveReviews = async (id: string, items: ReviewItemData[]) =>
  fetchJSON<{ success: boolean }>(
    `/api/kb/${encodeURIComponent(id)}/reviews/save`,
    { method: "POST", body: JSON.stringify({ items }) },
  )

// Embedding
export interface EmbedStatus {
  chunkCount: number
  lastError: string | null
}

export const triggerEmbed = async (id: string) =>
  fetchJSON<{ indexed: number; failed: number }>(
    `/api/kb/${encodeURIComponent(id)}/embed`,
    { method: "POST", body: JSON.stringify({}) },
  )

export const getEmbedStatus = async (id: string): Promise<EmbedStatus> =>
  fetchJSON<EmbedStatus>(`/api/kb/${encodeURIComponent(id)}/embed/status`)
