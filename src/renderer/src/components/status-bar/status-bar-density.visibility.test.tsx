// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStatusBarDensity } from './status-bar-density'

let resize: () => void
let width = 900
let hidden = false

function Bar({ revision = 0 }: { revision?: number }): React.JSX.Element {
  const { density, barRef, usageRef, segmentsRef } = useStatusBarDensity()
  return (
    <div ref={barRef} data-bar style={{ padding: '0 12px', columnGap: '16px' }}>
      <div ref={usageRef} data-usage>
        Usage
      </div>
      <div ref={segmentsRef} data-segments>
        Ports
      </div>
      <output>
        {density.compact ? 'compact' : 'roomy'}:{revision}
      </output>
    </div>
  )
}

function geometry(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return hidden ? 0 : width
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const measured = hidden ? 0 : this.hasAttribute('data-usage') ? 300 : 100
    return new DOMRect(0, 0, measured, hidden ? 0 : 24)
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  width = 900
  hidden = false
})

describe('status bar visibility', () => {
  it('preserves layout while hidden and measures again after restoration', () => {
    geometry()
    const view = render(<Bar />)
    expect(view.container.querySelector('output')?.textContent).toBe('roomy:0')
    hidden = true
    act(() => resize())
    view.rerender(<Bar revision={1} />)
    expect(view.container.querySelector('output')?.textContent).toBe('roomy:1')
    hidden = false
    width = 350
    act(() => resize())
    expect(view.container.querySelector('output')?.textContent).toBe('compact:1')
    width = 900
    act(() => resize())
    expect(view.container.querySelector('output')?.textContent).toBe('roomy:1')
  })

  it('defers layout when first mounted inside a hidden app', () => {
    geometry()
    hidden = true
    const view = render(<Bar />)
    expect(view.container.querySelector('output')?.textContent).toBe('roomy:0')
    hidden = false
    width = 350
    act(() => resize())
    expect(view.container.querySelector('output')?.textContent).toBe('compact:0')
  })
})
