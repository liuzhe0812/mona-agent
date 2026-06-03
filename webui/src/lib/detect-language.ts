/**
 * Simple language detection from text content.
 */

const CJK_RANGES = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/
const JAPANESE_RANGES = /[\u3040-\u309f\u30a0-\u30ff]/
const KOREAN_RANGES = /[\uac00-\ud7af\u1100-\u11ff]/

export function detectLanguage(text: string): string {
  if (!text) return "English"
  const sample = text.slice(0, 2000)

  if (JAPANESE_RANGES.test(sample)) return "Japanese"
  if (KOREAN_RANGES.test(sample)) return "Korean"
  if (CJK_RANGES.test(sample)) return "Chinese"
  return "English"
}
