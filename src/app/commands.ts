import { api } from '@/lib/api'
import { t } from '@/lib/i18n'
import { isAvailable, SECTIONS } from './sections'
import { useLayout } from './layout-store'
import { useStore } from './store'

export interface Command {
  id: string
  title: string
  shortcut?: string
  enabled?: () => boolean
  run: () => void | Promise<void>
}

/** Built when the palette opens, so titles are in the current interface language. */
export function getCommands(): Command[] {
  const s = useStore.getState
  const hasWorkspace = () => !!s().workspace
  const hasTab = () => !!s().activePath

  return [
    { id: 'workspace.open', title: t('Workspace: Open Folder…'), shortcut: 'Ctrl+O', run: () => s().pickWorkspace() },
    { id: 'workspace.refresh', title: t('Workspace: Refresh Explorer'), enabled: hasWorkspace, run: () => s().refreshTree() },
    { id: 'file.save', title: t('File: Save'), shortcut: 'Ctrl+S', enabled: hasTab, run: () => s().saveFile() },
    { id: 'file.close', title: t('File: Close Editor'), shortcut: 'Ctrl+W', enabled: hasTab, run: () => s().closeTab() },
    { id: 'window.maximize', title: t('Window: Toggle Maximize'), run: () => void api.invoke('window:toggle-maximize') },
    { id: 'window.minimize', title: t('Window: Minimize'), run: () => void api.invoke('window:minimize') },
    ...useLayout.getState().all().map<Command>(l => ({
      id: `layout.${l.id}`,
      title: `${t('Layout')}: ${t(l.name)}`,
      run: async () => {
        await useLayout.getState().apply(l.id)
        s().setSection('editor')
      },
    })),
    ...SECTIONS.map<Command>(sec => ({
      id: `view.${sec.id}`,
      title: `${t('View')}: ${t(sec.label)}${!isAvailable(sec) ? ` (phase ${sec.phase})` : ''}`,
      run: () => s().setSection(sec.id),
    })),
  ]
}
