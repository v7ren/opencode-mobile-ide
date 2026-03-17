import type { Component } from "solid-js"
import { onCleanup, onMount } from "solid-js"
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, scrollPastEnd, rectangularSelection, crosshairCursor, type KeyBinding } from "@codemirror/view"
import { EditorState, Compartment } from "@codemirror/state"
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching } from "@codemirror/language"
import { defaultKeymap, history, indentWithTab, undo, redo } from "@codemirror/commands"
import { autocompletion } from "@codemirror/autocomplete"
import { highlightSelectionMatches } from "@codemirror/search"
import { javascript } from "@codemirror/lang-javascript"
import { python } from "@codemirror/lang-python"
import { html } from "@codemirror/lang-html"
import { css } from "@codemirror/lang-css"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { xml } from "@codemirror/lang-xml"
import { sql } from "@codemirror/lang-sql"
import { oneDark } from "@codemirror/theme-one-dark"

// Map file extensions to CodeMirror languages
function getLanguageExtension(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() || ""
  
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript()
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: ext === "tsx" })
    case "jsx":
      return javascript({ jsx: true })
    case "py":
      return python()
    case "html":
    case "htm":
      return html()
    case "css":
      return css()
    case "json":
      return json()
    case "md":
    case "mdx":
      return markdown()
    case "xml":
    case "svg":
      return xml()
    case "sql":
      return sql()
    default:
      return []
  }
}

// Create custom dark theme
const customDarkTheme = EditorView.theme({
  "&": {
    fontSize: "14px",
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)",
    backgroundColor: "var(--color-background-base, #0d1117)",
  },
  
  ".cm-content": {
    caretColor: "var(--color-text-base, #e6edf3)",
    padding: "16px 0",
  },
  
  ".cm-line": {
    padding: "0 4px 0 8px",
  },
  
  ".cm-gutters": {
    backgroundColor: "var(--color-surface-base, #161b22)",
    color: "var(--color-text-weak, #8b949e)",
    border: "none",
    borderRight: "1px solid var(--color-border-weak-base, #30363d)",
  },
  
  ".cm-activeLineGutter": {
    backgroundColor: "var(--color-surface-base-active, #1f242c)",
    color: "var(--color-text-base, #e6edf3)",
  },
  
  ".cm-activeLine": {
    backgroundColor: "var(--color-surface-base-active, #1f242c)",
  },
  
  ".cm-matchingBracket": {
    backgroundColor: "var(--color-surface-base-active, #3fb95033)",
    outline: "1px solid var(--color-border-weak-base, #3fb950)",
  },
  
  ".cm-tooltip": {
    border: "1px solid var(--color-border-weak-base, #30363d)",
    backgroundColor: "var(--color-surface-elevated, #21262d)",
    color: "var(--color-text-base, #e6edf3)",
    borderRadius: "6px",
    padding: "4px",
    fontSize: "13px",
  },
})

interface CodeMirrorEditorProps {
  value: string
  filename: string
  onChange: (value: string) => void
  onSave: () => void
  readOnly?: boolean
}

export const CodeMirrorEditor: Component<CodeMirrorEditorProps> = (props) => {
  let container: HTMLDivElement | undefined
  let editorView: EditorView | null = null
  const languageCompartment = new Compartment()
  
  const handleSave = () => {
    if (typeof props.onSave === 'function') {
      props.onSave()
    }
    return true
  }

  onMount(() => {
    if (!container) return
    
    // Build extensions
    const langExt = getLanguageExtension(props.filename)
    const extensions: any[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      autocompletion(),
      highlightSelectionMatches(),
      scrollPastEnd(),
      keymap.of([
        ...defaultKeymap,
        indentWithTab,
        { key: "Ctrl-s", run: handleSave, preventDefault: true },
        { key: "Cmd-s", run: handleSave, preventDefault: true },
        { key: "Ctrl-z", run: undo, preventDefault: true },
        { key: "Cmd-z", run: undo, preventDefault: true },
        { key: "Ctrl-y", run: redo, preventDefault: true },
        { key: "Ctrl-Shift-z", run: redo, preventDefault: true },
        { key: "Cmd-Shift-z", run: redo, preventDefault: true },
      ]),
      oneDark,
      customDarkTheme,
      languageCompartment.of(langExt),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          props.onChange(update.state.doc.toString())
        }
      }),
    ]
    
    const state = EditorState.create({
      doc: props.value,
      extensions,
    })
    
    editorView = new EditorView({
      state,
      parent: container,
    })
    
    // Watch for external value changes
    const checkExternalChanges = () => {
      if (!editorView) return
      const currentValue = editorView.state.doc.toString()
      if (currentValue !== props.value) {
        editorView.dispatch({
          changes: { from: 0, to: currentValue.length, insert: props.value },
        })
      }
    }
    
    // Simple interval to check for external changes
    const interval = setInterval(checkExternalChanges, 100)
    
    // Watch for filename changes
    let currentFilename = props.filename
    const checkFilenameChange = () => {
      if (!editorView || props.filename === currentFilename) return
      currentFilename = props.filename
      editorView.dispatch({
        effects: languageCompartment.reconfigure(getLanguageExtension(props.filename)),
      })
    }
    const filenameInterval = setInterval(checkFilenameChange, 100)
    
    // Cleanup on unmount
    onCleanup(() => {
      clearInterval(interval)
      clearInterval(filenameInterval)
      editorView?.destroy()
    })
  })

  return (
    <div 
      ref={(el) => { container = el }}
      class="h-full overflow-auto"
      style={{ 
        "font-family": "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)",
      }}
    />
  )
}
