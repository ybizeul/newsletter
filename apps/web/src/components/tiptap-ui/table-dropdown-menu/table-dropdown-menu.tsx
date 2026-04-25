"use client"

import { useRef, useState } from "react"

// --- Hooks ---
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"

// --- UI Primitives ---
import { Button } from "@/components/tiptap-ui-primitive/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/tiptap-ui-primitive/dropdown-menu"

// --- Icons ---
import { TableIcon } from "@/components/tiptap-icons/table-icon"
import { ChevronDownIcon } from "@/components/tiptap-icons/chevron-down-icon"
import { TrashIcon } from "@/components/tiptap-icons/trash-icon"
import { TableRowInsertTopIcon } from "@/components/tiptap-icons/table-row-insert-top-icon"
import { TableRowInsertBottomIcon } from "@/components/tiptap-icons/table-row-insert-bottom-icon"
import { TableRowDeleteIcon } from "@/components/tiptap-icons/table-row-delete-icon"
import { TableColumnInsertLeftIcon } from "@/components/tiptap-icons/table-column-insert-left-icon"
import { TableColumnInsertRightIcon } from "@/components/tiptap-icons/table-column-insert-right-icon"
import { TableColumnDeleteIcon } from "@/components/tiptap-icons/table-column-delete-icon"
import { TableMergeCellsIcon } from "@/components/tiptap-icons/table-merge-cells-icon"
import { TableSplitCellIcon } from "@/components/tiptap-icons/table-split-cell-icon"
import { AlignLeftIcon } from "@/components/tiptap-icons/align-left-icon"
import { AlignCenterIcon } from "@/components/tiptap-icons/align-center-icon"
import { AlignRightIcon } from "@/components/tiptap-icons/align-right-icon"
import { AlignTopIcon } from "@/components/tiptap-icons/align-top-icon"
import { AlignMiddleIcon } from "@/components/tiptap-icons/align-middle-icon"
import { AlignBottomIcon } from "@/components/tiptap-icons/align-bottom-icon"

import type { Editor } from "@tiptap/react"

export interface TableDropdownMenuProps {
  editor?: Editor | null
  modal?: boolean
}

function getCellAlignment(editor: Editor) {
  const { state } = editor
  const { $anchor } = state.selection

  for (let d = $anchor.depth; d > 0; d--) {
    const node = $anchor.node(d)
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      return {
        textAlign: (node.attrs.align as string | null) ?? null,
        verticalAlign: (node.attrs.verticalAlign as string | null) ?? null,
      }
    }
  }

  return { textAlign: null, verticalAlign: null }
}

function setCellAlignment(editor: Editor, name: string, value: string) {
  editor.chain().focus().run()
  editor.commands.setCellAttribute(name, value)
}

function getTableHeaderState(editor: Editor) {
  const { state } = editor
  const { selection } = state
  const $anchor = selection.$anchor

  // Walk up to find the table node
  let depth = $anchor.depth
  let tableNode = null
  while (depth > 0) {
    const node = $anchor.node(depth)
    if (node.type.name === "table") {
      tableNode = node
      break
    }
    depth--
  }

  if (!tableNode) return { headerRow: false, headerColumn: false, headerCell: false }

  // Header row: every cell in the first row is tableHeader
  const firstRow = tableNode.firstChild
  let headerRow = false
  if (firstRow && firstRow.childCount > 0) {
    let allHeaders = true
    firstRow.forEach((cell) => {
      if (cell.type.name !== "tableHeader") allHeaders = false
    })
    headerRow = allHeaders
  }

  // Header column: first cell of every row is tableHeader
  let headerColumn = tableNode.childCount > 0
  tableNode.forEach((row) => {
    if (!row.firstChild || row.firstChild.type.name !== "tableHeader") {
      headerColumn = false
    }
  })

  // Header cell: cursor is currently inside a tableHeader cell
  const headerCell = editor.isActive("tableHeader")

  return { headerRow, headerColumn, headerCell }
}

export function TableDropdownMenu({
  editor: providedEditor,
  modal = false,
}: TableDropdownMenuProps) {
  const { editor } = useTiptapEditor(providedEditor)
  const [isOpen, setIsOpen] = useState(false)

  // Keep a ref so onSelect handlers always have the current editor instance,
  // even if the Radix dropdown has shifted focus away.
  const editorRef = useRef<Editor | null>(null)
  if (editor) editorRef.current = editor

  const inTable = editor?.isActive("table") ?? false
  const { headerRow, headerColumn, headerCell } = inTable && editor
    ? getTableHeaderState(editor)
    : { headerRow: false, headerColumn: false, headerCell: false }
  const { textAlign: cellTextAlign, verticalAlign: cellVerticalAlign } = inTable && editor
    ? getCellAlignment(editor)
    : { textAlign: null, verticalAlign: null }

  return (
    <DropdownMenu modal={modal} open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          tooltip="Table"
          aria-label="Table options"
          data-state={isOpen ? "open" : "closed"}
        >
          <TableIcon className="tiptap-button-icon" />
          <ChevronDownIcon className="tiptap-button-icon tiptap-button-dropdown-small" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={() => {
              editorRef.current?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            }}
          >
            <TableIcon className="tiptap-button-icon" />
            Insert table
          </DropdownMenuItem>
        </DropdownMenuGroup>

        {inTable && (
          <>
            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuLabel>Rows</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => editorRef.current?.chain().focus().addRowBefore().run()}>
                <TableRowInsertTopIcon className="tiptap-button-icon" />
                Add row above
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editorRef.current?.chain().focus().addRowAfter().run()}>
                <TableRowInsertBottomIcon className="tiptap-button-icon" />
                Add row below
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => editorRef.current?.chain().focus().deleteRow().run()}
              >
                <TableRowDeleteIcon className="tiptap-button-icon" />
                Delete row
              </DropdownMenuItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuLabel>Columns</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => editorRef.current?.chain().focus().addColumnBefore().run()}>
                <TableColumnInsertLeftIcon className="tiptap-button-icon" />
                Add column left
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editorRef.current?.chain().focus().addColumnAfter().run()}>
                <TableColumnInsertRightIcon className="tiptap-button-icon" />
                Add column right
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => editorRef.current?.chain().focus().deleteColumn().run()}
              >
                <TableColumnDeleteIcon className="tiptap-button-icon" />
                Delete column
              </DropdownMenuItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuLabel>Cells</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => editorRef.current?.chain().focus().mergeCells().run()}>
                <TableMergeCellsIcon className="tiptap-button-icon" />
                Merge cells
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editorRef.current?.chain().focus().splitCell().run()}>
                <TableSplitCellIcon className="tiptap-button-icon" />
                Split cell
              </DropdownMenuItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuLabel>Headers</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={headerRow}
                onSelect={() => editorRef.current?.chain().focus().toggleHeaderRow().run()}
              >
                Header row
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={headerColumn}
                onSelect={() => editorRef.current?.chain().focus().toggleHeaderColumn().run()}
              >
                Header column
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={headerCell}
                onSelect={() => editorRef.current?.chain().focus().toggleHeaderCell().run()}
              >
                Header cell
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuLabel>Horizontal alignment</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={cellTextAlign === "left" || cellTextAlign === null}
                onSelect={() => { if (editorRef.current) setCellAlignment(editorRef.current, "align", "left") }}
              >
                <AlignLeftIcon className="tiptap-button-icon" />
                Left
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={cellTextAlign === "center"}
                onSelect={() => { if (editorRef.current) setCellAlignment(editorRef.current, "align", "center") }}
              >
                <AlignCenterIcon className="tiptap-button-icon" />
                Center
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={cellTextAlign === "right"}
                onSelect={() => { if (editorRef.current) setCellAlignment(editorRef.current, "align", "right") }}
              >
                <AlignRightIcon className="tiptap-button-icon" />
                Right
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuLabel>Vertical alignment</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={cellVerticalAlign === "top"}
                onSelect={() => { if (editorRef.current) setCellAlignment(editorRef.current, "verticalAlign", "top") }}
              >
                <AlignTopIcon className="tiptap-button-icon" />
                Top
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={cellVerticalAlign === "middle"}
                onSelect={() => { if (editorRef.current) setCellAlignment(editorRef.current, "verticalAlign", "middle") }}
              >
                <AlignMiddleIcon className="tiptap-button-icon" />
                Middle
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={cellVerticalAlign === "bottom"}
                onSelect={() => { if (editorRef.current) setCellAlignment(editorRef.current, "verticalAlign", "bottom") }}
              >
                <AlignBottomIcon className="tiptap-button-icon" />
                Bottom
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => editorRef.current?.chain().focus().deleteTable().run()}
              >
                <TrashIcon className="tiptap-button-icon" />
                Delete table
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
