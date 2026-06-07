/**
 * Source identity and slug utilities.
 * Ported from llm_wiki src/lib/source-identity.ts
 */

const RAW_SOURCES_PREFIX = "raw/"
const MAX_SOURCE_SUMMARY_SLUG_LENGTH = 120

export function sourceIdentityForPath(sourcePath: string): string {
  const sp = sourcePath.replace(/\\/g, "/")
  const spKey = sp.toLowerCase()
  if (spKey.startsWith(RAW_SOURCES_PREFIX)) {
    return sp.slice(RAW_SOURCES_PREFIX.length)
  }
  return sp.split("/").pop() ?? sp
}

export function sourceSummarySlugFromIdentity(sourceIdentity: string): string {
  const withoutExt = sourceIdentity.replace(/\.[^/.]+$/, "")
  const parts = withoutExt
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length <= 1) {
    return parts[0] || "source"
  }
  const hash = stableSlugHash(sourceIdentity)
  const slug = parts
    .map((part) => {
      const encoded = encodeURIComponent(part).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      )
      return `${encoded.length}-${encoded}`
    })
    .join("--")
  const fullSlug = `${slug}--${hash}`
  if (fullSlug.length <= MAX_SOURCE_SUMMARY_SLUG_LENGTH) {
    return fullSlug
  }
  const readableLimit = MAX_SOURCE_SUMMARY_SLUG_LENGTH - hash.length - 2
  const readablePrefix = trimIncompletePercentEncoding(slug.slice(0, readableLimit))
    .replace(/-+$/, "")
    .replace(/%$/, "")
  return `${readablePrefix || "source"}--${hash}`
}

function trimIncompletePercentEncoding(value: string): string {
  return value.replace(/%(?:[0-9A-F])?$/i, "")
}

function stableSlugHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
