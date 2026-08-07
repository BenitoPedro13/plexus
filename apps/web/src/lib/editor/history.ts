import { useCallback, useRef, useState } from 'react'

interface HistoryState<T> {
  past: T[]
  present: T
  future: T[]
}

export interface RecipeHistory<T> {
  present: T
  canUndo: boolean
  canRedo: boolean
  // Updates the live draft value without creating a history entry -- call
  // this on every intermediate value during a drag.
  setPresent: (next: T) => void
  // Seals the current draft as a history entry (pushes the last-sealed
  // value onto `past`, clears `future`). No-op if nothing changed since the
  // last seal. Call this once per completed edit gesture (e.g. drag
  // release), not on every setPresent.
  commit: () => void
  undo: () => void
  redo: () => void
}

function sameValue<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Past/present/future history for editor edit-state, backing undo/redo per
// CLAUDE.md's "non-destructive editing... undo/redo is recipe history."
// `T` is the flat edit-state shape the editor page owns, not the assembled
// Recipe -- deriving a Recipe from edit-state is a pure function done by
// the caller, so this hook stays processor-agnostic.
//
// setPresent/commit are split (rather than one `commit(next)` call) so the
// live draft can update on every slider-drag step without going through an
// effect to resync a separate "live" copy of state -- setPresent is the
// single source of truth `present` always reflects immediately.
export function useRecipeHistory<T>(initial: T): RecipeHistory<T> {
  const [state, setState] = useState<HistoryState<T>>({
    past: [],
    present: initial,
    future: [],
  })
  const lastSealed = useRef(initial)

  const setPresent = useCallback((next: T) => {
    setState((s) => ({ ...s, present: next }))
  }, [])

  const commit = useCallback(() => {
    setState((s) => {
      if (sameValue(lastSealed.current, s.present)) return s
      const sealed = lastSealed.current
      lastSealed.current = s.present
      return { past: [...s.past, sealed], present: s.present, future: [] }
    })
  }, [])

  const undo = useCallback(() => {
    setState((s) => {
      if (s.past.length === 0) return s
      const previous = s.past[s.past.length - 1]
      lastSealed.current = previous
      return {
        past: s.past.slice(0, -1),
        present: previous,
        future: [s.present, ...s.future],
      }
    })
  }, [])

  const redo = useCallback(() => {
    setState((s) => {
      if (s.future.length === 0) return s
      const [next, ...rest] = s.future
      lastSealed.current = next
      return { past: [...s.past, s.present], present: next, future: rest }
    })
  }, [])

  return {
    present: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    setPresent,
    commit,
    undo,
    redo,
  }
}
