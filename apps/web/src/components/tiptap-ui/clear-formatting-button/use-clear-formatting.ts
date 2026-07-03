import { useCallback, useEffect, useState } from "react"
import { type Editor } from "@tiptap/react"

// --- Hooks ---
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"

// --- Icons ---
import { RemoveFormattingIcon } from "@/components/tiptap-icons/remove-formatting-icon"

/**
 * Configuration for the clear formatting functionality
 */
export interface UseClearFormattingConfig {
  /**
   * The Tiptap editor instance.
   */
  editor?: Editor | null
  /**
   * Callback function called after formatting is successfully cleared.
   */
  onCleared?: () => void
}

/**
 * Checks if clear formatting can be executed
 */
export function canClearFormatting(editor: Editor | null): boolean {
  if (!editor || !editor.isEditable) return false
  return editor.can().unsetAllMarks() || editor.can().clearNodes()
}

/**
 * Clears all formatting from the current selection, preserving links.
 */
export function clearFormatting(editor: Editor | null): boolean {
  if (!editor || !editor.isEditable) return false

  const { schema } = editor.state
  const chain = editor.chain().focus()

  // Unset each mark individually, skipping "link" to preserve hyperlinks
  for (const name of Object.keys(schema.marks)) {
    if (name !== "link") {
      chain.unsetMark(name)
    }
  }

  // Reset block-level nodes (headings, blockquotes, lists) back to paragraphs
  chain.clearNodes()

  return chain.run()
}

/**
 * Custom hook that provides clear-formatting functionality for a Tiptap editor.
 *
 * @example
 * ```tsx
 * function MyClearFormattingButton() {
 *   const { canClear, handleClear } = useClearFormatting()
 *
 *   return <button disabled={!canClear} onClick={handleClear}>Clear</button>
 * }
 * ```
 */
export function useClearFormatting(config: UseClearFormattingConfig = {}) {
  const { editor: providedEditor, onCleared } = config

  const { editor } = useTiptapEditor(providedEditor)
  const [isVisible, setIsVisible] = useState<boolean>(true)
  const canClear = canClearFormatting(editor)

  useEffect(() => {
    if (!editor) return

    const handleUpdate = () => {
      setIsVisible(!!editor && editor.isEditable)
    }

    handleUpdate()

    editor.on("transaction", handleUpdate)

    return () => {
      editor.off("transaction", handleUpdate)
    }
  }, [editor])

  const handleClear = useCallback(() => {
    if (!editor) return false

    const success = clearFormatting(editor)
    if (success) {
      onCleared?.()
    }
    return success
  }, [editor, onCleared])

  return {
    isVisible,
    canClear,
    handleClear,
    label: "Clear formatting",
    Icon: RemoveFormattingIcon,
  }
}
