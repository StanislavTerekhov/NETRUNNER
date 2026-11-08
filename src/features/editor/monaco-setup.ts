import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

// Workers are bundled locally; nothing is fetched from a CDN, so the editor works offline.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  },
}

loader.config({ monaco })

monaco.editor.defineTheme('netrunner', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7a8590', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'fcee09' },
    { token: 'string', foreground: '19f5a5' },
    { token: 'number', foreground: 'ff8a3d' },
    { token: 'type', foreground: '00e5ff' },
    { token: 'type.identifier', foreground: '00e5ff' },
    { token: 'delimiter', foreground: '7d8a94' },
    { token: 'tag', foreground: '00e5ff' },
    { token: 'attribute.name', foreground: 'fcee09' },
    { token: 'regexp', foreground: 'ff2442' },
  ],
  colors: {
    'editor.background': '#0b0e11',
    'editor.foreground': '#d7dde2',
    'editorLineNumber.foreground': '#7a8590',
    'editorLineNumber.activeForeground': '#fcee09',
    'editor.lineHighlightBackground': '#101417',
    'editor.selectionBackground': '#00e5ff33',
    'editorCursor.foreground': '#fcee09',
    'editorIndentGuide.background1': '#1a2126',
    'editorWidget.background': '#101417',
    'editorWidget.border': '#34404a',
    'scrollbarSlider.background': '#34404a80',
    'minimap.background': '#0b0e11',
  },
})

export { monaco }
