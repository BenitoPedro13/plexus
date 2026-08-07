import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useRecipeHistory } from './history'

describe('useRecipeHistory', () => {
  it('starts with no undo/redo available', () => {
    const { result } = renderHook(() => useRecipeHistory(0))
    expect(result.current.present).toBe(0)
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })

  it('setPresent updates the live draft without creating a history entry', () => {
    const { result } = renderHook(() => useRecipeHistory(0))

    act(() => result.current.setPresent(1))
    act(() => result.current.setPresent(2))
    expect(result.current.present).toBe(2)
    expect(result.current.canUndo).toBe(false)
  })

  it('commit seals the draft, and undo/redo traverse it', () => {
    const { result } = renderHook(() => useRecipeHistory(0))

    act(() => result.current.setPresent(1))
    act(() => result.current.commit())
    act(() => result.current.setPresent(2))
    act(() => result.current.commit())
    expect(result.current.present).toBe(2)
    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)

    act(() => result.current.undo())
    expect(result.current.present).toBe(1)
    expect(result.current.canRedo).toBe(true)

    act(() => result.current.undo())
    expect(result.current.present).toBe(0)
    expect(result.current.canUndo).toBe(false)

    act(() => result.current.redo())
    act(() => result.current.redo())
    expect(result.current.present).toBe(2)
    expect(result.current.canRedo).toBe(false)
  })

  it('commit after undo clears the redo stack', () => {
    const { result } = renderHook(() => useRecipeHistory(0))

    act(() => result.current.setPresent(1))
    act(() => result.current.commit())
    act(() => result.current.setPresent(2))
    act(() => result.current.commit())
    act(() => result.current.undo())
    act(() => result.current.setPresent(99))
    act(() => result.current.commit())

    expect(result.current.present).toBe(99)
    expect(result.current.canRedo).toBe(false)
  })

  it('commit is a no-op when the draft is structurally unchanged since the last seal', () => {
    const { result } = renderHook(() => useRecipeHistory({ a: 1 }))

    act(() => result.current.setPresent({ a: 1 }))
    act(() => result.current.commit())
    expect(result.current.canUndo).toBe(false)

    act(() => result.current.setPresent({ a: 2 }))
    act(() => result.current.commit())
    expect(result.current.canUndo).toBe(true)
  })

  it('undo/redo are no-ops at the ends of history', () => {
    const { result } = renderHook(() => useRecipeHistory(0))

    act(() => result.current.undo())
    expect(result.current.present).toBe(0)

    act(() => result.current.setPresent(1))
    act(() => result.current.commit())
    act(() => result.current.redo())
    expect(result.current.present).toBe(1)
  })
})
