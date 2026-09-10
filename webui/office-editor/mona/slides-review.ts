export interface SlidesReviewState {
  pendingSlideIds: Set<string>
}

export interface SlidesReviewOperation {
  op: string
  target?: {
    slide?: number | string
    part?: string
    el?: string
  }
}

const NON_VISUAL_OPERATIONS = new Set([
  'setText',
  'setFont',
  'setFill',
  'setStroke',
  'setNotes',
  'addComment',
  'deleteComment',
  'setLink',
  'setHidden',
  'setTransition',
  'setAdvanceTime',
  'setAnimations',
])

const STRUCTURE_ONLY_OPERATIONS = new Set(['setText', 'setFont', 'setFill', 'setStroke'])

const ALL_SLIDES_OPERATIONS = new Set([
  'addBlankSlide',
  'duplicateSlide',
  'deleteSlide',
  'moveSlide',
  'pasteSlide',
  'insertSlidePptx',
  'setSlideSize',
  'applyTheme',
  'applyHeaderFooter',
])

export function createSlidesReviewState(): SlidesReviewState {
  return { pendingSlideIds: new Set() }
}

export function resetSlidesReviewState(
  state: SlidesReviewState,
  pendingSlideIds: readonly string[] = [],
  currentSlideIds: readonly string[] = [],
): void {
  state.pendingSlideIds.clear()
  const current = new Set(currentSlideIds)
  for (const slideId of pendingSlideIds) {
    if (current.has(slideId)) state.pendingSlideIds.add(slideId)
  }
}

export function reconcileSlidesReviewState(
  state: SlidesReviewState,
  currentSlideIds: readonly string[],
): void {
  const current = new Set(currentSlideIds)
  for (const slideId of state.pendingSlideIds) {
    if (!current.has(slideId)) state.pendingSlideIds.delete(slideId)
  }
}

export function markSlidesPending(
  state: SlidesReviewState,
  currentSlideIds: readonly string[],
  affectedSlideIds: readonly string[],
  options: { allSlides?: boolean; requiresVisual?: boolean; hasWarnings?: boolean } = {},
): void {
  reconcileSlidesReviewState(state, currentSlideIds)
  if (!options.requiresVisual && !options.hasWarnings) return
  const affected = options.allSlides ? currentSlideIds : affectedSlideIds
  const current = new Set(currentSlideIds)
  for (const slideId of affected) {
    if (current.has(slideId)) state.pendingSlideIds.add(slideId)
  }
}

export function clearSlidePending(
  state: SlidesReviewState,
  slideId: string,
  currentSlideIds: readonly string[],
): void {
  reconcileSlidesReviewState(state, currentSlideIds)
  if (currentSlideIds.includes(slideId)) state.pendingSlideIds.delete(slideId)
}

export function pendingSlideIdsInOrder(
  state: SlidesReviewState,
  currentSlideIds: readonly string[],
): string[] {
  return currentSlideIds.filter((slideId) => state.pendingSlideIds.has(slideId))
}

export function operationsRequireVisualReview(
  operations: readonly SlidesReviewOperation[],
): boolean {
  if (operations.every((operation) => (
    NON_VISUAL_OPERATIONS.has(operation.op) && !STRUCTURE_ONLY_OPERATIONS.has(operation.op)
  ))) return false
  return operations.length !== 1 || !STRUCTURE_ONLY_OPERATIONS.has(operations[0]!.op)
}

export function operationsRequireAllSlides(
  operations: readonly SlidesReviewOperation[],
): boolean {
  return operations.some((operation) => (
    operation.target?.part !== undefined
    || operation.target?.slide === undefined
    || ALL_SLIDES_OPERATIONS.has(operation.op)
  ))
}
