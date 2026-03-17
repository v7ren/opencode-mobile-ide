import { createEffect, createMemo, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import type { FileSearchHandle } from "@opencode-ai/ui/file"
import { CodeMirrorEditor } from "./CodeMirrorEditor"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { cloneSelectedLineRange, previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { createLineCommentController } from "@opencode-ai/ui/line-comment-annotations"
import { sampledChecksum } from "@opencode-ai/util/encode"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { showToast } from "@opencode-ai/ui/toast"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { getSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"

function FileCommentMenu(props: {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          aria-label={props.moreLabel}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={props.onEdit}>
              <DropdownMenu.ItemLabel>{props.editLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onDelete}>
              <DropdownMenu.ItemLabel>{props.deleteLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

export function FileTabContent(props: { tab: string; onShowFileTree?: () => void }) {
  const file = useFile()
  const comments = useComments()
  const language = useLanguage()
  const prompt = usePrompt()
  const fileComponent = useFileComponent()
  const { sessionKey, tabs, view } = useSessionLayout()
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  }).activeFileTab

  let scroll: HTMLDivElement | undefined
  let scrollFrame: number | undefined
  let restoreFrame: number | undefined
  let pending: { x: number; y: number } | undefined
  let codeScroll: HTMLElement[] = []
  let find: FileSearchHandle | null = null

  const search = {
    register: (handle: FileSearchHandle | null) => {
      find = handle
    },
  }

  const path = createMemo(() => file.pathFromTab(props.tab))
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return file.get(p)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  const cacheKey = createMemo(() => sampledChecksum(contents()))
  const selectedLines = createMemo<SelectedLineRange | null>(() => {
    const p = path()
    if (!p) return null
    if (file.ready()) return (file.selectedLines(p) as SelectedLineRange | undefined) ?? null
    return (getSessionHandoff(sessionKey())?.files[p] as SelectedLineRange | undefined) ?? null
  })

  const selectionPreview = (source: string, selection: FileSelection) => {
    return previewSelectedLines(source, {
      start: selection.startLine,
      end: selection.endLine,
    })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview =
      input.preview ??
      (() => {
        if (input.file === path()) return selectionPreview(contents(), selection)
        const source = file.get(input.file)?.content?.content
        if (!source) return undefined
        return selectionPreview(source, selection)
      })()

    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    const preview =
      input.file === path() ? selectionPreview(contents(), selectionFromLines(input.selection)) : undefined
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(preview ? { preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const fileComments = createMemo(() => {
    const p = path()
    if (!p) return []
    return comments.list(p)
  })

  // Determine if file is editable (text files only)
  const isEditable = createMemo(() => {
    const content = state()?.content
    if (!content) return false
    return content.type === "text" && !content.encoding // Not base64 encoded (not images/media)
  })

  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const [note, setNote] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    selected: null as SelectedLineRange | null,
  })

  // Edit mode state
  const [editState, setEditState] = createStore({
    isEditing: false,
    editedContent: "",
    isSaving: false,
    isDirty: false,
  })

  const syncSelected = (range: SelectedLineRange | null) => {
    const p = path()
    if (!p) return
    file.setSelectedLines(p, range ? cloneSelectedLineRange(range) : null)
  }

  const startEdit = () => {
    if (!isEditable()) return
    const content = contents()
    setEditState({
      isEditing: true,
      editedContent: content,
      isDirty: false,
      isSaving: false,
    })
  }

  const stopEdit = () => {
    setEditState({
      isEditing: false,
      editedContent: "",
      isDirty: false,
      isSaving: false,
    })
  }

  const handleContentChange = (value: string) => {
    setEditState("editedContent", value)
    setEditState("isDirty", value !== contents())
  }

  const saveFile = async () => {
    const p = path()
    if (!p || editState.isSaving) return

    setEditState("isSaving", true)
    try {
      const success = await file.save(p, editState.editedContent)
      if (success) {
        setEditState("isDirty", false)
        showToast({
          title: language.t("common.save") || "Saved",
          description: `${p}`,
        })
      }
    } finally {
      setEditState("isSaving", false)
    }
  }

  const activeSelection = () => note.selected ?? selectedLines()

  const commentsUi = createLineCommentController({
    comments: fileComments,
    label: language.t("ui.lineComment.submit"),
    draftKey: () => path() ?? props.tab,
    state: {
      opened: () => note.openedComment,
      setOpened: (id) => setNote("openedComment", id),
      selected: () => note.selected,
      setSelected: (range) => setNote("selected", range),
      commenting: () => note.commenting,
      setCommenting: (range) => setNote("commenting", range),
      syncSelected,
      hoverSelected: syncSelected,
    },
    getHoverSelectedRange: activeSelection,
    cancelDraftOnCommentToggle: true,
    clearSelectionOnSelectionEndNull: true,
    onSubmit: ({ comment, selection }) => {
      const p = path()
      if (!p) return
      addCommentToContext({ file: p, selection, comment, origin: "file" })
    },
    onUpdate: ({ id, comment, selection }) => {
      const p = path()
      if (!p) return
      updateCommentInContext({ id, file: p, selection, comment })
    },
    onDelete: (comment) => {
      const p = path()
      if (!p) return
      removeCommentFromContext({ id: comment.id, file: p })
    },
    editSubmitLabel: language.t("common.save"),
    renderCommentActions: (_, controls) => (
      <FileCommentMenu
        moreLabel={language.t("common.moreOptions")}
        editLabel={language.t("common.edit")}
        deleteLabel={language.t("common.delete")}
        onEdit={controls.edit}
        onDelete={controls.remove}
      />
    ),
    onDraftPopoverFocusOut: (e: FocusEvent) => {
      const current = e.currentTarget as HTMLDivElement
      const target = e.relatedTarget
      if (target instanceof Node && current.contains(target)) return

      setTimeout(() => {
        if (!document.activeElement || !current.contains(document.activeElement)) {
          setNote("commenting", null)
        }
      }, 0)
    },
  })

  createEffect(() => {
    if (typeof window === "undefined") return

    const onKeyDown = (event: KeyboardEvent) => {
      if (activeFileTab() !== props.tab) return

      // Ctrl+S / Cmd+S to save when editing
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
        if (editState.isEditing) {
          event.preventDefault()
          event.stopPropagation()
          void saveFile()
          return
        }
      }

      // Esc to exit edit mode
      if (event.key === "Escape" && editState.isEditing) {
        event.preventDefault()
        event.stopPropagation()
        stopEdit()
        return
      }

      // Ctrl+F for find when not editing
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        if (!editState.isEditing) {
          event.preventDefault()
          event.stopPropagation()
          find?.focus()
        }
        return
      }

      // Ctrl+E to toggle edit mode
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault()
        event.stopPropagation()
        if (editState.isEditing && editState.isDirty) {
          // In edit mode with unsaved changes: don't toggle, show tooltip or just save
          void saveFile()
        } else {
          editState.isEditing ? stopEdit() : startEdit()
        }
        return
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, { capture: true }))
  })

  createEffect(
    on(
      path,
      () => {
        commentsUi.note.reset()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const focus = comments.focus()
    const p = path()
    if (!focus || !p) return
    if (focus.file !== p) return
    if (activeFileTab() !== props.tab) return

    const target = fileComments().find((comment) => comment.id === focus.id)
    if (!target) return

    commentsUi.note.openComment(target.id, target.selection, { cancelDraft: true })
    requestAnimationFrame(() => comments.clearFocus())
  })

  const getCodeScroll = () => {
    const el = scroll
    if (!el) return []

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return []

    const root = host.shadowRoot
    if (!root) return []

    return Array.from(root.querySelectorAll("[data-code]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
    )
  }

  const queueScrollUpdate = (next: { x: number; y: number }) => {
    pending = next
    if (scrollFrame !== undefined) return

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined

      const out = pending
      pending = undefined
      if (!out) return

      view().setScroll(props.tab, out)
    })
  }

  const handleCodeScroll = (event: Event) => {
    const el = scroll
    if (!el) return

    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return

    queueScrollUpdate({
      x: target.scrollLeft,
      y: el.scrollTop,
    })
  }

  const syncCodeScroll = () => {
    const next = getCodeScroll()
    if (next.length === codeScroll.length && next.every((el, i) => el === codeScroll[i])) return

    for (const item of codeScroll) {
      item.removeEventListener("scroll", handleCodeScroll)
    }

    codeScroll = next

    for (const item of codeScroll) {
      item.addEventListener("scroll", handleCodeScroll)
    }
  }

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll(props.tab)
    if (!s) return

    syncCodeScroll()

    if (codeScroll.length > 0) {
      for (const item of codeScroll) {
        if (item.scrollLeft !== s.x) item.scrollLeft = s.x
      }
    }

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (codeScroll.length > 0) return
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const queueRestore = () => {
    if (restoreFrame !== undefined) return

    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      restoreScroll()
    })
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (codeScroll.length === 0) syncCodeScroll()

    queueScrollUpdate({
      x: codeScroll[0]?.scrollLeft ?? event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    })
  }

  const cancelCommenting = () => {
    const p = path()
    if (p) file.setSelectedLines(p, null)
    setNote("commenting", null)
  }

  let prev = {
    loaded: false,
    ready: false,
    active: false,
  }

  createEffect(() => {
    const loaded = !!state()?.loaded
    const ready = file.ready()
    const active = activeFileTab() === props.tab
    const restore = (loaded && !prev.loaded) || (ready && !prev.ready) || (active && loaded && !prev.active)
    prev = { loaded, ready, active }
    if (!restore) return
    queueRestore()
  })

  onCleanup(() => {
    for (const item of codeScroll) {
      item.removeEventListener("scroll", handleCodeScroll)
    }

    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  })

  const renderEditor = () => (
    <div class="relative h-full">
      <CodeMirrorEditor
        value={editState.editedContent}
        filename={path() ?? ""}
        onChange={handleContentChange}
        onSave={saveFile}
      />
      <div class="absolute bottom-4 right-4 flex items-center gap-2 pointer-events-none">
        <Show when={editState.isDirty}>
          <span class="text-xs text-text-weak bg-surface-base px-2 py-1 rounded">{language.t("common.unsavedChanges") ?? "Modified"}</span>
        </Show>
      </div>
    </div>
  )

  const renderFile = (source: string) => (
    <div class="relative overflow-hidden pb-40">
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{
          name: path() ?? "",
          contents: source,
          cacheKey: cacheKey(),
        }}
        enableLineSelection
        enableHoverUtility
        selectedLines={activeSelection()}
        commentedLines={commentedLines()}
        onRendered={() => {
          queueRestore()
        }}
        annotations={commentsUi.annotations()}
        renderAnnotation={commentsUi.renderAnnotation}
        renderHoverUtility={commentsUi.renderHoverUtility}
        onLineSelected={(range: SelectedLineRange | null) => {
          commentsUi.onLineSelected(range)
        }}
        onLineNumberSelectionEnd={commentsUi.onLineNumberSelectionEnd}
        onLineSelectionEnd={(range: SelectedLineRange | null) => {
          commentsUi.onLineSelectionEnd(range)
        }}
        search={search}
        overflow="scroll"
        class="select-text"
        media={{
          mode: "auto",
          path: path(),
          current: state()?.content,
          onLoad: queueRestore,
          onError: (args: { kind: "image" | "audio" | "svg" }) => {
            if (args.kind !== "svg") return
            showToast({
              variant: "error",
              title: language.t("toast.file.loadFailed.title"),
            })
          },
        }}
      />
    </div>
  )

  return (
    <Tabs.Content value={props.tab} class="mt-3 relative h-full flex flex-col">
      {/* Toolbar */}
      <Show when={state()?.loaded}>
        <div class="flex items-center justify-between px-4 py-2 border-b border-border-weaker-base min-h-[40px]">
          <div class="flex items-center gap-2">
            {/* Mobile File Tree Button */}
            <Show when={props.onShowFileTree}>
              <IconButton
                icon="file-tree"
                variant="ghost"
                size="small"
                onClick={props.onShowFileTree}
                title="Show file tree"
                aria-label="Show file tree"
              />
            </Show>
            <Show when={path()}>
              <span class="text-sm text-text-base font-medium truncate max-w-md" title={path() ?? undefined}>
                {path()?.split("/").pop()}
              </span>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            {/* Screen toggle: Agent/Edit View Switch */}
            <Show when={isEditable()}>
              <div class="flex items-center gap-1 bg-surface-base rounded-md p-0.5 border border-border-weaker-base">
                <Button
                  size="small"
                  variant={editState.isEditing ? "ghost" : "secondary"}
                  class={!editState.isEditing ? "bg-surface-active" : ""}
                  onClick={() => {
                    if (editState.isEditing) stopEdit()
                  }}
                  title="Agent view mode (view and comment)"
                >
                  Agent
                </Button>
                <Button
                  size="small"
                  variant={editState.isEditing ? "secondary" : "ghost"}
                  class={editState.isEditing ? "bg-surface-active" : ""}
                  onClick={() => {
                    if (!editState.isEditing) startEdit()
                  }}
                  title="Edit mode (edit file content)"
                >
                  Edit
                </Button>
              </div>
            </Show>
            <Switch>
              <Match when={editState.isEditing && editState.isDirty}>
                <Button
                  size="small"
                  variant="primary"
                  onClick={() => void saveFile()}
                  disabled={editState.isSaving}
                  loading={editState.isSaving}
                >
                  {language.t("common.save") || "Save"}
                </Button>
              </Match>
              <Match when={editState.isEditing}>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={stopEdit}
                  disabled={editState.isSaving}
                >
                  {language.t("common.done") || "Done"}
                </Button>
              </Match>
            </Switch>
          </div>
        </div>
      </Show>
      
      {/* Content */}
      <Switch>
        <Match when={editState.isEditing}>
          <div class="flex-1 min-h-0 overflow-auto">
            {renderEditor()}
          </div>
        </Match>
        <Match when={!editState.isEditing}>
          <ScrollView
            class="h-full flex-1"
            viewportRef={(el: HTMLDivElement) => {
              scroll = el
              restoreScroll()
            }}
            onScroll={handleScroll as any}
          >
            <Switch>
              <Match when={state()?.loaded}>{renderFile(contents())}</Match>
              <Match when={state()?.loading}>
                <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
              </Match>
              <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
            </Switch>
          </ScrollView>
        </Match>
      </Switch>
    </Tabs.Content>
  )
}
