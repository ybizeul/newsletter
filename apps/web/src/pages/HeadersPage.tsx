import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput
} from "@mantine/core";
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconChevronDown,
  IconBold,
  IconFilePlus,
  IconH1,
  IconItalic,
  IconRefresh,
  IconTable,
  IconTablePlus,
  IconTrash,
  IconUnderline
} from "@tabler/icons-react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Image from "@tiptap/extension-image";
import { TextStyle } from "@tiptap/extension-text-style";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TextAlign from "@tiptap/extension-text-align";
import { createHeader, deleteHeader, listHeaders, renderMarkdown, updateHeader } from "../lib/api";
import type { Header } from "../types/domain";
import "../styles/header-editor.css";

const DEMO_CREATOR_ID = "demo-user";
const HEADERS_PANE_WIDTH_STORAGE_KEY = "newsletter.headers.pane.width";

const HeaderImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      style: {
        default: "width:auto;max-width:none;height:auto;display:block;margin:8px auto;"
      }
    };
  }
}).configure({
  allowBase64: true
});

const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) => {
              if (!attributes.fontSize) {
                return {};
              }
              return { style: `font-size: ${attributes.fontSize}` };
            }
          }
        }
      }
    ];
  }
});

const FontFamily = Extension.create({
  name: "fontFamily",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (element) => element.style.fontFamily || null,
            renderHTML: (attributes) => {
              if (!attributes.fontFamily) {
                return {};
              }
              return { style: `font-family: ${attributes.fontFamily}` };
            }
          }
        }
      }
    ];
  }
});

const FONT_FAMILY_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Trebuchet", value: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
  { label: "Times", value: "'Times New Roman', Times, serif" },
  { label: "Courier", value: "'Courier New', Courier, monospace" }
];

const HeaderTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      style: {
        default: "width:100%;border-collapse:collapse;table-layout:fixed;--header-cell-border:1px solid #ced4da;",
        parseHTML: (element: HTMLElement) => {
          const rawStyle = (element.getAttribute("style") ?? "").trim();
          if (!rawStyle) {
            return "width:100%;border-collapse:collapse;table-layout:fixed;--header-cell-border:1px solid #ced4da;";
          }
          return rawStyle.endsWith(";") ? rawStyle : `${rawStyle};`;
        }
      },
      hideBorders: {
        default: false,
        parseHTML: (element: HTMLElement) => {
          if (element.getAttribute("data-hide-borders") === "true") {
            return true;
          }
          const style = (element.getAttribute("style") ?? "").toLowerCase();
          return /--header-cell-border\s*:\s*0(?:\b|;)/.test(style) ||
            /\bborder\s*:\s*(?:0|none|0px(?:\s+none)?(?:\s+transparent)?)\b/.test(style);
        },
        renderHTML: (attributes: { hideBorders?: boolean }) => {
          if (!attributes.hideBorders) {
            return {};
          }
          return { "data-hide-borders": "true" };
        }
      }
    };
  }
});

const HeaderTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      verticalAlign: {
        default: null,
        parseHTML: (element) => element.style.verticalAlign || null,
        renderHTML: (attributes) => {
          if (!attributes.verticalAlign) {
            return {};
          }
          return { style: `vertical-align:${attributes.verticalAlign};` };
        }
      }
    };
  }
});

const HeaderTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      verticalAlign: {
        default: null,
        parseHTML: (element) => element.style.verticalAlign || null,
        renderHTML: (attributes) => {
          if (!attributes.verticalAlign) {
            return {};
          }
          return { style: `vertical-align:${attributes.verticalAlign};` };
        }
      }
    };
  }
});

function getStoredHeadersPaneWidth(): number {
  const raw = window.localStorage.getItem(HEADERS_PANE_WIDTH_STORAGE_KEY);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 340;
  }
  return Math.min(Math.max(parsed, 260), 900);
}

function formatHeaderCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function looksLikeHTML(input: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(input);
}

function hasHiddenBorderMarker(styleValue: string): boolean {
  const lowered = styleValue.toLowerCase();
  return /--header-cell-border\s*:\s*0(?:\b|;)/.test(lowered) ||
    /\bborder\s*:\s*(?:0|none|0px(?:\s+none)?(?:\s+transparent)?)\b/.test(lowered);
}

function withHeaderCellBorderStyle(currentStyle: string | null | undefined, hidden: boolean): string {
  const base = (currentStyle ?? "").trim();
  const cleaned = base
    .replace(/--header-cell-border\s*:\s*[^;]+;?/gi, "")
    .replace(/border\s*:\s*(?:0|none|0px(?:\s+none)?(?:\s+transparent)?|1px\s+solid\s+#ced4da)\s*;?/gi, "")
    .trim();
  const normalized = cleaned.length > 0 ? (cleaned.endsWith(";") ? cleaned : `${cleaned};`) : "";
  const borderValue = hidden ? "0" : "1px solid #ced4da";
  const tableBorder = hidden ? "0" : "1px solid #ced4da";
  return `${normalized}--header-cell-border:${borderValue};border:${tableBorder};`;
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) {
        reject(new Error("Unable to read image"));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error("Unable to read image"));
    reader.readAsDataURL(file);
  });
}

export default function HeadersPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastTablePosRef = useRef<number | null>(null);
  const [leftPaneWidth, setLeftPaneWidth] = useState(getStoredHeadersPaneWidth);
  const [headers, setHeaders] = useState<Header[]>([]);
  const [selectedHeaderId, setSelectedHeaderID] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteHeaderId, setDeleteHeaderId] = useState<string | null>(null);
  const [tableDeletionAction, setTableDeletionAction] = useState<"row" | "column" | "table" | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      HeaderImage,
      TextStyle,
      FontSize,
      FontFamily,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      HeaderTable.configure({ resizable: true }),
      TableRow,
      HeaderTableHeader,
      HeaderTableCell
    ],
    content: "<p></p>",
    editorProps: {
      handlePaste: (_view, event) => {
        const fileItems = Array.from(event.clipboardData?.items ?? []).filter(
          (item) => item.kind === "file" && item.type.startsWith("image/")
        );

        if (fileItems.length === 0) {
          return false;
        }

        const file = fileItems[0].getAsFile();
        if (!file) {
          return false;
        }

        event.preventDefault();
        void readFileAsDataURL(file)
          .then((dataURL) => {
            editor?.chain().focus().setImage({ src: dataURL }).run();
          })
          .catch(() => {
            setError("Failed to paste image");
          });

        return true;
      }
    }
  });

  const loadHeaders = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const items = await listHeaders();
      setHeaders(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load headers");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadHeaders();
  }, []);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const updateCurrentTablePos = () => {
      const { $from } = editor.state.selection;
      let tablePos: number | null = null;

      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name === "table") {
          tablePos = $from.before(depth);
          break;
        }
      }

      // Keep the last valid table position so menu interactions do not drop context.
      if (tablePos !== null) {
        lastTablePosRef.current = tablePos;
      }
    };

    updateCurrentTablePos();
    editor.on("selectionUpdate", updateCurrentTablePos);

    return () => {
      editor.off("selectionUpdate", updateCurrentTablePos);
    };
  }, [editor]);

  const resetForm = () => {
    setSelectedHeaderID(null);
    setTitle("");
    lastTablePosRef.current = null;
    editor?.commands.setContent("<p></p>");
  };

  const normalizeEditorTableBorders = () => {
    if (!editor) {
      return;
    }

    const domTables = Array.from(editor.view.dom.querySelectorAll("table"));
    const tablePositions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "table") {
        tablePositions.push(pos);
      }
    });

    const transaction = editor.state.tr;
    tablePositions.forEach((pos, index) => {
      const tableNode = editor.state.doc.nodeAt(pos);
      if (!tableNode || tableNode.type.name !== "table") {
        return;
      }

      const domTable = domTables[index] ?? null;
      const nodeStyle = String(tableNode.attrs.style ?? "");
      const domStyle = domTable?.getAttribute("style") ?? "";
      const hidden =
        Boolean(tableNode.attrs.hideBorders) ||
        domTable?.getAttribute("data-hide-borders") === "true" ||
        hasHiddenBorderMarker(nodeStyle) ||
        hasHiddenBorderMarker(domStyle);

      transaction.setNodeMarkup(pos, undefined, {
        ...tableNode.attrs,
        style: withHeaderCellBorderStyle(nodeStyle || domStyle, hidden),
        hideBorders: hidden
      });

      if (domTable) {
        domTable.setAttribute("style", withHeaderCellBorderStyle(domStyle || nodeStyle, hidden));
        if (hidden) {
          domTable.setAttribute("data-hide-borders", "true");
        } else {
          domTable.removeAttribute("data-hide-borders");
        }
      }
    });

    if (transaction.docChanged) {
      editor.view.dispatch(transaction);
    }
  };

  const onSelectHeader = async (header: Header) => {
    setSelectedHeaderID(header.id);
    setTitle(header.title);
    lastTablePosRef.current = null;

    const rawContent = header.markdown ?? "";
    if (looksLikeHTML(rawContent)) {
      editor?.commands.setContent(rawContent || "<p></p>");
      requestAnimationFrame(normalizeEditorTableBorders);
      return;
    }

    try {
      const html = await renderMarkdown(rawContent);
      editor?.commands.setContent(html || "<p></p>");
      requestAnimationFrame(normalizeEditorTableBorders);
    } catch {
      editor?.commands.setContent("<p></p>");
    }
  };

  useEffect(() => {
    if (headers.length === 0) {
      return;
    }

    if (!selectedHeaderId) {
      void onSelectHeader(headers[0]);
      return;
    }

    if (!headers.some((header) => header.id === selectedHeaderId)) {
      resetForm();
    }
  }, [headers]);

  const onSave = async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }

    normalizeEditorTableBorders();
    const markdown = editor?.getHTML() ?? "";
    setError(null);
    setIsSubmitting(true);

    try {
      if (selectedHeaderId) {
        const updated = await updateHeader(selectedHeaderId, {
          title: title.trim(),
          markdown
        });
        setHeaders((current) => current.map((header) => (header.id === selectedHeaderId ? updated : header)));
      } else {
        const created = await createHeader({
          creatorId: DEMO_CREATOR_ID,
          title: title.trim(),
          markdown
        });
        setHeaders((current) => [created, ...current]);
        setSelectedHeaderID(created.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save header");
    } finally {
      setIsSubmitting(false);
    }
  };

  const requestDeleteHeader = (headerId: string) => {
    setDeleteHeaderId(headerId);
  };

  const confirmDeleteHeader = async () => {
    if (!deleteHeaderId) {
      return;
    }

    setError(null);
    try {
      await deleteHeader(deleteHeaderId);
      setHeaders((current) => current.filter((header) => header.id !== deleteHeaderId));
      if (selectedHeaderId === deleteHeaderId) {
        resetForm();
      }
      setDeleteHeaderId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete header");
    }
  };

  const requestDeleteTableElement = (action: "row" | "column" | "table") => {
    setTableDeletionAction(action);
  };

  const confirmDeleteTableElement = () => {
    if (!tableDeletionAction || !editor) {
      return;
    }

    const chain = editor.chain().focus();
    const deleted =
      tableDeletionAction === "row"
        ? chain.deleteRow().run()
        : tableDeletionAction === "column"
          ? chain.deleteColumn().run()
          : chain.deleteTable().run();

    if (!deleted) {
      setError("Place the cursor inside a table first");
      return;
    }

    setTableDeletionAction(null);
  };

  const setImageAlign = (align: "left" | "center" | "right") => {
    const styleByAlign = {
      left: "width:auto;max-width:none;height:auto;display:block;margin:8px auto 8px 0;",
      center: "width:auto;max-width:none;height:auto;display:block;margin:8px auto;",
      right: "width:auto;max-width:none;height:auto;display:block;margin:8px 0 8px auto;"
    } as const;
    editor?.chain().focus().updateAttributes("image", { style: styleByAlign[align] }).run();
  };

  const fontSizeLabel = () => {
    const attrs = editor?.getAttributes("textStyle");
    const raw = typeof attrs?.fontSize === "string" ? attrs.fontSize : "";
    return raw || "Font";
  };

  const setFontSize = (size: string | null) => {
    const chain = editor?.chain().focus();
    if (!chain) {
      return;
    }
    if (!size) {
      chain.setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run();
      return;
    }
    chain.setMark("textStyle", { fontSize: size }).run();
  };

  const fontFamilyLabel = () => {
    const attrs = editor?.getAttributes("textStyle");
    const raw = typeof attrs?.fontFamily === "string" ? attrs.fontFamily : "";
    if (!raw) {
      return "Text font";
    }
    const found = FONT_FAMILY_OPTIONS.find((option) => option.value === raw);
    return found?.label ?? "Text font";
  };

  const setFontFamily = (family: string | null) => {
    const chain = editor?.chain().focus();
    if (!chain) {
      return;
    }
    if (!family) {
      chain.setMark("textStyle", { fontFamily: null }).removeEmptyTextStyle().run();
      return;
    }
    chain.setMark("textStyle", { fontFamily: family }).run();
  };

  const setTableBordersHidden = (hidden: boolean) => {
    if (!editor) {
      return;
    }

    const syncVisibleTableBorders = () => {
      const tables = editor.view.dom.querySelectorAll("table");
      tables.forEach((table) => {
        const nextStyle = withHeaderCellBorderStyle(table.getAttribute("style"), hidden);
        table.setAttribute("style", nextStyle);
        if (hidden) {
          table.setAttribute("data-hide-borders", "true");
        } else {
          table.removeAttribute("data-hide-borders");
        }
      });
    };

    const findSelectedTablePos = (): number | null => {
      const { $from } = editor.state.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name === "table") {
          return $from.before(depth);
        }
      }
      return null;
    };

    const tablePositions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "table") {
        tablePositions.push(pos);
      }
    });

    if (tablePositions.length === 0) {
      setError("Insert a table first");
      return;
    }

    const selectedPos = findSelectedTablePos();
    if (selectedPos !== null) {
      lastTablePosRef.current = selectedPos;
    }

    const transaction = editor.state.tr;
    tablePositions.forEach((pos) => {
      const tableNode = editor.state.doc.nodeAt(pos);
      if (!tableNode || tableNode.type.name !== "table") {
        return;
      }
      transaction.setNodeMarkup(pos, undefined, {
        ...tableNode.attrs,
        style: withHeaderCellBorderStyle((tableNode.attrs.style as string | undefined) ?? "", hidden),
        hideBorders: hidden
      });
    });

    editor.view.dispatch(transaction);
    syncVisibleTableBorders();
  };

  const currentTableBordersLabel = () => {
    if (!editor) {
      return "Shown";
    }

    const fromSelection = (() => {
      const { $from } = editor.state.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name === "table") {
          const pos = $from.before(depth);
          const node = editor.state.doc.nodeAt(pos);
          return Boolean(node?.attrs?.hideBorders);
        }
      }
      return null;
    })();

    if (fromSelection !== null) {
      return fromSelection ? "Hidden" : "Shown";
    }

    const fallbackPos = lastTablePosRef.current;
    if (fallbackPos === null) {
      return "Shown";
    }

    const node = editor.state.doc.nodeAt(fallbackPos);
    return Boolean(node?.attrs?.hideBorders) ? "Hidden" : "Shown";
  };

  const setCellVerticalAlign = (align: "top" | "middle" | "bottom") => {
    const ok = editor?.chain().focus().setCellAttribute("verticalAlign", align).run();
    if (!ok) {
      setError("Place the cursor inside a table cell first");
    }
  };

  const startPaneResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const containerRect = containerRef.current?.getBoundingClientRect();
    const containerLeft = containerRect?.left ?? 0;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 1200;
      const minWidth = 260;
      const maxWidth = Math.max(minWidth, containerWidth - 420);
      const nextWidth = moveEvent.clientX - containerLeft;
      const clampedWidth = Math.min(Math.max(nextWidth, minWidth), maxWidth);
      setLeftPaneWidth(clampedWidth);
      window.localStorage.setItem(HEADERS_PANE_WIDTH_STORAGE_KEY, String(clampedWidth));
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return (
    <div
      ref={containerRef}
      style={{
        display: "grid",
        gridTemplateColumns: `${leftPaneWidth}px 1fr`,
        gap: 0,
        height: "calc(100vh - 120px)",
        minHeight: 560,
        position: "relative"
      }}
    >
      <div style={{ overflow: "hidden" }}>
        <Group justify="space-between" p="sm" style={{ borderBottom: "1px solid #e9ecef" }}>
          <Text fw={600}>Headers ({headers.length})</Text>
          <Group gap="xs">
            <ActionIcon variant="light" onClick={resetForm} title="New header">
              <IconFilePlus size={16} />
            </ActionIcon>
            <ActionIcon variant="light" onClick={() => void loadHeaders()} loading={isLoading} title="Refresh">
              <IconRefresh size={16} />
            </ActionIcon>
          </Group>
        </Group>

        <ScrollArea h="calc(100% - 52px)" offsetScrollbars>
          <Stack gap={0}>
            {headers.map((header) => (
              <div
                key={header.id}
                onClick={() => void onSelectHeader(header)}
                style={{
                  padding: 12,
                  borderBottom: "1px solid #f1f3f5",
                  cursor: "pointer",
                  backgroundColor: selectedHeaderId === header.id ? "#f1fbff" : "transparent"
                }}
              >
                <Group justify="space-between" align="flex-start">
                  <Stack gap={4} style={{ flex: 1 }}>
                    <Text fw={600} lineClamp={1}>
                      {header.title}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatHeaderCreatedAt(header.createdAt)}
                    </Text>
                  </Stack>
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    onClick={(event) => {
                      event.stopPropagation();
                      requestDeleteHeader(header.id);
                    }}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </div>
            ))}
            {headers.length === 0 ? (
              <Text c="dimmed" size="sm" p="md">
                No headers yet.
              </Text>
            ) : null}
          </Stack>
        </ScrollArea>
      </div>

      <div
        onMouseDown={startPaneResize}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: leftPaneWidth - 4,
          width: 8,
          cursor: "col-resize",
          zIndex: 20,
          background: "linear-gradient(to right, transparent 3px, #e9ecef 3px, #e9ecef 4px, transparent 4px)"
        }}
      />

      <div style={{ padding: 12, overflow: "auto" }}>
        <Stack>
          <Group justify="space-between">
            <Text fw={700}>{selectedHeaderId ? "Edit Header" : "New Header"}</Text>
            {selectedHeaderId ? (
              <Group gap="xs">
                <Button variant="default" size="xs" onClick={resetForm}>
                  Cancel
                </Button>
                <Button color="red" variant="light" size="xs" onClick={() => requestDeleteHeader(selectedHeaderId)}>
                  Delete
                </Button>
              </Group>
            ) : null}
          </Group>

          <TextInput
            label="Title"
            description="Reusable name for this newsletter header."
            placeholder="Customer Release Header"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />

          <Stack gap={6}>
            <Text fw={500} size="sm">
              Header Content
            </Text>
            <div className="header-editor-shell">
              <div className="header-editor-toolbar">
                <ActionIcon
                  variant={editor?.isActive("bold") ? "filled" : "light"}
                  onClick={() => editor?.chain().focus().toggleBold().run()}
                  title="Bold"
                >
                  <IconBold size={16} />
                </ActionIcon>
                <ActionIcon
                  variant={editor?.isActive("italic") ? "filled" : "light"}
                  onClick={() => editor?.chain().focus().toggleItalic().run()}
                  title="Italic"
                >
                  <IconItalic size={16} />
                </ActionIcon>
                <ActionIcon
                  variant={editor?.isActive("underline") ? "filled" : "light"}
                  onClick={() => editor?.chain().focus().toggleUnderline().run()}
                  title="Underline"
                >
                  <IconUnderline size={16} />
                </ActionIcon>
                <ActionIcon
                  variant={editor?.isActive("heading", { level: 1 }) ? "filled" : "light"}
                  onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
                  title="Heading"
                >
                  <IconH1 size={16} />
                </ActionIcon>
                <Menu shadow="md" width={220} position="bottom-start">
                  <Menu.Target>
                    <Button
                      variant="light"
                      size="compact-sm"
                      rightSection={<IconChevronDown size={14} />}
                      leftSection={<IconTable size={14} />}
                    >
                      Table
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>
                      <Group justify="space-between" wrap="nowrap" gap={8}>
                        <Text size="xs" c="dimmed">
                          Borders
                        </Text>
                        <Badge size="xs" variant="light" color={currentTableBordersLabel() === "Hidden" ? "orange" : "blue"}>
                          {currentTableBordersLabel()}
                        </Badge>
                      </Group>
                    </Menu.Label>
                    <Menu.Item
                      leftSection={<IconTablePlus size={14} />}
                      onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
                    >
                      Insert table
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item onClick={() => editor?.chain().focus().addRowBefore().run()}>Add row above</Menu.Item>
                    <Menu.Item onClick={() => editor?.chain().focus().addRowAfter().run()}>Add row below</Menu.Item>
                    <Menu.Item color="red" onClick={() => requestDeleteTableElement("row")}>Delete row</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item onClick={() => editor?.chain().focus().addColumnBefore().run()}>Add column left</Menu.Item>
                    <Menu.Item onClick={() => editor?.chain().focus().addColumnAfter().run()}>Add column right</Menu.Item>
                    <Menu.Item color="red" onClick={() => requestDeleteTableElement("column")}>Delete column</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item onClick={() => editor?.chain().focus().mergeCells().run()}>Merge cells</Menu.Item>
                    <Menu.Item onClick={() => editor?.chain().focus().splitCell().run()}>Split cell</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item onClick={() => setCellVerticalAlign("top")}>Cell align top</Menu.Item>
                    <Menu.Item onClick={() => setCellVerticalAlign("middle")}>Cell align middle</Menu.Item>
                    <Menu.Item onClick={() => setCellVerticalAlign("bottom")}>Cell align bottom</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item onClick={() => setTableBordersHidden(true)}>Hide borders</Menu.Item>
                    <Menu.Item onClick={() => setTableBordersHidden(false)}>Show borders</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item color="red" onClick={() => requestDeleteTableElement("table")}>
                      Delete table
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
                <Menu shadow="md" width={140} position="bottom-start">
                  <Menu.Target>
                    <Button variant="light" size="compact-sm" rightSection={<IconChevronDown size={14} />}>
                      {fontSizeLabel()}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => setFontSize("12px")}>12px</Menu.Item>
                    <Menu.Item onClick={() => setFontSize("14px")}>14px</Menu.Item>
                    <Menu.Item onClick={() => setFontSize("16px")}>16px</Menu.Item>
                    <Menu.Item onClick={() => setFontSize("18px")}>18px</Menu.Item>
                    <Menu.Item onClick={() => setFontSize("20px")}>20px</Menu.Item>
                    <Menu.Item onClick={() => setFontSize("24px")}>24px</Menu.Item>
                    <Menu.Item onClick={() => setFontSize("30px")}>30px</Menu.Item>
                    <Menu.Item onClick={() => setFontSize("36px")}>36px</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item onClick={() => setFontSize(null)}>Reset size</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
                <Menu shadow="md" width={180} position="bottom-start">
                  <Menu.Target>
                    <Button variant="light" size="compact-sm" rightSection={<IconChevronDown size={14} />}>
                      {fontFamilyLabel()}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {FONT_FAMILY_OPTIONS.map((option) => (
                      <Menu.Item key={option.value} onClick={() => setFontFamily(option.value)}>
                        {option.label}
                      </Menu.Item>
                    ))}
                    <Menu.Divider />
                    <Menu.Item onClick={() => setFontFamily(null)}>Reset font</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 6px",
                    borderLeft: "1px solid #dee2e6"
                  }}
                >
                  <Text size="xs" c="dimmed">
                    Text
                  </Text>
                  <Group gap={4} wrap="nowrap">
                    <ActionIcon
                      variant={editor?.isActive({ textAlign: "left" }) ? "filled" : "light"}
                      onClick={() => editor?.chain().focus().setTextAlign("left").run()}
                      title="Text align left"
                    >
                      <IconAlignLeft size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant={editor?.isActive({ textAlign: "center" }) ? "filled" : "light"}
                      onClick={() => editor?.chain().focus().setTextAlign("center").run()}
                      title="Text align center"
                    >
                      <IconAlignCenter size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant={editor?.isActive({ textAlign: "right" }) ? "filled" : "light"}
                      onClick={() => editor?.chain().focus().setTextAlign("right").run()}
                      title="Text align right"
                    >
                      <IconAlignRight size={16} />
                    </ActionIcon>
                  </Group>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 6px",
                    borderLeft: "1px solid #dee2e6"
                  }}
                >
                  <Text size="xs" c="dimmed">
                    Image
                  </Text>
                  <Group gap={4} wrap="nowrap">
                    <ActionIcon variant="light" onClick={() => setImageAlign("left")} title="Image align left">
                      <IconAlignLeft size={16} />
                    </ActionIcon>
                    <ActionIcon variant="light" onClick={() => setImageAlign("center")} title="Image align center">
                      <IconAlignCenter size={16} />
                    </ActionIcon>
                    <ActionIcon variant="light" onClick={() => setImageAlign("right")} title="Image align right">
                      <IconAlignRight size={16} />
                    </ActionIcon>
                  </Group>
                </div>
              </div>

              <div className="header-editor-content">
                <EditorContent editor={editor} />
              </div>
            </div>
            <Text size="xs" c="dimmed">
              Use the toolbar to style text, edit table structure (rows, columns, merge/split), and align text or images inside your header.
            </Text>
          </Stack>

          <Group justify="space-between">
            <Group gap="xs">
              <Button onClick={() => void onSave()} loading={isSubmitting}>
                {selectedHeaderId ? "Save Changes" : "Create Header"}
              </Button>
            </Group>
          </Group>

          {error ? <Text c="red">{error}</Text> : null}
        </Stack>
      </div>

      <Modal
        opened={Boolean(deleteHeaderId)}
        onClose={() => setDeleteHeaderId(null)}
        title="Confirm deletion"
        centered
      >
        <Stack>
          <Text size="sm">
            Delete this header? Newsletters that reference it will keep working without a header.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteHeaderId(null)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => void confirmDeleteHeader()}>
              Delete header
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={Boolean(tableDeletionAction)}
        onClose={() => setTableDeletionAction(null)}
        title="Confirm table change"
        centered
      >
        <Stack>
          <Text size="sm">
            {tableDeletionAction === "row"
              ? "Delete the selected table row?"
              : tableDeletionAction === "column"
                ? "Delete the selected table column?"
                : "Delete the current table?"}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setTableDeletionAction(null)}>
              Cancel
            </Button>
            <Button color="red" onClick={confirmDeleteTableElement}>
              Confirm
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
