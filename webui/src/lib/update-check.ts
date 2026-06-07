/**
 * Lightweight update checker: hits the GitHub Releases API for the
 * repo's `latest` release, compares against the app's build-time version.
 * Stub: the full update-check module is not yet ported.
 */

export function toLatestReleaseUrl(htmlUrl: string): string {
  const m = htmlUrl.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/releases(?:\/.*)?$/i)
  if (!m) return htmlUrl
  return `${m[1]}/releases/latest`
}

export interface GithubRelease {
  tag_name: string
  name: string
  body: string
  html_url: string
  published_at: string
}

export type UpdateStatus =
  | { kind: "available"; local: string; remote: string; release: GithubRelease }
  | { kind: "up-to-date"; local: string; remote: string }
  | { kind: "error"; local: string; message: string }

export function isNewer(remote: string, local: string): boolean {
  const parse = (s: string): [number, number, number] => {
    const [a = 0, b = 0, c = 0] = s
      .replace(/^v/, "")
      .split(".")
      .map((n) => {
        const v = parseInt(n, 10)
        return Number.isFinite(v) ? v : 0
      })
    return [a, b, c]
  }
  const [ra, rb, rc] = parse(remote)
  const [la, lb, lc] = parse(local)
  if (ra !== la) return ra > la
  if (rb !== lb) return rb > lb
  return rc > lc
}

export async function fetchLatestRelease(
  _repo: string,
): Promise<GithubRelease | null> {
  return null
}

export async function checkForUpdates(opts: {
  currentVersion: string
  repo: string
}): Promise<UpdateStatus> {
  return {
    kind: "error",
    local: opts.currentVersion,
    message: "Update check not available in this build.",
  }
}

export const UPDATE_CHECK_CACHE_MS = 60 * 60 * 1000 // 1 hour
