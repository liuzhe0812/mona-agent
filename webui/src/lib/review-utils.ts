export function normalizeReviewTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ")
}
