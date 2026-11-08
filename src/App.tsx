import { useEffect, type ReactNode } from 'react'
import { Group, Panel as ResizablePanel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { TitleBar } from '@/components/hud/TitleBar'
import { NavRail } from '@/components/hud/NavRail'
import { StatusBar } from '@/components/hud/StatusBar'
import { CommandPalette } from '@/components/hud/CommandPalette'
import { Explorer } from '@/features/workspace/Explorer'
import { WorkspaceView } from '@/features/workspace/WorkspaceView'
import { EditorArea } from '@/features/editor/EditorArea'
import { PhasePlaceholder } from '@/features/PhasePlaceholder'
import { ChatDock, NeuralCore } from '@/features/neural/NeuralCore'
import { ModelVault } from '@/features/models/ModelVault'
import { AgentControl } from '@/features/agents/AgentControl'
import { GitView } from '@/features/git/GitView'
import { MemoryView } from '@/features/memory/MemoryView'
import { SystemMonitor } from '@/features/system/SystemMonitor'
import { NetworkMonitor } from '@/features/network/NetworkMonitor'
import { TerminalView } from '@/features/terminal/TerminalView'
import { ForgeView } from '@/features/forge/ForgeView'
import { sectionById } from '@/app/sections'
import { useStore, type SectionId } from '@/app/store'
import { useLayout } from '@/app/layout-store'
import { useLang } from '@/lib/i18n'
import type { WorkspaceLayout } from '../electron/shared/ipc'

const IMPLEMENTED = new Set<SectionId>(['editor', 'workspace', 'neural', 'models', 'agents', 'git', 'terminal', 'memory', 'system', 'network', 'forge'])
import { useGlobalShortcuts } from '@/app/shortcuts'

export default function App() {
  const section = useStore(s => s.section)
  const setSection = useStore(s => s.setSection)
  const init = useStore(s => s.init)
  const initLayout = useLayout(s => s.init)
  const initLang = useLang(s => s.init)
  const docked = useLayout(s => s.current.terminal !== 'section')

  useEffect(() => {
    void init()
    void initLayout()
    void initLang()
  }, [init, initLayout, initLang])
  useGlobalShortcuts()
  // A docked terminal lives on the editor screen; its nav entry leads there.
  useEffect(() => {
    if (docked && section === 'terminal') setSection('editor')
  }, [docked, section, setSection])

  return (
    <div className="flex h-full flex-col bg-void">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <NavRail />
        <main className="min-w-0 flex-1">
          {/* The editor layout stays mounted so Monaco models and scroll positions survive section switches. */}
          <div className={section === 'editor' ? 'h-full' : 'hidden'}>
            <EditorLayout visible={section === 'editor'} />
          </div>
          {section === 'workspace' && <WorkspaceView />}
          {section === 'neural' && <NeuralCore />}
          {section === 'models' && <ModelVault />}
          {section === 'agents' && <AgentControl />}
          {section === 'git' && <GitView />}
          {section === 'memory' && <MemoryView />}
          {section === 'system' && <SystemMonitor />}
          {section === 'network' && <NetworkMonitor />}
          {section === 'forge' && <ForgeView />}
          {/* Kept mounted so the shell session survives switching sections. */}
          {!docked && (
            <div className={section === 'terminal' ? 'h-full' : 'hidden'}>
              <TerminalView visible={section === 'terminal'} />
            </div>
          )}
          {!IMPLEMENTED.has(section) && <PhasePlaceholder section={sectionById(section)} />}
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
    </div>
  )
}

const SEP_V = 'w-2 transition-colors hover:bg-secondary/30 data-[separator=active]:bg-secondary/50'
const SEP_H = 'h-2 transition-colors hover:bg-secondary/30 data-[separator=active]:bg-secondary/50'

/** Panel sizes are remembered per layout and per arrangement. */
const layoutKey = (l: WorkspaceLayout) => `${l.id}-${l.explorer ? 'e' : ''}${l.terminal}${l.chat ? 'c' : ''}`

function EditorLayout({ visible }: { visible: boolean }) {
  const layout = useLayout(s => s.current)
  return <LayoutGrid key={layoutKey(layout)} layout={layout} visible={visible} />
}

function LayoutGrid({ layout, visible }: { layout: WorkspaceLayout; visible: boolean }) {
  // The classic layout keeps the storage id it always had, so existing panel sizes survive the update.
  const id = layout.id === 'classic' && layout.explorer && !layout.chat && layout.terminal === 'section' ? 'netrunner-editor-layout' : `netrunner-layout-${layoutKey(layout)}`
  const saved = useDefaultLayout({ id, storage: localStorage })
  const terminal = <TerminalView visible={visible} docked />
  const center = layout.terminal === 'bottom' ? <Split id={`${id}-center`} top={<EditorArea />} bottom={terminal} bottomSize="32" /> : <EditorArea />
  const right =
    layout.chat && layout.terminal === 'right' ? (
      <Split id={`${id}-right`} top={<ChatDock />} bottom={terminal} bottomSize="45" />
    ) : layout.chat ? (
      <ChatDock />
    ) : layout.terminal === 'right' ? (
      terminal
    ) : null

  return (
    <Group id={id} orientation="horizontal" defaultLayout={saved.defaultLayout} onLayoutChanged={saved.onLayoutChanged} className="h-full p-2">
      {layout.explorer && (
        <>
          <ResizablePanel id="explorer" defaultSize="20" minSize="12" maxSize="45">
            <Explorer />
          </ResizablePanel>
          <Separator className={SEP_V} />
        </>
      )}
      <ResizablePanel id="editor" minSize="30">
        {center}
      </ResizablePanel>
      {right && (
        <>
          <Separator className={SEP_V} />
          <ResizablePanel id="right" defaultSize="34" minSize="18" maxSize="60">
            <div data-testid="layout-right" className="h-full">
              {right}
            </div>
          </ResizablePanel>
        </>
      )}
    </Group>
  )
}

function Split({ id, top, bottom, bottomSize }: { id: string; top: ReactNode; bottom: ReactNode; bottomSize: string }) {
  const saved = useDefaultLayout({ id, storage: localStorage })
  return (
    <Group id={id} orientation="vertical" defaultLayout={saved.defaultLayout} onLayoutChanged={saved.onLayoutChanged} className="h-full">
      <ResizablePanel id="top" minSize="20">
        {top}
      </ResizablePanel>
      <Separator className={SEP_H} />
      <ResizablePanel id="bottom" defaultSize={bottomSize} minSize="12">
        <div data-testid="layout-bottom" className="h-full">
          {bottom}
        </div>
      </ResizablePanel>
    </Group>
  )
}
