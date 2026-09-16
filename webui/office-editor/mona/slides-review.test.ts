import { describe, expect, it } from 'vitest'

import {
  clearSlidePending,
  createSlidesReviewState,
  markSlidesPending,
  operationsRequireAllSlides,
  operationsRequireVisualReview,
  pendingSlideIdsInOrder,
  resetSlidesReviewState,
} from './slides-review'

describe('Slides review state', () => {
  it('keeps only current pending pages and returns them in deck order', () => {
    const state = createSlidesReviewState()
    resetSlidesReviewState(state, ['s-2', 'deleted'], ['s-1', 's-2'])
    markSlidesPending(state, ['s-1', 's-2'], ['s-1'], { requiresVisual: true })
    expect(pendingSlideIdsInOrder(state, ['s-2', 's-1'])).toEqual(['s-2', 's-1'])

    clearSlidePending(state, 's-2', ['s-1', 's-2'])
    expect(pendingSlideIdsInOrder(state, ['s-1', 's-2'])).toEqual(['s-1'])
    expect(pendingSlideIdsInOrder(state, ['s-1'])).toEqual(['s-1'])
  })

  it('marks all current pages for page or global operations', () => {
    const state = createSlidesReviewState()
    markSlidesPending(state, ['s-1', 's-2'], ['s-1'], { allSlides: true, requiresVisual: true })
    expect(pendingSlideIdsInOrder(state, ['s-1', 's-2'])).toEqual(['s-1', 's-2'])
    expect(operationsRequireAllSlides([
      { op: 'moveSlide', target: { slide: 's-1' } },
    ])).toBe(true)
    expect(operationsRequireAllSlides([{ op: 'applyTheme' }])).toBe(true)
  })

  it('keeps text reflow changes pending while exact paint changes may skip visual review', () => {
    expect(operationsRequireVisualReview([
      { op: 'setText', target: { slide: 's-1', el: 'e-1' } },
      { op: 'setFont', target: { slide: 's-1', el: 'e-1' } },
      { op: 'setFill', target: { slide: 's-1', el: 'e-1' } },
      { op: 'setStroke', target: { slide: 's-1', el: 'e-1' } },
    ])).toBe(true)
    expect(operationsRequireVisualReview([
      { op: 'setText', target: { slide: 's-1', el: 'e-1' } },
    ])).toBe(true)
    expect(operationsRequireVisualReview([
      { op: 'setFont', target: { slide: 's-1', el: 'e-1' } },
    ])).toBe(true)
    expect(operationsRequireVisualReview([
      { op: 'setFill', target: { slide: 's-1', el: 'e-1' } },
    ])).toBe(false)
    expect(operationsRequireVisualReview([
      { op: 'setNotes', target: { slide: 's-1' } },
      { op: 'setLink', target: { slide: 's-1', el: 'e-1' } },
    ])).toBe(false)
  })
})
