// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AiAskPopover } from '../vendor/genoffice/apps/slides/src/renderer/components/AiAskPopover'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

function mount(sendOnly: boolean) {
  const onSubmit = vi.fn()
  const onSendNow = vi.fn()
  const onCancel = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(AiAskPopover, {
    targets: [{ id: 'element-1', sourceId: 'source-1', desc: { type: 'table' } }],
    getAnchorRect: () => ({ left: 10, top: 10, right: 200, bottom: 100, viewTop: 0, viewBottom: 800 }),
    onSubmit,
    onSendNow,
    onCancel,
    sendOnly,
  })))
  const input = container.querySelector<HTMLInputElement>('.ai-ask-pop-input')!
  return { input, onSubmit, onSendNow, onCancel }
}

function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function click(selector: string) {
  const button = container!.querySelector<HTMLButtonElement>(selector)!
  act(() => button.click())
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('slides element AI edit', () => {
  it('sends the input from the embedded editor without offering a local queue', () => {
    const { input, onSubmit, onSendNow } = mount(true)
    const submit = container!.querySelector<HTMLButtonElement>('.ai-ask-confirm')!
    expect(submit.textContent).toBe('发送')
    expect(submit.disabled).toBe(true)
    expect(container!.textContent).not.toContain('加入队列')

    typeInto(input, '  润色  ')
    click('.ai-ask-confirm')
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith('润色')
    expect(onSendNow).not.toHaveBeenCalled()
  })

  it('sends on Enter in the embedded editor', () => {
    const { input, onSubmit, onSendNow } = mount(true)
    typeInto(input, '润色表格')
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith('润色表格')
    expect(onSendNow).not.toHaveBeenCalled()
  })

  it('keeps an embedded draft on outside click and closes an empty popover', () => {
    const { input, onSubmit, onCancel } = mount(true)
    const outside = document.createElement('button')
    const navigate = vi.fn()
    outside.addEventListener('click', navigate)
    document.body.appendChild(outside)
    typeInto(input, '润色')
    act(() => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
      outside.click()
    })
    expect(input.value).toBe('润色')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()

    typeInto(input, '')
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(onCancel).toHaveBeenCalledOnce()
    outside.remove()
  })

  it('allows cancelling an embedded draft', () => {
    const { input, onSubmit, onCancel } = mount(true)
    typeInto(input, '润色')
    click('.ai-ask-cancel')
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('preserves the standalone queue and send-now actions', () => {
    const { input, onSubmit, onSendNow } = mount(false)
    expect(container!.textContent).toContain('加入队列')
    expect(container!.textContent).toContain('立即发送')
    typeInto(input, '润色')
    click('.ai-ask-cancel')
    expect(onSendNow).toHaveBeenCalledWith('润色')
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onSubmit).toHaveBeenCalledWith('润色')
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })
})
