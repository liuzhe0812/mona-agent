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

export function getHtmlLang(lang: string): string {
  const l = lang.toLowerCase()
  if (l.includes("chinese")) return "zh"
  if (l.includes("japanese")) return "ja"
  if (l.includes("korean")) return "ko"
  if (l.includes("french")) return "fr"
  if (l.includes("german")) return "de"
  if (l.includes("spanish")) return "es"
  if (l.includes("portuguese")) return "pt"
  if (l.includes("italian")) return "it"
  if (l.includes("russian")) return "ru"
  if (l.includes("arabic")) return "ar"
  if (l.includes("hindi")) return "hi"
  if (l.includes("turkish")) return "tr"
  if (l.includes("vietnamese")) return "vi"
  if (l.includes("thai")) return "th"
  if (l.includes("dutch")) return "nl"
  if (l.includes("polish")) return "pl"
  if (l.includes("swedish")) return "sv"
  if (l.includes("indonesian")) return "id"
  if (l.includes("ukrainian")) return "uk"
  if (l.includes("persian")) return "fa"
  if (l.includes("english")) return "en"
  return "en"
}

export function getTextDirection(lang: string): "ltr" | "rtl" {
  const l = lang.toLowerCase()
  if (l.includes("arabic") || l.includes("persian")) return "rtl"
  return "ltr"
}
