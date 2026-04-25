"use client"

import { useState } from "react"

import { useTiptapEditor } from "@/hooks/use-tiptap-editor"

import { Button } from "@/components/tiptap-ui-primitive/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
} from "@/components/tiptap-ui-primitive/dropdown-menu"
import { ChevronDownIcon } from "@/components/tiptap-icons/chevron-down-icon"

import type { Editor } from "@tiptap/react"

const FONT_FAMILIES = [
  { label: "Default", value: "" },
  { label: "DM Sans", value: "DM Sans" },
  { label: "Inter", value: "Inter" },
  { label: "Arial", value: "Arial" },
  { label: "Georgia", value: "Georgia" },
  { label: "Times New Roman", value: "Times New Roman" },
  { label: "Courier New", value: "Courier New" },
  { label: "Verdana", value: "Verdana" },
  { label: "Trebuchet MS", value: "Trebuchet MS" },
] as const

export interface FontFamilyDropdownProps {
  editor?: Editor | null
  modal?: boolean
}

function getActiveFontFamily(editor: Editor): string {
  const attrs = editor.getAttributes("textStyle")
  return (attrs.fontFamily as string) || ""
}

export function FontFamilyDropdown({
  editor: providedEditor,
  modal = false,
}: FontFamilyDropdownProps) {
  const { editor } = useTiptapEditor(providedEditor)
  const [isOpen, setIsOpen] = useState(false)

  const activeFont = editor ? getActiveFontFamily(editor) : ""
  const activeLabel =
    FONT_FAMILIES.find((f) => f.value === activeFont)?.label ?? "Default"

  return (
    <DropdownMenu modal={modal} open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          tooltip="Font family"
          aria-label="Font family"
          data-state={isOpen ? "open" : "closed"}
          style={{ minWidth: 80, justifyContent: "space-between", fontSize: 13 }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {activeLabel}
          </span>
          <ChevronDownIcon className="tiptap-button-icon tiptap-button-dropdown-small" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent>
        <DropdownMenuGroup>
          {FONT_FAMILIES.map((font) => (
            <DropdownMenuItem
              key={font.value}
              onSelect={() => {
                if (!editor) return
                if (font.value === "") {
                  editor.chain().focus().unsetFontFamily().run()
                } else {
                  editor.chain().focus().setFontFamily(font.value).run()
                }
              }}
              style={{ fontFamily: font.value || "inherit" }}
            >
              {font.label}
              {activeFont === font.value && " ✓"}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
