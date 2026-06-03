import { useWikiStore } from "@/stores/wiki-store"

function detectLanguage(text: string): string {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length
  const latinChars = (text.match(/[a-zA-Z]/g) ?? []).length
  if (cjkChars > latinChars * 0.5) return "Chinese"
  return "English"
}

function getLanguagePromptName(lang: string): string {
  return lang
}

export function getOutputLanguage(fallbackText: string = ""): string {
  const configured = useWikiStore.getState().outputLanguage
  if (configured && configured !== "auto") {
    return configured
  }
  return detectLanguage(fallbackText || "English")
}

export function buildLanguageDirective(fallbackText: string = ""): string {
  const lang = getOutputLanguage(fallbackText)
  const promptLang = getLanguagePromptName(lang)
  return [
    `## ⚠️ MANDATORY OUTPUT LANGUAGE: ${promptLang}`,
    "",
    `You MUST write your entire response (including wiki page titles, content, descriptions, summaries, and any generated text) in **${promptLang}**.`,
    `The source material or wiki content may be in a different language, but this is IRRELEVANT to your output language.`,
    `Ignore the language of any source content. Generate everything in ${promptLang} only.`,
    `Proper nouns should use standard ${promptLang} transliteration when appropriate.`,
    `DO NOT use any other language. This overrides all other instructions.`,
  ].join("\n")
}

export function buildLanguageReminder(fallbackText: string = ""): string {
  const lang = getOutputLanguage(fallbackText)
  return `REMINDER: All output must be in ${getLanguagePromptName(lang)}. Do not use any other language.`
}
