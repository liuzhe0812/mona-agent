/**
 * Language metadata for script family detection.
 */

export function sameScriptFamily(langA: string, langB: string): boolean {
  const family = scriptFamily(langA)
  return family !== "other" && family === scriptFamily(langB)
}

function scriptFamily(lang: string): string {
  const l = lang.toLowerCase()
  if (l.includes("chinese") || l.includes("japanese") || l.includes("korean") || l.includes("vietnamese")) {
    return "cjk"
  }
  if (l.includes("english") || l.includes("french") || l.includes("german") || l.includes("spanish") || l.includes("portuguese") || l.includes("italian") || l.includes("dutch") || l.includes("polish") || l.includes("swedish")) {
    return "latin"
  }
  if (l.includes("arabic") || l.includes("persian")) {
    return "arabic"
  }
  if (l.includes("russian") || l.includes("ukrainian")) {
    return "cyrillic"
  }
  if (l.includes("hindi") || l.includes("thai") || l.includes("indonesian") || l.includes("turkish")) {
    return "other"
  }
  return "other"
}

export function getLanguagePromptName(lang: string): string {
  return lang
}
