import { describe, expect, it } from 'vitest'

import { dataUrlImage, svgImage } from './slides-assets'

const VALID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">
  <defs>
    <linearGradient id="gradient" x1="0" x2="1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
    <clipPath id="clip"><rect width="120" height="80" rx="8"/></clipPath>
    <mask id="mask"><rect width="120" height="80" fill="white"/></mask>
  </defs>
  <g clip-path="url(#clip)" mask="url(#mask)">
    <rect width="120" height="80" fill="url(#gradient)"/>
    <path d="M5 5h20v20H5z" fill="none" stroke="#fff"/>
    <circle cx="60" cy="40" r="12" fill="#fff"/>
    <line x1="0" y1="0" x2="120" y2="80" stroke="#fff"/>
    <polyline points="0,70 30,45 60,60" fill="none" stroke="#fff"/>
    <polygon points="80,20 110,20 95,55" fill="#fff"/>
    <text x="8" y="72">静态 SVG</text>
  </g>
</svg>`

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  return btoa(String.fromCharCode(...bytes))
}

describe('slides assets', () => {
  it('validates a static SVG and returns UTF-8 SVG bytes', () => {
    const result = svgImage(VALID_SVG)
    expect(result.ext).toBe('svg')
    expect(new TextDecoder().decode(result.bytes)).toBe(VALID_SVG)
  })

  it('requires the SVG namespace and a viewBox or dimensions', () => {
    expect(() => svgImage('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')).toThrow()
    expect(() => svgImage('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')).toThrow()
    expect(() => svgImage('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')).not.toThrow()
  })

  it('rejects scripts, animation, foreign objects, events, entities, and external references', () => {
    const cases = [
      '<script>alert(1)</script>',
      '<animate attributeName="x" />',
      '<foreignObject />',
      '<rect onclick="alert(1)" />',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">&evil;</svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><use href="https://example.com/icon.svg#x"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect style="fill:url(https://example.com/fill)"/></svg>',
    ]
    for (const body of cases) {
      const svg = body.startsWith('<svg') ? body : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${body}</svg>`
      expect(() => svgImage(svg)).toThrow()
    }
  })

  it('rejects an SVG larger than 1MB', () => {
    const payload = 'x'.repeat(1_048_577)
    expect(() => svgImage(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>${payload}</text></svg>`)).toThrow()
  })

  it('accepts the existing raster data URLs and validated SVG data URLs', () => {
    expect(dataUrlImage('data:image/png;base64,AA==')).toEqual({ bytes: new Uint8Array([0]), ext: 'png' })
    expect(dataUrlImage(`data:image/svg+xml;base64,${toBase64(VALID_SVG)}`)).toEqual({
      bytes: new TextEncoder().encode(VALID_SVG),
      ext: 'svg',
    })
    expect(dataUrlImage(`data:image/svg+xml,${encodeURIComponent(VALID_SVG)}`)).toEqual({
      bytes: new TextEncoder().encode(VALID_SVG),
      ext: 'svg',
    })
    expect(() => dataUrlImage('data:image/svg+xml;base64,PHN2Zy8+')).toThrow()
  })
})
