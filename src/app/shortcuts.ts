import { useEffect } from 'react'
import { useStore } from './store'

/** App-wide shortcuts. Registered in the capture phase so they also work while Monaco has focus. */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return
      const s = useStore.getState()
      const key = e.key.toLowerCase()
      if (e.shiftKey && key === 'p') s.setPaletteOpen(!s.paletteOpen)
      else if (!e.shiftKey && key === 's') void s.saveFile()
      else if (!e.shiftKey && key === 'o') void s.pickWorkspace()
      else if (!e.shiftKey && key === 'w') s.closeTab()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
