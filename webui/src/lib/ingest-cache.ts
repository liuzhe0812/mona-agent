/**
 * SHA256-based ingest cache — ported from llm_wiki src/lib/ingest-cache.ts
 * Stores hash of source file content → skips re-ingest if unchanged.
 * Cache file: .llm-wiki/ingest-cache.json
 *
 * Adapted: uses Mona's KB API for file I/O instead of Tauri commands.
 */

import { getKbToken } from "@/lib/kb-api"
import { getGatewayBaseUrl } from "@/lib/bootstrap"
import { httpFetch } from "@/lib/tauri"

interface CacheEntry {
  hash: string
  timestamp: number
  filesWritten: string[]
}

interface CacheData {
  entries: Record<string, CacheEntry>
}

async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function readFileViaApi(projectId: string, relPath: string): Promise<string> {
  const baseUrl = await getGatewayBaseUrl()
  const token = getKbToken()
  const resp = await httpFetch(
    `${baseUrl}/api/kb/${encodeURIComponent(projectId)}/files/read?path=${encodeURIComponent(relPath)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!resp.ok) throw new Error(`Failed to read ${relPath}: ${resp.status}`)
  const data = await resp.json()
  return data.content ?? ""
}

async function writeFileViaApi(projectId: string, relPath: string, content: string): Promise<void> {
  const baseUrl = await getGatewayBaseUrl()
  const token = getKbToken()
  const resp = await httpFetch(
    `${baseUrl}/api/kb/${encodeURIComponent(projectId)}/wiki/write?path=${encodeURIComponent(relPath)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: content,
    },
  )
  if (!resp.ok) throw new Error(`Failed to write ${relPath}: ${resp.status}`)
}

function cacheRelPath(): string {
  return ".llm-wiki/ingest-cache.json"
}

async function loadCache(projectId: string): Promise<CacheData> {
  try {
    const raw = await readFileViaApi(projectId, cacheRelPath())
    return JSON.parse(raw) as CacheData
  } catch {
    return { entries: {} }
  }
}

async function saveCache(projectId: string, cache: CacheData): Promise<void> {
  try {
    await writeFileViaApi(projectId, cacheRelPath(), JSON.stringify(cache, null, 2))
  } catch {
    // non-critical
  }
}

/**
 * Check if a source file has already been ingested with the same content.
 * Returns the list of previously written files if cached, or null if ingest is needed.
 */
export async function checkIngestCache(
  projectId: string,
  sourceFileName: string,
  sourceContent: string,
): Promise<string[] | null> {
  const cache = await loadCache(projectId)
  const entry = cache.entries[sourceFileName]
  if (!entry) return null
  const currentHash = await sha256(sourceContent)
  if (entry.hash !== currentHash) return null
  // Verify all previously-written files still exist
  for (const filePath of entry.filesWritten) {
    try {
      await readFileViaApi(projectId, filePath)
    } catch {
      console.log(
        `[ingest-cache] cache miss for ${sourceFileName}: ${filePath} no longer on disk`,
      )
      return null
    }
  }
  return entry.filesWritten
}

/**
 * Save ingest result to cache after successful ingest.
 */
export async function saveIngestCache(
  projectId: string,
  sourceFileName: string,
  sourceContent: string,
  filesWritten: string[],
): Promise<void> {
  const cache = await loadCache(projectId)
  const hash = await sha256(sourceContent)
  const newEntries = { ...cache.entries }
  newEntries[sourceFileName] = {
    hash,
    timestamp: Date.now(),
    filesWritten,
  }
  await saveCache(projectId, { entries: newEntries })
}

/**
 * Remove a source file entry from cache (e.g., when source is deleted).
 */
export async function removeFromIngestCache(
  projectId: string,
  sourceFileName: string,
): Promise<void> {
  const cache = await loadCache(projectId)
  const newEntries = { ...cache.entries }
  delete newEntries[sourceFileName]
  await saveCache(projectId, { entries: newEntries })
}
