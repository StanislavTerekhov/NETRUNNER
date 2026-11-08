import { create } from 'zustand'
import type { UiLanguage } from '../../electron/shared/ipc'
import { api } from './api'
import { RU } from './i18n-ru'

/**
 * Interface language. English text is the key; Russian comes from the dictionary (missing entries fall back to
 * English, so nothing ever renders empty). `{name}` placeholders are filled from `vars`.
 */
interface LangState {
  lang: UiLanguage
  set(lang: UiLanguage): Promise<void>
  init(): Promise<void>
}

export const useLang = create<LangState>(set => ({
  lang: 'en',
  async init() {
    const s = await api.invoke('settings:get')
    set({ lang: s.language })
    document.documentElement.lang = s.language
  },
  async set(lang) {
    const s = await api.invoke('settings:set-language', lang)
    set({ lang: s.language })
    document.documentElement.lang = s.language
  },
}))

export function translate(lang: UiLanguage, text: string, vars?: Record<string, string | number>): string {
  let out = lang === 'ru' ? (RU[text] ?? text) : text
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
  return out
}

/** Translate outside React (stores, notifications): uses the current language. */
export const t = (text: string, vars?: Record<string, string | number>) => translate(useLang.getState().lang, text, vars)

/** Translate inside components: re-renders when the language changes. */
export function useT(): (text: string, vars?: Record<string, string | number>) => string {
  const lang = useLang(s => s.lang)
  return (text, vars) => translate(lang, text, vars)
}
