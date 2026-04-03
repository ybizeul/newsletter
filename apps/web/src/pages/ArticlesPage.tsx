import { type ClipboardEvent, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Combobox,
  ColorPicker,
  ColorSwatch,
  Group,
  Input,
  Loader,
  Menu,
  Modal,
  Paper,
  Pill,
  PillsInput,
  Popover,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
  useCombobox
} from "@mantine/core";
import { IconCheck, IconChevronDown, IconFilePlus, IconPencil, IconRefresh, IconSearch } from "@tabler/icons-react";
import * as TablerIcons from "@tabler/icons-react";
import MDEditor from "@uiw/react-md-editor";
import { renderToStaticMarkup } from "react-dom/server";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import "../styles/markdown-editor.css";
import { createArticle, deleteArticle, listArticles, updateArticle } from "../lib/api";
import type { Article } from "../types/domain";

const DEMO_AUTHOR_ID = "demo-user";
const TABLER_ICON_MAP = TablerIcons as unknown as Record<string, React.ComponentType<{ size?: number }>>;

const DEFAULT_TOPIC_ICON_BG = "#228be6";
const DEFAULT_TOPIC_ICON_STROKE = "#ffffff";
const ARTICLES_PANE_WIDTH_STORAGE_KEY = "newsletter.articles.pane.width";
const TAG_COLORS = ["blue", "teal", "cyan", "grape", "indigo", "violet", "lime", "orange", "pink"] as const;

function getStoredArticlesPaneWidth(): number {
  const raw = window.localStorage.getItem(ARTICLES_PANE_WIDTH_STORAGE_KEY);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 340;
  }
  return Math.min(Math.max(parsed, 260), 900);
}

function extractTopicIconBackgroundColor(illustration?: string): string {
  if (!illustration || !illustration.startsWith("data:image/svg+xml,")) {
    return DEFAULT_TOPIC_ICON_BG;
  }

  try {
    const decoded = decodeURIComponent(illustration.replace("data:image/svg+xml,", ""));
    const match = decoded.match(/<circle[^>]*fill="([^"]+)"/i);
    return match?.[1] ?? DEFAULT_TOPIC_ICON_BG;
  } catch {
    return DEFAULT_TOPIC_ICON_BG;
  }
}

function extractTopicIconStrokeColor(illustration?: string): string {
  if (!illustration || !illustration.startsWith("data:image/svg+xml,")) {
    return DEFAULT_TOPIC_ICON_STROKE;
  }

  try {
    const decoded = decodeURIComponent(illustration.replace("data:image/svg+xml,", ""));
    const match = decoded.match(/<g[^>]*color="([^"]+)"/i);
    return match?.[1] ?? DEFAULT_TOPIC_ICON_STROKE;
  } catch {
    return DEFAULT_TOPIC_ICON_STROKE;
  }
}

function buildTopicIconIllustration(iconName: string, circleColor: string, strokeColor: string): string {
  const IconComponent = TABLER_ICON_MAP[iconName];
  if (!IconComponent) {
    return "";
  }

  const iconSvgRaw = renderToStaticMarkup(<IconComponent size={22} />);
  const iconInner = iconSvgRaw
    .replace(/^<svg[^>]*>/i, "")
    .replace(/<\/svg>$/i, "");
  const iconSvg = `<g transform="translate(8 8)" color="${strokeColor}" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconInner}</g>`;

  const finalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="${circleColor}"/>${iconSvg}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(finalSvg)}`;
}

function resolveTablerIconName(input: string): string {
  const raw = input.trim();
  if (!raw) {
    return "";
  }

  if (TABLER_ICON_MAP[raw]) {
    return raw;
  }

  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) {
    return "";
  }

  const candidates = Object.keys(TABLER_ICON_MAP).filter((name) => name.startsWith("Icon"));

  const exact = candidates.find((name) => name.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }

  const withoutPrefix = candidates.find(
    (name) => name.replace(/^Icon/, "").toLowerCase() === normalized
  );
  if (withoutPrefix) {
    return withoutPrefix;
  }

  const partial = candidates.find((name) =>
    name.replace(/^Icon/, "").toLowerCase().includes(normalized)
  );
  return partial ?? "";
}

function formatArticleCreatedAt(value: string): string {
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

function colorForTag(tag: string): (typeof TAG_COLORS)[number] {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) {
    hash = (hash << 5) - hash + tag.charCodeAt(i);
    hash |= 0;
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
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

export default function ArticlesPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveClearSavedRef = useRef<number | null>(null);
  const lastSavedDraftRef = useRef<string>("");
  const [leftPaneWidth, setLeftPaneWidth] = useState(getStoredArticlesPaneWidth);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedArticleId, setSelectedArticleID] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [topicIcon, setTopicIcon] = useState("");
  const [topicIconBgColor, setTopicIconBgColor] = useState(DEFAULT_TOPIC_ICON_BG);
  const [topicIconStrokeColor, setTopicIconStrokeColor] = useState(DEFAULT_TOPIC_ICON_STROKE);
  const [isBgPickerOpen, setIsBgPickerOpen] = useState(false);
  const [isStrokePickerOpen, setIsStrokePickerOpen] = useState(false);
  const [isIconBrowserOpen, setIsIconBrowserOpen] = useState(false);
  const [articleSearchQuery, setArticleSearchQuery] = useState("");
  const [articleSearchCriteria, setArticleSearchCriteria] = useState({
    title: true,
    content: true,
    tag: false
  });
  const [articleSortMode, setArticleSortMode] = useState<"recent" | "last-used" | "most-sent">("recent");
  const [iconSearch, setIconSearch] = useState("");
  const [tagSearch, setTagSearch] = useState("");
  const [pastedImageMap, setPastedImageMap] = useState<Record<string, string>>({});
  const [editingId, setEditingID] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteArticleId, setDeleteArticleId] = useState<string | null>(null);
  const [hasLoadedArticles, setHasLoadedArticles] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const loadArticles = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const items = await listArticles();
      setArticles(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load articles");
    } finally {
      setIsLoading(false);
      setHasLoadedArticles(true);
    }
  };

  useEffect(() => {
    void loadArticles();
  }, []);

  const resetForm = () => {
    setTitle("");
    setMarkdown("");
    setTags([]);
    setTopicIcon("");
    setTopicIconBgColor(DEFAULT_TOPIC_ICON_BG);
    setTopicIconStrokeColor(DEFAULT_TOPIC_ICON_STROKE);
    setPastedImageMap({});
    setEditingID(null);
    setSelectedArticleID(null);
    lastSavedDraftRef.current = "";
    setAutosaveStatus("idle");
  };

  const resolvePastedImageTokens = (input: string): string =>
    input.replace(/paste:\/\/([a-zA-Z0-9_-]+)/g, (_, token) => pastedImageMap[token] ?? "");

  const normalizeMarkdownForEditor = (
    input: string
  ): { normalized: string; imageMap: Record<string, string> } => {
    const imageMap: Record<string, string> = {};

    const normalized = input.replace(/!\[([^\]]*)\]\((data:image\/[^)]+)\)/g, (_, alt, dataUrl) => {
      const token = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      imageMap[token] = dataUrl;
      return `![${alt}](paste://${token})`;
    });

    return { normalized, imageMap };
  };

  const resolveImageSource = (src: string | undefined) => {
    if (!src) {
      return "";
    }
    if (src.startsWith("paste://")) {
      const token = src.slice("paste://".length);
      return pastedImageMap[token] ?? "";
    }
    return src;
  };

  const onEdit = (article: Article) => {
    setEditingID(article.id);
    setSelectedArticleID(article.id);
    setTitle(article.title);
    setTags(article.tags ?? []);
    const normalized = normalizeMarkdownForEditor(article.markdown);
    setMarkdown(normalized.normalized);
    setPastedImageMap(normalized.imageMap);
    setTopicIcon(article.topicIcon ?? "");
    setTopicIconBgColor(extractTopicIconBackgroundColor(article.illustration));
    setTopicIconStrokeColor(extractTopicIconStrokeColor(article.illustration));
    lastSavedDraftRef.current = JSON.stringify({
      title: article.title,
      markdown: article.markdown,
      tags: article.tags ?? [],
      topicIcon: article.topicIcon ?? "",
      illustration: article.illustration ?? ""
    });
    setAutosaveStatus("idle");
  };

  const resolvedTopicIconName = useMemo(() => resolveTablerIconName(topicIcon), [topicIcon]);

  const generatedTopicIconIllustration = useMemo(
    () => buildTopicIconIllustration(resolvedTopicIconName, topicIconBgColor, topicIconStrokeColor),
    [resolvedTopicIconName, topicIconBgColor, topicIconStrokeColor]
  );

  useEffect(() => {
    if (articles.length === 0) {
      return;
    }

    if (selectedArticleId === null && editingId === null) {
      onEdit(articles[0]);
      return;
    }

    if (selectedArticleId && !articles.some((article) => article.id === selectedArticleId)) {
      resetForm();
    }
  }, [articles]);

  const buildArticleDraftPayload = () => ({
    title: title.trim(),
    markdown: resolvePastedImageTokens(markdown.trim()),
    tags,
    topicIcon: topicIcon.trim(),
    illustration: generatedTopicIconIllustration
  });

  const onSubmit = async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const payload = buildArticleDraftPayload();

      if (editingId) {
        const updated = await updateArticle(editingId, payload);

        setArticles((current) =>
          current.map((article) => (article.id === editingId ? updated : article))
        );
        setSelectedArticleID(updated.id);
        lastSavedDraftRef.current = JSON.stringify(payload);
        setAutosaveStatus("saved");
      } else {
        const created = await createArticle({
          authorId: DEMO_AUTHOR_ID,
          ...payload
        });

        setArticles((current) => [created, ...current]);
        setSelectedArticleID(created.id);
        setEditingID(created.id);
        lastSavedDraftRef.current = JSON.stringify(payload);
        setAutosaveStatus("saved");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save article");
      setAutosaveStatus("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!editingId) {
      return;
    }

    const payload = buildArticleDraftPayload();
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === lastSavedDraftRef.current) {
      return;
    }

    if (!payload.title) {
      return;
    }

    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = window.setTimeout(async () => {
      setAutosaveStatus("saving");
      try {
        const updated = await updateArticle(editingId, payload);
        setArticles((current) =>
          current.map((article) => (article.id === editingId ? updated : article))
        );
        lastSavedDraftRef.current = serializedPayload;
        setAutosaveStatus("saved");

        if (autosaveClearSavedRef.current !== null) {
          window.clearTimeout(autosaveClearSavedRef.current);
        }
        autosaveClearSavedRef.current = window.setTimeout(() => {
          setAutosaveStatus("idle");
        }, 1200);
      } catch (err) {
        setAutosaveStatus("error");
        setError(err instanceof Error ? err.message : "Failed to autosave article");
      }
    }, 900);

    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
      }
    };
  }, [editingId, title, markdown, tags, topicIcon, generatedTopicIconIllustration, pastedImageMap]);

  useEffect(() => () => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    if (autosaveClearSavedRef.current !== null) {
      window.clearTimeout(autosaveClearSavedRef.current);
    }
  }, []);

  const requestDeleteArticle = (articleId: string) => {
    setDeleteArticleId(articleId);
  };

  const confirmDeleteArticle = async () => {
    if (!deleteArticleId) {
      return;
    }

    setError(null);
    try {
      await deleteArticle(deleteArticleId);
      setArticles((current) => {
        const next = current.filter((article) => article.id !== deleteArticleId);
        if (selectedArticleId === deleteArticleId) {
          if (next.length > 0) {
            onEdit(next[0]);
          } else {
            resetForm();
          }
        }
        return next;
      });
      setDeleteArticleId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete article");
    }
  };

  const insertAtCursor = (
    target: HTMLTextAreaElement,
    currentText: string,
    insertion: string
  ): string => {
    const start = target.selectionStart ?? currentText.length;
    const end = target.selectionEnd ?? currentText.length;
    const next = currentText.slice(0, start) + insertion + currentText.slice(end);

    requestAnimationFrame(() => {
      const pos = start + insertion.length;
      target.selectionStart = pos;
      target.selectionEnd = pos;
    });

    return next;
  };

  const insertImageMarkdownFromFile = (target: HTMLTextAreaElement, file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Only image files are supported");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        const dataURL = reader.result;
        const token = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setPastedImageMap((current) => ({ ...current, [token]: dataURL }));
        setMarkdown((current) =>
          insertAtCursor(target, current, `\n![Pasted image](paste://${token})\n`)
        );
      }
    };
    reader.onerror = () => {
      setError("Failed to read image file");
    };
    reader.readAsDataURL(file);
  };

  const onPasteMarkdown = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData.items;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          setError(null);
          insertImageMarkdownFromFile(event.currentTarget, file);
          return;
        }
      }
    }

    const pastedText = event.clipboardData.getData("text/plain").trim();
    if (/(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg))/i.test(pastedText)) {
      event.preventDefault();
      setError(null);
      setMarkdown((current) =>
        insertAtCursor(event.currentTarget, current, `\n![Pasted image](${pastedText})\n`)
      );
    }
  };

  const filteredIconNames = useMemo(() => {
    const query = iconSearch.trim().toLowerCase();
    return Object.keys(TablerIcons)
      .filter((name) => name.startsWith("Icon") && name !== "Icon")
      .filter((name) => (query ? name.toLowerCase().includes(query) : true))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 300);
  }, [iconSearch]);

  const filteredArticles = useMemo(() => {
    const query = articleSearchQuery.trim().toLowerCase();
    if (!query) {
      return articles;
    }

    const hasAnyCriteria =
      articleSearchCriteria.title || articleSearchCriteria.content || articleSearchCriteria.tag;
    if (!hasAnyCriteria) {
      return articles;
    }

    const words = query.split(/\s+/).filter(Boolean);
    return articles.filter((article) => {
      const haystackParts: string[] = [];
      if (articleSearchCriteria.title) {
        haystackParts.push(article.title);
      }
      if (articleSearchCriteria.content) {
        haystackParts.push(article.markdown);
      }
      if (articleSearchCriteria.tag) {
        haystackParts.push((article.tags ?? []).join(" "));
      }

      const haystack = haystackParts.join(" ").toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [articleSearchQuery, articleSearchCriteria, articles]);

  const sortedArticles = useMemo(() => {
    const items = [...filteredArticles];
    items.sort((a, b) => {
      if (articleSortMode === "most-sent") {
        const sentDelta = (b.sentCount ?? 0) - (a.sentCount ?? 0);
        if (sentDelta !== 0) {
          return sentDelta;
        }
      }

      if (articleSortMode === "last-used" || articleSortMode === "most-sent") {
        const aLast = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
        const bLast = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
        if (bLast !== aLast) {
          return bLast - aLast;
        }
      }

      const aCreated = new Date(a.createdAt).getTime();
      const bCreated = new Date(b.createdAt).getTime();
      return bCreated - aCreated;
    });
    return items;
  }, [filteredArticles, articleSortMode]);

  const existingTags = useMemo(() => {
    const unique = new Set<string>();
    for (const article of articles) {
      for (const tag of article.tags ?? []) {
        const normalized = tag.trim();
        if (normalized) {
          unique.add(normalized);
        }
      }
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [articles]);

  const tagCombobox = useCombobox({
    onDropdownClose: () => {
      tagCombobox.resetSelectedOption();
      setTagSearch("");
    }
  });

  const addTag = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }

    const exists = tags.some((tag) => tag.toLowerCase() === trimmed.toLowerCase());
    if (exists) {
      return;
    }

    setTags((current) => [...current, trimmed]);
  };

  const filteredTagOptions = useMemo(() => {
    const query = tagSearch.trim().toLowerCase();
    return existingTags
      .filter((tag) => !tags.some((selected) => selected.toLowerCase() === tag.toLowerCase()))
      .filter((tag) => (query ? tag.toLowerCase().includes(query) : true));
  }, [existingTags, tagSearch, tags]);

  const toggleSearchFilter = (key: "title" | "content" | "tag") => {
    setArticleSearchCriteria((current) => {
      const nextValue = !current[key];
      if (!nextValue) {
        const selectedCount = [current.title, current.content, current.tag].filter(Boolean).length;
        if (selectedCount <= 1) {
          return current;
        }
      }
      return {
        ...current,
        [key]: nextValue
      };
    });
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
      window.localStorage.setItem(ARTICLES_PANE_WIDTH_STORAGE_KEY, String(clampedWidth));
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
          <Text fw={600}>Articles ({articles.length})</Text>
          <Group gap="xs">
            <ActionIcon variant="light" onClick={resetForm} title="New article">
              <IconFilePlus size={16} />
            </ActionIcon>
            <ActionIcon variant="light" onClick={() => void loadArticles()} loading={isLoading} title="Refresh">
              <IconRefresh size={16} />
            </ActionIcon>
          </Group>
        </Group>

        <div style={{ padding: 10, borderBottom: "1px solid #e9ecef" }}>
          <TextInput
            radius="xl"
            leftSection={<IconSearch size={14} />}
            rightSectionWidth={44}
            rightSection={
              <Menu position="bottom-end" withArrow>
                <Menu.Target>
                  <ActionIcon variant="subtle" size="sm" aria-label="Filter and sort articles" mr={8}>
                    <IconChevronDown size={14} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Filter</Menu.Label>
                  <Menu.Item
                    closeMenuOnClick={false}
                    onClick={() => toggleSearchFilter("title")}
                    leftSection={<IconCheck size={14} style={{ opacity: articleSearchCriteria.title ? 1 : 0 }} />}
                  >
                    Title
                  </Menu.Item>
                  <Menu.Item
                    closeMenuOnClick={false}
                    onClick={() => toggleSearchFilter("content")}
                    leftSection={<IconCheck size={14} style={{ opacity: articleSearchCriteria.content ? 1 : 0 }} />}
                  >
                    Content
                  </Menu.Item>
                  <Menu.Item
                    closeMenuOnClick={false}
                    onClick={() => toggleSearchFilter("tag")}
                    leftSection={<IconCheck size={14} style={{ opacity: articleSearchCriteria.tag ? 1 : 0 }} />}
                  >
                    Tag
                  </Menu.Item>

                  <Menu.Divider />
                  <Menu.Label>Sort</Menu.Label>
                  <Menu.Item
                    leftSection={<IconCheck size={14} style={{ opacity: articleSortMode === "recent" ? 1 : 0 }} />}
                    onClick={() => setArticleSortMode("recent")}
                  >
                    Most recent
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconCheck size={14} style={{ opacity: articleSortMode === "last-used" ? 1 : 0 }} />}
                    onClick={() => setArticleSortMode("last-used")}
                  >
                    Last used
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconCheck size={14} style={{ opacity: articleSortMode === "most-sent" ? 1 : 0 }} />}
                    onClick={() => setArticleSortMode("most-sent")}
                  >
                    Most sent
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            }
            placeholder="Search"
            value={articleSearchQuery}
            onChange={(event) => setArticleSearchQuery(event.currentTarget.value)}
          />
        </div>

        <ScrollArea h="calc(100% - 110px)" offsetScrollbars>
          <Stack gap={0}>
            {sortedArticles.map((article) => (
              (() => {
                const preview = markdownPreview(article.markdown);
                const titleText = cutByChars(article.title, 72);
                const previewText = cutByChars(preview, 180);
                return (
              <div
                key={article.id}
                onClick={() => onEdit(article)}
                style={{
                  padding: 12,
                  borderBottom: "1px solid #f1f3f5",
                  cursor: "pointer",
                  backgroundColor: selectedArticleId === article.id ? "#f1fbff" : "transparent"
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
                      {formatArticleCreatedAt(article.createdAt)}
                    </Text>
                  </Group>
                  {previewText ? (
                    <Text size="xs" c="dimmed" lineClamp={3}>
                      {previewText}
                    </Text>
                  ) : null}
                  {article.tags && article.tags.length > 0 ? (
                    <Group gap={4} wrap="wrap">
                      {article.tags.map((tag) => (
                        <Badge key={`${article.id}-${tag}`} size="xs" variant="light" color={colorForTag(tag)}>
                          {tag}
                        </Badge>
                      ))}
                    </Group>
                  ) : null}
                </Stack>
              </div>
                );
              })()
            ))}
            {articles.length === 0 ? (
              <Text c="dimmed" size="sm" p="md">
                No articles yet.
              </Text>
            ) : sortedArticles.length === 0 ? (
              <Text c="dimmed" size="sm" p="md">
                No articles match your search.
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
        {!hasLoadedArticles ? (
          <Center h="100%">
            <Stack align="center" gap="xs">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">Loading articles...</Text>
            </Stack>
          </Center>
        ) : (
        <Stack>
          <Group justify="space-between">
            <Text fw={700}>{editingId ? "Edit Article" : "New Article"}</Text>
            {editingId ? (
              <Group gap="xs">
                <Button variant="default" size="xs" onClick={resetForm}>
                  Cancel
                </Button>
                <Button color="red" variant="light" size="xs" onClick={() => requestDeleteArticle(editingId)}>
                  Delete
                </Button>
              </Group>
            ) : null}
          </Group>

          <Group align="flex-end" wrap="nowrap">
            <UnstyledButton
              onClick={() => setIsIconBrowserOpen(true)}
              aria-label="Select topic icon"
              style={{
                width: 40,
                height: 40,
                borderRadius: 9999,
                border: "1px solid #dee2e6",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: generatedTopicIconIllustration ? "#fff" : "#f8f9fa",
                cursor: "pointer",
                padding: 0,
                overflow: "hidden",
                flexShrink: 0
              }}
            >
              {generatedTopicIconIllustration ? (
                <Box
                  component="img"
                  src={generatedTopicIconIllustration}
                  alt="Topic icon preview"
                  w={40}
                  h={40}
                  style={{ display: "block" }}
                />
              ) : (
                <Text size="xs" c="dimmed">
                  +
                </Text>
              )}
            </UnstyledButton>

            <TextInput
              style={{ flex: 1 }}
              label="Title"
              description="Internal article title used in the article list and newsletter sections."
              placeholder="Article title"
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </Group>

          <Combobox
            store={tagCombobox}
            onOptionSubmit={(value) => {
              addTag(value);
              setTagSearch("");
              tagCombobox.closeDropdown();
            }}
          >
            <Combobox.DropdownTarget>
              <PillsInput
                label="Tags"
                description="Optional tags for organizing and searching articles."
                onClick={() => tagCombobox.openDropdown()}
                style={{ fontFamily: "var(--mantine-font-family)" }}
              >
                <Pill.Group>
                  {tags.map((tag) => {
                    const color = colorForTag(tag);
                    return (
                      <Pill
                        key={`edit-tag-${tag}`}
                        withRemoveButton
                        onRemove={() => setTags((current) => current.filter((item) => item !== tag))}
                        style={{
                          backgroundColor: `var(--mantine-color-${color}-1)`,
                          color: `var(--mantine-color-${color}-8)`,
                          border: `1px solid var(--mantine-color-${color}-3)`,
                          fontFamily: "var(--mantine-font-family)",
                          fontWeight: 700,
                          textTransform: "uppercase"
                        }}
                      >
                        {tag}
                      </Pill>
                    );
                  })}

                  <Combobox.EventsTarget>
                    <PillsInput.Field
                      style={{ fontFamily: "var(--mantine-font-family)" }}
                      value={tagSearch}
                      placeholder={tags.length === 0 ? "Add tag and press Enter" : "Add tag"}
                      onFocus={() => tagCombobox.openDropdown()}
                      onBlur={() => {
                        addTag(tagSearch);
                        setTagSearch("");
                        tagCombobox.closeDropdown();
                      }}
                      onChange={(event) => {
                        tagCombobox.openDropdown();
                        tagCombobox.updateSelectedOptionIndex();
                        setTagSearch(event.currentTarget.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Backspace" && tagSearch.length === 0) {
                          event.preventDefault();
                          setTags((current) => current.slice(0, -1));
                        }

                        if (event.key === "Enter" || event.key === ",") {
                          event.preventDefault();
                          addTag(tagSearch);
                          setTagSearch("");
                        }
                      }}
                    />
                  </Combobox.EventsTarget>
                </Pill.Group>
              </PillsInput>
            </Combobox.DropdownTarget>

            <Combobox.Dropdown>
              <Combobox.Options>
                {filteredTagOptions.length > 0 ? (
                  filteredTagOptions.map((tag) => (
                    <Combobox.Option value={tag} key={`tag-option-${tag}`}>
                      {tag}
                    </Combobox.Option>
                  ))
                ) : (
                  <Combobox.Empty>No matching tags</Combobox.Empty>
                )}
              </Combobox.Options>
            </Combobox.Dropdown>
          </Combobox>

          <Input.Wrapper
            label="Content"
            description="Compose the article body. Pasted images are embedded inline."
          >
            <div data-color-mode="light">
              <MDEditor
                className="markdown-editor-monospace"
                value={markdown}
                onChange={(value) => setMarkdown(value ?? "")}
                preview="live"
                height={350}
                textareaProps={{
                  placeholder: "Write your article content (paste image inline)",
                  onPaste: onPasteMarkdown,
                  style: {
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace",
                    fontSize: 14,
                    lineHeight: 1.6
                  }
                }}
                previewOptions={{
                  components: {
                    img: ({ src, alt }) => {
                      const resolvedSrc = resolveImageSource(src);
                      if (!resolvedSrc) {
                        return null;
                      }
                      return (
                        <img
                          src={resolvedSrc}
                          alt={alt ?? "inline"}
                          style={{ maxWidth: "100%", height: "auto", borderRadius: 8 }}
                        />
                      );
                    }
                  }
                }}
              />
            </div>
          </Input.Wrapper>

          <Group justify="space-between">
            <Text size="xs" c={autosaveStatus === "error" ? "red" : "dimmed"}>
              {editingId
                ? autosaveStatus === "saving"
                  ? "Autosaving..."
                  : autosaveStatus === "saved"
                    ? "All changes saved"
                    : autosaveStatus === "error"
                      ? "Autosave failed"
                      : ""
                : ""}
            </Text>
            <Button leftSection={<IconPencil size={16} />} onClick={() => void onSubmit()} loading={isSubmitting}>
              {editingId ? "Save Changes" : "Create Article"}
            </Button>
          </Group>

          {error ? <Text c="red">{error}</Text> : null}
        </Stack>
        )}
      </div>

      <Modal
        opened={Boolean(deleteArticleId)}
        onClose={() => setDeleteArticleId(null)}
        title="Confirm deletion"
        centered
      >
        <Stack>
          <Text size="sm">Delete this article? This action cannot be undone.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteArticleId(null)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => void confirmDeleteArticle()}>
              Delete article
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={isIconBrowserOpen}
        onClose={() => setIsIconBrowserOpen(false)}
        title="Icon designer"
        size="xl"
      >
        <Stack>
          <Paper withBorder p="sm" radius="md">
            <Stack gap="sm" align="center">
              <UnstyledButton
                onClick={() => setTopicIcon("")}
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 9999,
                  border: "1px solid #dee2e6",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: generatedTopicIconIllustration ? "#fff" : "#f8f9fa",
                  padding: 0,
                  overflow: "hidden",
                  cursor: "pointer"
                }}
              >
                {generatedTopicIconIllustration ? (
                  <Box
                    component="img"
                    src={generatedTopicIconIllustration}
                    alt="Current icon preview"
                    w={96}
                    h={96}
                    style={{ display: "block" }}
                  />
                ) : (
                  <Text size="xl" c="dimmed">
                    +
                  </Text>
                )}
              </UnstyledButton>

              <Group gap="md" align="center" justify="center">
                <Popover opened={isBgPickerOpen} onChange={setIsBgPickerOpen} position="bottom" shadow="md">
                  <Popover.Target>
                    <UnstyledButton onClick={() => setIsBgPickerOpen((v) => !v)}>
                      <Group gap={8}>
                        <ColorSwatch color={topicIconBgColor} size={22} />
                        <Text size="sm">Background</Text>
                      </Group>
                    </UnstyledButton>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <ColorPicker
                      format="hex"
                      value={topicIconBgColor}
                      onChange={setTopicIconBgColor}
                      swatches={["#228be6", "#15aabf", "#40c057", "#fab005", "#fd7e14", "#fa5252", "#ae3ec9", "#495057"]}
                    />
                  </Popover.Dropdown>
                </Popover>

                <Popover opened={isStrokePickerOpen} onChange={setIsStrokePickerOpen} position="bottom" shadow="md">
                  <Popover.Target>
                    <UnstyledButton onClick={() => setIsStrokePickerOpen((v) => !v)}>
                      <Group gap={8}>
                        <ColorSwatch color={topicIconStrokeColor} size={22} />
                        <Text size="sm">Stroke</Text>
                      </Group>
                    </UnstyledButton>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <ColorPicker
                      format="hex"
                      value={topicIconStrokeColor}
                      onChange={setTopicIconStrokeColor}
                      swatches={["#ffffff", "#f8f9fa", "#dee2e6", "#212529", "#000000"]}
                    />
                  </Popover.Dropdown>
                </Popover>
              </Group>
            </Stack>

            <Group justify="flex-end" mt="sm">
              <Group gap="xs">
                <Button variant="subtle" color="gray" onClick={() => setTopicIcon("")}>
                  Clear icon
                </Button>
                <Button variant="default" onClick={() => setIsIconBrowserOpen(false)}>
                  Done
                </Button>
              </Group>
            </Group>
          </Paper>

          <TextInput
            label="Search icon"
            description="Filter Tabler icon names before selecting one for the topic icon."
            placeholder="Search icon name (e.g. sparkles, mail, chart)"
            value={iconSearch}
            onChange={(event) => setIconSearch(event.currentTarget.value)}
          />

          <ScrollArea h={420}>
            <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="xs">
              {filteredIconNames.map((iconName) => {
                const IconComponent = TABLER_ICON_MAP[iconName];

                if (!IconComponent) {
                  return null;
                }

                const isSelected = topicIcon === iconName;
                return (
                  <UnstyledButton
                    key={iconName}
                    onClick={() => {
                      setTopicIcon(iconName);
                    }}
                    style={{
                      border: isSelected ? "1px solid #228be6" : "1px solid #dee2e6",
                      borderRadius: 8,
                      background: isSelected ? "#e7f5ff" : "#fff",
                      cursor: "pointer",
                      padding: "10px 8px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 6
                    }}
                  >
                    <IconComponent size={20} />
                    <Text size="xs" ta="center" lineClamp={2}>
                      {iconName}
                    </Text>
                  </UnstyledButton>
                );
              })}
            </SimpleGrid>
          </ScrollArea>
        </Stack>
      </Modal>
    </div>
  );
}
