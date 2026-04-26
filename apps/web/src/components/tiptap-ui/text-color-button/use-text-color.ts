"use client"

import { useCallback, useEffect, useState } from "react"
import { type Editor } from "@tiptap/react"

// --- Hooks ---
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"

// --- Lib ---
import { isMarkInSchema } from "@/lib/tiptap-utils"

// --- Icons ---
import { TextColorIcon } from "@/components/tiptap-icons/text-color-icon"

export const TEXT_COLORS = [
  {
    label: "Default",
    value: "",
    colorValue: "var(--tt-theme-text)",
  },
  {
    label: "Gray",
    value: "var(--tt-color-text-gray)",
    colorValue: "hsl(45, 2%, 46%)",
  },
  {
    label: "Brown",
    value: "var(--tt-color-text-brown)",
    colorValue: "hsl(19, 31%, 47%)",
  },
  {
    label: "Orange",
    value: "var(--tt-color-text-orange)",
    colorValue: "hsl(30, 89%, 45%)",
  },
  {
    label: "Yellow",
    value: "var(--tt-color-text-yellow)",
    colorValue: "hsl(38, 62%, 49%)",
  },
  {
    label: "Green",
    value: "var(--tt-color-text-green)",
    colorValue: "hsl(148, 32%, 39%)",
  },
  {
    label: "Blue",
    value: "var(--tt-color-text-blue)",
    colorValue: "hsl(202, 54%, 43%)",
  },
  {
    label: "Purple",
    value: "var(--tt-color-text-purple)",
    colorValue: "hsl(274, 32%, 54%)",
  },
  {
    label: "Pink",
    value: "var(--tt-color-text-pink)",
    colorValue: "hsl(328, 49%, 53%)",
  },
  {
    label: "Red",
    value: "var(--tt-color-text-red)",
    colorValue: "hsl(2, 62%, 55%)",
  },
]
export type TextColor = (typeof TEXT_COLORS)[number]

export function pickTextColorsByValue(values: string[]) {
  const colorMap = new Map(TEXT_COLORS.map((c) => [c.value, c]))
  return values
    .map((v) => colorMap.get(v))
    .filter((c): c is TextColor => !!c)
}

function canSetTextColor(editor: Editor | null): boolean {
  if (!editor || !editor.isEditable) return false
  if (!isMarkInSchema("textStyle", editor)) return false
  return editor.can().setMark("textStyle")
}

function isTextColorActive(editor: Editor | null, color?: string): boolean {
  if (!editor || !color) return false
  return editor.isActive("textStyle", { color })
}

export interface UseTextColorConfig {
  editor?: Editor | null
  textColor?: string
  label?: string
  hideWhenUnavailable?: boolean
}

export function useTextColor(config: UseTextColorConfig) {
  const {
    editor: providedEditor,
    label,
    textColor,
    hideWhenUnavailable = false,
  } = config

  const { editor } = useTiptapEditor(providedEditor)
  const [isVisible, setIsVisible] = useState(true)
  const canSet = canSetTextColor(editor)
  const isActive = isTextColorActive(editor, textColor)

  useEffect(() => {
    if (!editor) return

    const handleUpdate = () => {
      if (!hideWhenUnavailable) {
        setIsVisible(true)
        return
      }
      setIsVisible(canSetTextColor(editor))
    }

    handleUpdate()
    editor.on("selectionUpdate", handleUpdate)
    return () => {
      editor.off("selectionUpdate", handleUpdate)
    }
  }, [editor, hideWhenUnavailable])

  const handleSetColor = useCallback(() => {
    if (!editor || !canSet || !textColor) return false
    return editor.chain().focus().setColor(textColor).run()
  }, [editor, canSet, textColor])

  const handleRemoveColor = useCallback(() => {
    if (!editor || !canSet) return false
    return editor.chain().focus().unsetColor().run()
  }, [editor, canSet])

  return {
    isVisible,
    isActive,
    canSetTextColor: canSet,
    handleSetColor,
    handleRemoveColor,
    label: label || "Text color",
    Icon: TextColorIcon,
  }
}
