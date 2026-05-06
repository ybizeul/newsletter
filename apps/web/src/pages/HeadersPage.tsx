import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import {
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { createHeader, deleteHeader, listHeaders, renderMarkdown, updateHeader } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Header } from "../types/domain";
import { SimpleEditor } from "@/components/tiptap-templates/simple/simple-editor";

const FALLBACK_CREATOR_ID = "demo-user";
const HEADERS_PANE_WIDTH_STORAGE_KEY = "newsletter.headers.pane.width";











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

function markdownPreview(input: string, maxLines = 3): string {
  const plain = input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[\t ]{0,3}#{1,6}[\t ]+/gm, "")
    .replace(/^[\t ]{0,3}>[\t ]?/gm, "")
    .replace(/^[\t ]*[-*+][\t ]+/gm, "")
    .replace(/^[\t ]*\d+\.[\t ]+/gm, "")
    .replace(/[\*_~]/g, "")
    .replace(/\r/g, "");

  const lines = plain
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .map((line) => line.replace(/\s+/g, " "));

  return lines.join(" ");
}

function cutByChars(input: string, maxChars: number): string {
  const clean = input.trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  return `${clean.slice(0, maxChars).trimEnd()}...`;
}

function looksLikeHTML(input: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(input);
}



export default function HeadersPage() {
  const { oidcEnabled } = useAuth();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveClearSavedRef = useRef<number | null>(null);
  const lastSavedDraftRef = useRef<string>("");
  const [leftPaneWidth, setLeftPaneWidth] = useState(getStoredHeadersPaneWidth);
  const isMobile = useMediaQuery("(max-width: 48em)");
  const [isMobileEditorOpen, setIsMobileEditorOpen] = useState(false);
  const [headers, setHeaders] = useState<Header[]>([]);
  const [selectedHeaderId, setSelectedHeaderID] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [headerContentHTML, setHeaderContentHTML] = useState("");
  const [headerEditorKey, setHeaderEditorKey] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDuplicatingHeader, setIsDuplicatingHeader] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [deleteHeaderId, setDeleteHeaderId] = useState<string | null>(null);
  const [isManualNewHeaderMode, setIsManualNewHeaderMode] = useState(false);

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

  const resetForm = () => {
    setSelectedHeaderID(null);
    setTitle("");
    setHeaderContentHTML("");
    setHeaderEditorKey("");
    lastSavedDraftRef.current = "";
    setAutosaveStatus("idle");
  };

  const onSelectHeader = async (header: Header) => {
    setIsManualNewHeaderMode(false);
    setSelectedHeaderID(header.id);
    setTitle(header.title);

    const rawContent = header.markdown ?? "";
    if (looksLikeHTML(rawContent)) {
      setHeaderContentHTML(rawContent);
      setHeaderEditorKey(header.id);
      lastSavedDraftRef.current = JSON.stringify({ title: header.title.trim(), markdown: rawContent });
      setAutosaveStatus("idle");
      if (isMobile) {
        setIsMobileEditorOpen(true);
      }
      return;
    }

    try {
      const html = await renderMarkdown(rawContent);
      setHeaderContentHTML(html || "");
      setHeaderEditorKey(header.id);
      lastSavedDraftRef.current = JSON.stringify({ title: header.title.trim(), markdown: html || "" });
      setAutosaveStatus("idle");
      if (isMobile) {
        setIsMobileEditorOpen(true);
      }
    } catch {
      setHeaderContentHTML("");
      setHeaderEditorKey(header.id);
      lastSavedDraftRef.current = JSON.stringify({ title: header.title.trim(), markdown: "" });
      setAutosaveStatus("idle");
      if (isMobile) {
        setIsMobileEditorOpen(true);
      }
    }
  };

  useEffect(() => {
    if (headers.length === 0) {
      return;
    }

    if (isMobile && !selectedHeaderId) {
      return;
    }

    if (!selectedHeaderId) {
      if (isManualNewHeaderMode) {
        return;
      }
      void onSelectHeader(headers[0]);
      return;
    }

    if (!headers.some((header) => header.id === selectedHeaderId)) {
      setIsManualNewHeaderMode(false);
      resetForm();
    }
  }, [headers, isMobile, selectedHeaderId, isManualNewHeaderMode]);

  useEffect(() => {
    if (!isMobile) {
      setIsMobileEditorOpen(false);
    }
  }, [isMobile]);

  const onSave = async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }

    const markdown = headerContentHTML;
    setError(null);
    setIsSubmitting(true);

    try {
      if (selectedHeaderId) {
        const updated = await updateHeader(selectedHeaderId, {
          title: title.trim(),
          markdown
        });
        setHeaders((current) => current.map((header) => (header.id === selectedHeaderId ? updated : header)));
        lastSavedDraftRef.current = JSON.stringify({ title: title.trim(), markdown });
        setAutosaveStatus("saved");
      } else {
        const created = await createHeader({
          creatorId: oidcEnabled ? undefined : FALLBACK_CREATOR_ID,
          title: title.trim(),
          markdown
        });
        setHeaders((current) => [created, ...current]);
        setSelectedHeaderID(created.id);
        setIsManualNewHeaderMode(false);
        lastSavedDraftRef.current = JSON.stringify({ title: created.title.trim(), markdown: created.markdown });
        setAutosaveStatus("idle");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save header");
      setAutosaveStatus("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!selectedHeaderId || isSubmitting) {
      return;
    }

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      return;
    }

    const markdown = headerContentHTML;
    const serializedPayload = JSON.stringify({ title: trimmedTitle, markdown });
    if (serializedPayload === lastSavedDraftRef.current) {
      return;
    }

    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = window.setTimeout(async () => {
      const savingStartedAt = Date.now();
      setAutosaveStatus("saving");
      try {
        const updated = await updateHeader(selectedHeaderId, {
          title: trimmedTitle,
          markdown
        });
        setHeaders((current) => current.map((header) => (header.id === selectedHeaderId ? updated : header)));
        lastSavedDraftRef.current = serializedPayload;
        if (autosaveClearSavedRef.current !== null) {
          window.clearTimeout(autosaveClearSavedRef.current);
        }
        const remainingSavingMs = Math.max(0, 1000 - (Date.now() - savingStartedAt));
        autosaveClearSavedRef.current = window.setTimeout(() => {
          setAutosaveStatus("idle");
        }, remainingSavingMs);
      } catch (err) {
        setAutosaveStatus("error");
      }
    }, 900);

    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
      }
    };
  }, [selectedHeaderId, title, headerContentHTML, isSubmitting]);

  useEffect(() => () => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    if (autosaveClearSavedRef.current !== null) {
      window.clearTimeout(autosaveClearSavedRef.current);
    }
  }, []);

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
        if (isMobile) {
          setIsMobileEditorOpen(false);
        }
      }
      setDeleteHeaderId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete header");
    }
  };

  const onDuplicateHeader = async () => {
    if (!selectedHeaderId) {
      return;
    }

    const source = headers.find((header) => header.id === selectedHeaderId);
    if (!source) {
      setError("Selected header was not found");
      return;
    }

    setIsDuplicatingHeader(true);
    setError(null);

    try {
      const created = await createHeader({
        creatorId: oidcEnabled ? undefined : FALLBACK_CREATOR_ID,
        title: `${source.title} (copy)`,
        markdown: source.markdown
      });

      setHeaders((current) => [created, ...current]);
      void onSelectHeader(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to duplicate header");
    } finally {
      setIsDuplicatingHeader(false);
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
        gridTemplateColumns: isMobile ? "1fr" : `${leftPaneWidth}px 1fr`,
        gap: 0,
        height: "calc(100vh - 60px)",
        minHeight: 560,
        position: "relative"
      }}
    >
      <div style={{ overflow: "hidden", display: isMobile && isMobileEditorOpen ? "none" : undefined }}>
        <Group justify="space-between" p="sm" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
          <Text fw={600}>Headers ({headers.length})</Text>
          <Group gap="xs">
            <Button
              variant="light"
              size="xs"
              onClick={() => {
                setIsManualNewHeaderMode(true);
                resetForm();
                if (isMobile) {
                  setIsMobileEditorOpen(true);
                }
              }}
            >
              New
            </Button>
          </Group>
        </Group>

        <ScrollArea h="calc(100% - 52px)" offsetScrollbars>
          <Stack gap={0}>
            {headers.map((header) => (
              (() => {
                const preview = markdownPreview(header.markdown);
                const titleText = cutByChars(header.title, 72);
                const previewText = cutByChars(preview, 180);
                return (
              <div
                key={header.id}
                onClick={() => void onSelectHeader(header)}
                style={{
                  padding: 12,
                  borderBottom: "1px solid var(--mantine-color-default-border)",
                  cursor: "pointer",
                  backgroundColor: selectedHeaderId === header.id ? "var(--mantine-primary-color-light)" : "transparent"
                }}
              >
                <Stack gap={6} style={{ flex: 1 }}>
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                    <Text
                      fw={700}
                      size="sm"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis"
                      }}
                    >
                      {titleText}
                    </Text>
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                      {formatHeaderCreatedAt(header.createdAt)}
                    </Text>
                  </Group>
                  {previewText ? (
                    <Text size="xs" c="dimmed" lineClamp={3}>
                      {previewText}
                    </Text>
                  ) : null}
                </Stack>
              </div>
                );
              })()
            ))}
            {isLoading ? (
              <Group justify="center" p="md" gap="xs">
                <Loader size="sm" />
                <Text c="dimmed" size="sm">Loading headers...</Text>
              </Group>
            ) : headers.length === 0 ? (
              <Text c="dimmed" size="sm" p="md">
                No headers.
              </Text>
            ) : null}
          </Stack>
        </ScrollArea>
      </div>

      {!isMobile ? (
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
          background: "linear-gradient(to right, transparent 3px, var(--mantine-color-default-border) 3px, var(--mantine-color-default-border) 4px, transparent 4px)"
        }}
      />
      ) : null}

      <div style={{ padding: "12px clamp(8px, 2.5vw, 12px)", overflow: "auto", display: isMobile && !isMobileEditorOpen ? "none" : undefined }}>
        <Stack>
          <Group justify="space-between">
            <Group gap="xs" wrap="nowrap">
              {isMobile ? (
                <Button variant="subtle" size="xs" onClick={() => setIsMobileEditorOpen(false)}>
                  Back
                </Button>
              ) : null}
              {isMobile && selectedHeaderId ? (
                <Button
                  variant="light"
                  size="xs"
                  onClick={() => {
                    setIsManualNewHeaderMode(true);
                    resetForm();
                  }}
                >
                  New
                </Button>
              ) : null}
              <Text fw={700}>{selectedHeaderId ? "Edit Header" : "New Header"}</Text>
              {selectedHeaderId && (autosaveStatus === "saving" || autosaveStatus === "error") ? (
                <Text size="xs" c={autosaveStatus === "error" ? "red" : "dimmed"}>
                  {autosaveStatus === "saving" ? "Saving..." : "Autosave failed"}
                </Text>
              ) : null}
            </Group>
            {selectedHeaderId ? (
              <Group gap="xs">
                <Button
                  variant="default"
                  size="xs"
                  onClick={() => void onDuplicateHeader()}
                  loading={isDuplicatingHeader}
                >
                  Duplicate
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
            <SimpleEditor
              key={headerEditorKey}
              initialContent={headerContentHTML || undefined}
              onContentChange={setHeaderContentHTML}
            />
          </Stack>

          <Group justify="space-between">
            <div />
            <Group gap="xs">
              {!selectedHeaderId ? (
                <Button onClick={() => void onSave()} loading={isSubmitting}>
                  Create Header
                </Button>
              ) : null}
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
    </div>
  );
}
