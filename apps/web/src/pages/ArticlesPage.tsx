import { type ClipboardEvent, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Combobox,
  ColorInput,
  Group,
  Input,
  Loader,
  Menu,
  Modal,
  Paper,
  Pill,
  PillsInput,
  ScrollArea,
  Slider,
  SimpleGrid,
  Stack,
  Checkbox,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
  useCombobox
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconCheck, IconChevronDown, IconMail, IconPencil, IconPointFilled, IconSearch, IconUserFilled } from "@tabler/icons-react";
import MDEditor from "@uiw/react-md-editor";
import { renderToStaticMarkup } from "react-dom/server";
import { useParams } from "react-router-dom";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import "../styles/markdown-editor.css";
import { createArticle, deleteArticle, getArticle, getNewsletter, listArticleSummaries, listNewsletterSummaries, updateArticle, updateNewsletter } from "../lib/api";
import { claimArticle } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { TablerIconMap } from "../lib/tablerIconsBrowser";
import type { Article, ArticleSummary, NewsletterSummary } from "../types/domain";

const FALLBACK_AUTHOR_ID = "demo-user";

const DEFAULT_TOPIC_ICON_BG = "#228be6";
const DEFAULT_TOPIC_ICON_STROKE = "#ffffff";
const ARTICLES_PANE_WIDTH_STORAGE_KEY = "newsletter.articles.pane.width";
const FAVORITE_NEWSLETTER_ID_STORAGE_KEY = "newsletter.favorite.id";
const NEWSLETTER_MAX_CONTENT_WIDTH_PX = 680;
const ICON_PNG_RASTER_SIZE = 90;
const RECENT_ARTICLES_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TAG_COLORS = ["blue", "teal", "cyan", "grape", "indigo", "violet", "lime", "orange", "pink"] as const;

let cachedArticleSummaries: ArticleSummary[] | null = null;

type ArticleSmartFilter = "all" | "mine" | "recent" | "private" | "public";

function normalizeArticleSmartFilter(input?: string): ArticleSmartFilter {
  if (input === "mine" || input === "recent" || input === "private" || input === "public" || input === "all") {
    return input;
  }
  return "all";
}

function normalizeArticleSummaryVisibility(article: ArticleSummary): ArticleSummary {
  return {
    ...article,
    public: article.public !== false
  };
}

function getStoredArticlesPaneWidth(): number {
  const raw = window.localStorage.getItem(ARTICLES_PANE_WIDTH_STORAGE_KEY);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 340;
  }
  return Math.min(Math.max(parsed, 260), 900);
}

function getStoredFavoriteNewsletterId(): string | null {
  const raw = window.localStorage.getItem(FAVORITE_NEWSLETTER_ID_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function buildTopicIconIllustration(iconMap: TablerIconMap | null, iconName: string, circleColor: string, strokeColor: string): string {
  if (!iconMap) {
    return "";
  }

  const IconComponent = iconMap[iconName];
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

async function rasterizeSvgDataUrlToPngDataUrl(svgDataUrl: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const sourceWidth = img.naturalWidth || 40;
      const sourceHeight = img.naturalHeight || 40;
      canvas.width = ICON_PNG_RASTER_SIZE;
      canvas.height = ICON_PNG_RASTER_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to create icon canvas"));
        return;
      }

      const scale = Math.min(ICON_PNG_RASTER_SIZE / sourceWidth, ICON_PNG_RASTER_SIZE / sourceHeight);
      const drawWidth = sourceWidth * scale;
      const drawHeight = sourceHeight * scale;
      const offsetX = (ICON_PNG_RASTER_SIZE - drawWidth) / 2;
      const offsetY = (ICON_PNG_RASTER_SIZE - drawHeight) / 2;

      ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("Failed to rasterize icon"));
    img.src = svgDataUrl;
  });
}

function buildPastedImageTopicIconIllustration(imageDataUrl: string, circleColor: string, sizeDelta: number): string {
  const trimmed = imageDataUrl.trim();
  if (!trimmed || !trimmed.startsWith("data:image/svg+xml")) {
    return "";
  }

  const extractAspectRatioFromSvgDataUrl = (dataUrl: string): number | null => {
    const decoded = decodeSvgDataUrl(dataUrl);
    if (!decoded) {
      return null;
    }

    const viewBoxMatch = decoded.match(/viewBox\s*=\s*["']\s*[-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s*["']/i);
    if (viewBoxMatch) {
      const width = Number(viewBoxMatch[1]);
      const height = Number(viewBoxMatch[2]);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return width / height;
      }
    }

    const widthMatch = decoded.match(/\bwidth\s*=\s*["']\s*([-+]?\d*\.?\d+)/i);
    const heightMatch = decoded.match(/\bheight\s*=\s*["']\s*([-+]?\d*\.?\d+)/i);
    if (widthMatch && heightMatch) {
      const width = Number(widthMatch[1]);
      const height = Number(heightMatch[1]);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return width / height;
      }
    }

    return null;
  };

  const clampedDelta = Math.min(Math.max(sizeDelta, -100), 100);
  const scale = 1 + clampedDelta / 100;
  const insetSize = 40 * scale;
  const insetOffset = (40 - insetSize) / 2;
  const aspectRatio = extractAspectRatioFromSvgDataUrl(trimmed) ?? 1;

  const imageWidth = aspectRatio >= 1 ? insetSize : insetSize * aspectRatio;
  const imageHeight = aspectRatio >= 1 ? insetSize / aspectRatio : insetSize;
  const imageX = insetOffset + (insetSize - imageWidth) / 2;
  const imageY = insetOffset + (insetSize - imageHeight) / 2;

  const finalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><defs><clipPath id="topicIconClip"><circle cx="20" cy="20" r="20"/></clipPath></defs><circle cx="20" cy="20" r="20" fill="${circleColor}"/><g clip-path="url(#topicIconClip)"><image href="${trimmed}" x="${imageX}" y="${imageY}" width="${imageWidth}" height="${imageHeight}" preserveAspectRatio="none"/></g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(finalSvg)}`;
}

function isSvgImageFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (mime === "image/svg+xml") {
    return true;
  }
  return file.name.toLowerCase().endsWith(".svg");
}

function extractSvgMarkup(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/<svg[\s\S]*<\/svg>/i);
  return (match?.[0] ?? "").trim();
}

function decodeHtmlEntities(input: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = input;
  return textarea.value;
}

function decodeSvgDataUrl(input: string): string {
  const trimmed = input.trim();
  if (!/^data:image\/svg\+xml/i.test(trimmed)) {
    return "";
  }

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex === -1) {
    return "";
  }

  const header = trimmed.slice(0, commaIndex).toLowerCase();
  const payload = trimmed.slice(commaIndex + 1);

  try {
    if (header.includes(";base64")) {
      return atob(payload);
    }
    return decodeURIComponent(payload);
  } catch {
    return "";
  }
}

function extractSvgMarkupFromClipboardText(input: string): string {
  if (!input.trim()) {
    return "";
  }

  const candidates = [
    input,
    decodeHtmlEntities(input),
    decodeSvgDataUrl(input)
  ];

  for (const candidate of candidates) {
    const svg = extractSvgMarkup(candidate);
    if (svg) {
      return svg;
    }
  }

  return "";
}

function svgMarkupToDataUrl(svgMarkup: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svgMarkup)}`;
}

function resolveTablerIconName(iconMap: TablerIconMap | null, input: string): string {
  if (!iconMap) {
    return "";
  }

  const raw = input.trim();
  if (!raw) {
    return "";
  }

  if (iconMap[raw]) {
    return raw;
  }

  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) {
    return "";
  }

  const candidates = Object.keys(iconMap).filter((name) => name.startsWith("Icon"));

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

function toArticleSummary(article: Article): ArticleSummary {
  return {
    id: article.id,
    owner: article.owner,
    public: article.public !== false,
    title: article.title,
    tags: article.tags,
    topicIcon: article.topicIcon,
    illustration: article.illustration,
    sentCount: article.sentCount,
    lastUsed: article.lastUsed,
    status: article.status,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    preview: cutByChars(markdownPreview(article.markdown), 180)
  };
}

export default function ArticlesPage() {
  const { smartFilter } = useParams<{ smartFilter?: string }>();
  const articleSmartFilter = normalizeArticleSmartFilter(smartFilter);
  const { oidcEnabled, user } = useAuth();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const headerRowRef = useRef<HTMLDivElement | null>(null);
  const headerLeftRef = useRef<HTMLDivElement | null>(null);
  const headerActionsRef = useRef<HTMLDivElement | null>(null);
  const favoriteCompactRef = useRef<HTMLButtonElement | null>(null);
  const favoriteMeasureRef = useRef<HTMLButtonElement | null>(null);
  const iconSvgUploadInputRef = useRef<HTMLInputElement | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveClearSavedRef = useRef<number | null>(null);
  const lastSavedDraftRef = useRef<string>("");
  const [leftPaneWidth, setLeftPaneWidth] = useState(getStoredArticlesPaneWidth);
  const isMobile = useMediaQuery("(max-width: 48em)");
  const [isMobileEditorOpen, setIsMobileEditorOpen] = useState(false);
  const [articles, setArticles] = useState<ArticleSummary[]>(
    () => (cachedArticleSummaries ?? []).map(normalizeArticleSummaryVisibility)
  );
  const [selectedArticleId, setSelectedArticleID] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [tags, setTags] = useState<string[]>([]);
  const [topicIcon, setTopicIcon] = useState("");
  const [customIconImageDataUrl, setCustomIconImageDataUrl] = useState("");
  const [customIconImageSizeDelta, setCustomIconImageSizeDelta] = useState(0);
  const [topicIconBgColor, setTopicIconBgColor] = useState(DEFAULT_TOPIC_ICON_BG);
  const [topicIconStrokeColor, setTopicIconStrokeColor] = useState(DEFAULT_TOPIC_ICON_STROKE);
  const [topicIconIllustration, setTopicIconIllustration] = useState("");
  const [isIconBrowserOpen, setIsIconBrowserOpen] = useState(false);
  const [tablerIconMap, setTablerIconMap] = useState<TablerIconMap | null>(null);
  const [isIconLibraryLoading, setIsIconLibraryLoading] = useState(false);
  const [articleSearchQuery, setArticleSearchQuery] = useState("");
  const [showOnlyUnused, setShowOnlyUnused] = useState(false);
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
  const [isDuplicatingArticle, setIsDuplicatingArticle] = useState(false);
  const [isClaimingArticle, setIsClaimingArticle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteArticleId, setDeleteArticleId] = useState<string | null>(null);
  const [hasLoadedArticles, setHasLoadedArticles] = useState(() => cachedArticleSummaries !== null);
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [favoriteNewsletterId, setFavoriteNewsletterId] = useState<string | null>(getStoredFavoriteNewsletterId);
  const [favoriteNewsletterName, setFavoriteNewsletterName] = useState<string>("");
  const [favoriteNewsletterArticleIds, setFavoriteNewsletterArticleIds] = useState<string[]>([]);
  const [isAddingToFavorite, setIsAddingToFavorite] = useState(false);
  const [isFavoriteMembershipLoading, setIsFavoriteMembershipLoading] = useState(false);
  const [isEditingArticleInFavorite, setIsEditingArticleInFavorite] = useState(false);
  const [isCompactFavoriteAction, setIsCompactFavoriteAction] = useState(false);
  const [isManualNewArticleMode, setIsManualNewArticleMode] = useState(false);
  const [allNewsletterSummaries, setAllNewsletterSummaries] = useState<NewsletterSummary[]>([]);

  const selectedArticleSummary = useMemo(
    () => (editingId ? articles.find((article) => article.id === editingId) ?? null : null),
    [articles, editingId]
  );

  const usedArticleIds = useMemo(
    () => new Set(allNewsletterSummaries.flatMap((n) => n.articleIds)),
    [allNewsletterSummaries]
  );

  const newsletterCountByArticleId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const newsletter of allNewsletterSummaries) {
      for (const articleId of newsletter.articleIds) {
        counts.set(articleId, (counts.get(articleId) ?? 0) + 1);
      }
    }
    return counts;
  }, [allNewsletterSummaries]);
  const articleFilterLabel = articleSmartFilter === "mine"
    ? "Mine"
    : articleSmartFilter === "recent"
      ? "Recent"
      : articleSmartFilter === "private"
        ? "Private"
      : articleSmartFilter === "public"
        ? "Public"
      : "All";
  const selectedArticleOwner = (selectedArticleSummary?.owner ?? "").trim().toLowerCase();
  const currentUserEmail = (user?.email ?? "").trim().toLowerCase();
  const canEditVisibility =
    !editingId || selectedArticleOwner === "" || (currentUserEmail !== "" && selectedArticleOwner === currentUserEmail);

  const loadArticles = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [items, newsletters] = await Promise.all([
        listArticleSummaries().then((a) => a.map(normalizeArticleSummaryVisibility)),
        listNewsletterSummaries(),
      ]);
      cachedArticleSummaries = items;
      setArticles(items);
      setAllNewsletterSummaries(newsletters);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load articles");
    } finally {
      setIsLoading(false);
      setHasLoadedArticles(true);
    }
  };

  useEffect(() => {
    if (!hasLoadedArticles) {
      return;
    }
    cachedArticleSummaries = articles;
  }, [articles, hasLoadedArticles]);

  useEffect(() => {
    void loadArticles();
  }, []);

  useEffect(() => {
    const loadFavoriteNewsletterName = async () => {
      const currentFavoriteId = getStoredFavoriteNewsletterId();
      setFavoriteNewsletterId(currentFavoriteId);

      if (!currentFavoriteId) {
        setFavoriteNewsletterName("");
        setFavoriteNewsletterArticleIds([]);
        return;
      }

      try {
        const newsletters = await listNewsletterSummaries();
        const favorite = newsletters.find((newsletter) => newsletter.id === currentFavoriteId);
        if (!favorite) {
          window.localStorage.removeItem(FAVORITE_NEWSLETTER_ID_STORAGE_KEY);
          setFavoriteNewsletterId(null);
          setFavoriteNewsletterName("");
          setFavoriteNewsletterArticleIds([]);
          return;
        }
        setFavoriteNewsletterName(favorite.title);

        const favoriteDetails = await getNewsletter(currentFavoriteId);
        setFavoriteNewsletterArticleIds(favoriteDetails.articleIds);
      } catch {
        setFavoriteNewsletterName("");
        setFavoriteNewsletterArticleIds([]);
      }
    };

    void loadFavoriteNewsletterName();
  }, []);

  useEffect(() => {
    if (!editingId || !favoriteNewsletterId) {
      setIsEditingArticleInFavorite(false);
      return;
    }

    let cancelled = false;
    setIsFavoriteMembershipLoading(true);

    void (async () => {
      try {
        const newsletter = await getNewsletter(favoriteNewsletterId);
        if (!cancelled) {
          setIsEditingArticleInFavorite(newsletter.articleIds.includes(editingId));
          setFavoriteNewsletterArticleIds(newsletter.articleIds);
        }
      } catch {
        if (!cancelled) {
          setIsEditingArticleInFavorite(false);
        }
      } finally {
        if (!cancelled) {
          setIsFavoriteMembershipLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [editingId, favoriteNewsletterId]);

  const onToggleFavoriteNewsletterMembership = async () => {
    if (!editingId || !favoriteNewsletterId) {
      return;
    }

    setIsAddingToFavorite(true);
    setError(null);

    try {
      const newsletter = await getNewsletter(favoriteNewsletterId);
      const articleAlreadyIncluded = newsletter.articleIds.includes(editingId);
      const nextArticleIds = articleAlreadyIncluded
        ? newsletter.articleIds.filter((articleId) => articleId !== editingId)
        : [...newsletter.articleIds, editingId];

      await updateNewsletter(favoriteNewsletterId, {
        title: newsletter.title,
        headerId: newsletter.headerId ?? "",
        introMarkdown: newsletter.introMarkdown,
        includeIndex: newsletter.includeIndex,
        contentWidth: newsletter.contentWidth || 680,
        articleIds: nextArticleIds,
        recipientIds: newsletter.recipientIds
      });
      setFavoriteNewsletterArticleIds(nextArticleIds);
      setIsEditingArticleInFavorite(!articleAlreadyIncluded);
      setAllNewsletterSummaries((prev) =>
        prev.map((n) => (n.id === favoriteNewsletterId ? { ...n, articleIds: nextArticleIds } : n))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update favorite newsletter articles");
    } finally {
      setIsAddingToFavorite(false);
    }
  };

  const loadTablerIcons = async () => {
    if (tablerIconMap || isIconLibraryLoading) {
      return;
    }

    setIsIconLibraryLoading(true);
    try {
      const module = await import("../lib/tablerIconsBrowser");
      setTablerIconMap(module.TABLER_ICON_MAP);
    } catch {
      setError("Failed to load icon library");
    } finally {
      setIsIconLibraryLoading(false);
    }
  };

  const resetForm = () => {
    setTitle("");
    setMarkdown("");
    setIsPublic(true);
    setTags([]);
    setTopicIcon("");
    setCustomIconImageDataUrl("");
    setCustomIconImageSizeDelta(0);
    setTopicIconBgColor(DEFAULT_TOPIC_ICON_BG);
    setTopicIconStrokeColor(DEFAULT_TOPIC_ICON_STROKE);
    setTopicIconIllustration("");
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

  const onEdit = async (article: ArticleSummary) => {
    setIsManualNewArticleMode(false);
    setError(null);
    try {
      const fullArticle = await getArticle(article.id);
      const fullSummary = toArticleSummary(fullArticle);
      setEditingID(fullArticle.id);
      setSelectedArticleID(fullArticle.id);
      setTitle(fullArticle.title);
      setIsPublic(fullArticle.public !== false);
      setTags(fullArticle.tags ?? []);
      const normalized = normalizeMarkdownForEditor(fullArticle.markdown);
      setMarkdown(normalized.normalized);
      setPastedImageMap(normalized.imageMap);
      setTopicIcon(fullArticle.topicIcon ?? "");
      setCustomIconImageDataUrl(
        fullArticle.topicIcon
          ? ""
          : (fullArticle.iconSource?.startsWith("data:image/svg+xml") ? fullArticle.iconSource : "")
      );
      setCustomIconImageSizeDelta(typeof fullArticle.iconZoom === "number" ? fullArticle.iconZoom : 0);
      const iconStyleSource = fullArticle.iconSource || fullArticle.illustration;
      setTopicIconBgColor(fullArticle.iconBgColor || extractTopicIconBackgroundColor(iconStyleSource));
      setTopicIconStrokeColor(fullArticle.iconStrokeColor || extractTopicIconStrokeColor(iconStyleSource));
      setTopicIconIllustration(fullArticle.illustration ?? "");
      setArticles((current) =>
        current.map((item) => (item.id === fullSummary.id ? fullSummary : item))
      );
      lastSavedDraftRef.current = JSON.stringify({
        title: fullArticle.title,
        markdown: fullArticle.markdown,
        public: fullArticle.public !== false,
        tags: fullArticle.tags ?? [],
        topicIcon: fullArticle.topicIcon ?? "",
        illustration: fullArticle.illustration ?? "",
        iconSource: fullArticle.iconSource ?? "",
        iconZoom: typeof fullArticle.iconZoom === "number" ? fullArticle.iconZoom : 0,
        iconBgColor: fullArticle.iconBgColor || "",
        iconStrokeColor: fullArticle.iconStrokeColor || ""
      });
      setAutosaveStatus("idle");
      if (isMobile) {
        setIsMobileEditorOpen(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load article details");
    }
  };

  useEffect(() => {
    if (!editingId) {
      return;
    }

    setArticles((current) =>
      current.map((article) =>
        article.id === editingId ? { ...article, public: isPublic } : article
      )
    );
  }, [editingId, isPublic]);

  const resolvedTopicIconName = useMemo(() => resolveTablerIconName(tablerIconMap, topicIcon), [tablerIconMap, topicIcon]);

  const generatedTopicIconSource = useMemo(
    () => customIconImageDataUrl.trim()
      ? buildPastedImageTopicIconIllustration(customIconImageDataUrl, topicIconBgColor, customIconImageSizeDelta)
      : buildTopicIconIllustration(tablerIconMap, resolvedTopicIconName, topicIconBgColor, topicIconStrokeColor),
    [customIconImageDataUrl, customIconImageSizeDelta, tablerIconMap, resolvedTopicIconName, topicIconBgColor, topicIconStrokeColor]
  );

  useEffect(() => {
    if (!customIconImageDataUrl.trim() && !topicIcon.trim()) {
      setTopicIconIllustration("");
      return;
    }

    if (!generatedTopicIconSource) {
      void loadTablerIcons();
      return;
    }

    let cancelled = false;
    void rasterizeSvgDataUrlToPngDataUrl(generatedTopicIconSource)
      .then((pngDataUrl) => {
        if (!cancelled) {
          setTopicIconIllustration(pngDataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to generate icon preview");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [customIconImageDataUrl, topicIcon, generatedTopicIconSource]);

  const onPasteTopicIconImage = (event: ClipboardEvent<HTMLDivElement>) => {
    const applySvgMarkup = (svgMarkup: string) => {
      setError(null);
      setTopicIcon("");
      setCustomIconImageSizeDelta(0);
      setCustomIconImageDataUrl(svgMarkupToDataUrl(svgMarkup));
    };

    const clipboardData = event.clipboardData;
    const items = Array.from(clipboardData.items);

    // Prefer textual clipboard payloads first: many tools provide SVG text plus a raster preview image.
    const syncTextPayload = [
      clipboardData.getData("text/plain"),
      clipboardData.getData("text/html"),
      clipboardData.getData("text/uri-list"),
      clipboardData.getData("image/svg+xml")
    ]
      .filter(Boolean)
      .join("\n");

    const syncSvg = extractSvgMarkupFromClipboardText(syncTextPayload);
    if (syncSvg) {
      event.preventDefault();
      applySvgMarkup(syncSvg);
      return;
    }

    const stringItems = items.filter((item) => item.kind === "string");
    if (stringItems.length > 0) {
      event.preventDefault();
      let pending = stringItems.length;
      let resolved = false;

      for (const item of stringItems) {
        item.getAsString((value) => {
          if (resolved) {
            return;
          }

          const svgMarkup = extractSvgMarkupFromClipboardText(value);
          if (svgMarkup) {
            resolved = true;
            applySvgMarkup(svgMarkup);
            return;
          }

          pending -= 1;
          if (pending === 0) {
            setError("Could not find valid SVG markup in pasted text");
          }
        });
      }
      return;
    }

    const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (!imageItem) {
      return;
    }

    const file = imageItem.getAsFile();
    if (!file) {
      return;
    }

    if (!isSvgImageFile(file)) {
      event.preventDefault();
      setError("Only SVG images are supported for article icons");
      return;
    }

    event.preventDefault();
    setError(null);

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setError("Failed to read pasted image");
        return;
      }

      setTopicIcon("");
      setCustomIconImageSizeDelta(0);
      setCustomIconImageDataUrl(reader.result);
    };
    reader.onerror = () => {
      setError("Failed to read pasted image");
    };
    reader.readAsDataURL(file);
  };

  const onUploadTopicIconSvg = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }

    if (!isSvgImageFile(file)) {
      setError("Only SVG images are supported for article icons");
      return;
    }

    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setError("Failed to read SVG file");
        return;
      }

      setTopicIcon("");
      setCustomIconImageSizeDelta(0);
      setCustomIconImageDataUrl(reader.result);
    };
    reader.onerror = () => {
      setError("Failed to read SVG file");
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (articles.length === 0) {
      return;
    }

    if (isMobile && selectedArticleId === null && editingId === null) {
      return;
    }

    if (selectedArticleId === null && editingId === null) {
      if (isManualNewArticleMode) {
        return;
      }
      void onEdit(articles[0]);
      return;
    }

    if (selectedArticleId && !articles.some((article) => article.id === selectedArticleId)) {
      setIsManualNewArticleMode(false);
      resetForm();
    }
  }, [articles, isMobile, selectedArticleId, editingId, isManualNewArticleMode]);

  useEffect(() => {
    if (!isMobile) {
      setIsMobileEditorOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    const row = headerRowRef.current;
    const left = headerLeftRef.current;
    const actions = headerActionsRef.current;
    if (!row || !left || !actions || !isMobile || !editingId || !favoriteNewsletterId) {
      setIsCompactFavoriteAction(false);
      return;
    }

    const evaluateCompactMode = () => {
      const available = row.clientWidth;
      const leftNeeded = left.scrollWidth;
      const actionsNeeded = actions.scrollWidth;
      const currentlyNeeded = leftNeeded + actionsNeeded;

      if (!isCompactFavoriteAction && currentlyNeeded > available + 1) {
        setIsCompactFavoriteAction(true);
        return;
      }

      if (isCompactFavoriteAction) {
        const compactWidth = favoriteCompactRef.current?.offsetWidth ?? 34;
        const fullWidth = favoriteMeasureRef.current?.offsetWidth ?? compactWidth;
        const extraNeededForFull = Math.max(0, fullWidth - compactWidth);
        const neededForFull = currentlyNeeded + extraNeededForFull;

        if (neededForFull <= available - 12) {
          setIsCompactFavoriteAction(false);
        }
      }
    };

    const rafId = window.requestAnimationFrame(evaluateCompactMode);
    const resizeObserver = new ResizeObserver(evaluateCompactMode);
    resizeObserver.observe(row);
    resizeObserver.observe(left);
    resizeObserver.observe(actions);
    window.addEventListener("resize", evaluateCompactMode);

    return () => {
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", evaluateCompactMode);
    };
  }, [isMobile, editingId, favoriteNewsletterId, favoriteNewsletterName, autosaveStatus, isCompactFavoriteAction]);

  const buildArticleDraftPayload = () => ({
    title: title.trim(),
    markdown: resolvePastedImageTokens(markdown.trim()),
    public: isPublic,
    tags,
    topicIcon: topicIcon.trim(),
    illustration: topicIconIllustration,
    iconSource: customIconImageDataUrl.trim()
      ? customIconImageDataUrl.trim()
      : buildTopicIconIllustration(tablerIconMap, resolvedTopicIconName, topicIconBgColor, topicIconStrokeColor),
    iconZoom: customIconImageDataUrl.trim() ? customIconImageSizeDelta : 0,
    iconBgColor: topicIconBgColor,
    iconStrokeColor: topicIconStrokeColor
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
          current.map((article) => (article.id === editingId ? toArticleSummary(updated) : article))
        );
        setSelectedArticleID(updated.id);
        lastSavedDraftRef.current = JSON.stringify(payload);
        setAutosaveStatus("saved");
      } else {
        const created = await createArticle({
          authorId: oidcEnabled ? undefined : FALLBACK_AUTHOR_ID,
          ...payload
        });

        setArticles((current) => [toArticleSummary(created), ...current]);
        setSelectedArticleID(created.id);
        setEditingID(created.id);
        setIsManualNewArticleMode(false);
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
      const savingStartedAt = Date.now();
      setAutosaveStatus("saving");
      try {
        const updated = await updateArticle(editingId, payload);
        setArticles((current) =>
          current.map((article) => (article.id === editingId ? toArticleSummary(updated) : article))
        );
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
  }, [editingId, title, markdown, isPublic, tags, topicIcon, topicIconIllustration, pastedImageMap]);

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
            void onEdit(next[0]);
          } else {
            resetForm();
            if (isMobile) {
              setIsMobileEditorOpen(false);
            }
          }
        }
        return next;
      });
      setDeleteArticleId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete article");
    }
  };

  const onDuplicateArticle = async () => {
    if (!editingId) {
      return;
    }

    setIsDuplicatingArticle(true);
    setError(null);

    try {
      const source = await getArticle(editingId);
      const created = await createArticle({
        authorId: oidcEnabled ? undefined : FALLBACK_AUTHOR_ID,
        public: source.public !== false,
        title: `${source.title} (copy)`,
        markdown: source.markdown,
        tags: source.tags ?? [],
        topicIcon: source.topicIcon ?? "",
        illustration: source.illustration ?? "",
        iconSource: source.iconSource ?? "",
        iconZoom: typeof source.iconZoom === "number" ? source.iconZoom : 0,
        iconBgColor: source.iconBgColor ?? "",
        iconStrokeColor: source.iconStrokeColor ?? ""
      });

      const createdSummary = toArticleSummary(created);
      setArticles((current) => [createdSummary, ...current]);
      void onEdit(createdSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to duplicate article");
    } finally {
      setIsDuplicatingArticle(false);
    }
  };

  const onClaimArticle = async () => {
    if (!editingId) {
      return;
    }

    setIsClaimingArticle(true);
    setError(null);
    try {
      const claimed = await claimArticle(editingId);
      setArticles((current) =>
        current.map((article) => (article.id === editingId ? toArticleSummary(claimed) : article))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to claim article");
    } finally {
      setIsClaimingArticle(false);
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
        const sourceDataURL = reader.result;
        const img = new Image();

        img.onload = () => {
          const sourceWidth = img.naturalWidth;
          const sourceHeight = img.naturalHeight;

          if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
            setError("Failed to process pasted image");
            return;
          }

          // Only downscale — never enlarge. Skip canvas entirely if image fits.
          const token = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

          if (sourceWidth <= NEWSLETTER_MAX_CONTENT_WIDTH_PX) {
            setPastedImageMap((current) => ({ ...current, [token]: sourceDataURL }));
            setMarkdown((current) =>
              insertAtCursor(target, current, `\n![Pasted image](paste://${token})\n`)
            );
            return;
          }

          const targetWidth = NEWSLETTER_MAX_CONTENT_WIDTH_PX;
          const targetHeight = Math.max(1, Math.round((sourceHeight * targetWidth) / sourceWidth));

          const canvas = document.createElement("canvas");
          canvas.width = targetWidth;
          canvas.height = targetHeight;

          const ctx = canvas.getContext("2d");
          if (!ctx) {
            setError("Failed to process pasted image");
            return;
          }

          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

          const jpegDataURL = canvas.toDataURL("image/jpeg", 0.8);
          setPastedImageMap((current) => ({ ...current, [token]: jpegDataURL }));
          setMarkdown((current) =>
            insertAtCursor(target, current, `\n![Pasted image](paste://${token})\n`)
          );
        };

        img.onerror = () => {
          setError("Failed to process pasted image");
        };

        img.src = sourceDataURL;
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
    if (!tablerIconMap) {
      return [];
    }

    const query = iconSearch.trim().toLowerCase();
    return Object.keys(tablerIconMap)
      .filter((name) => name.startsWith("Icon") && name !== "Icon")
      .filter((name) => (query ? name.toLowerCase().includes(query) : true))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 300);
  }, [iconSearch, tablerIconMap]);

  const preFilteredArticles = useMemo(() => {
    let scopedArticles = articles;
    if (articleSmartFilter === "mine") {
      // Without a known identity, show all (single-user, no-OIDC setup).
      if (currentUserEmail) {
        scopedArticles = scopedArticles.filter(
          (article) => (article.owner ?? "").trim().toLowerCase() === currentUserEmail
        );
      }
    } else if (articleSmartFilter === "recent") {
      const cutoff = Date.now() - RECENT_ARTICLES_WINDOW_MS;
      scopedArticles = scopedArticles.filter((article) => {
        const createdAtMs = new Date(article.createdAt).getTime();
        return Number.isFinite(createdAtMs) && createdAtMs >= cutoff;
      });
    } else if (articleSmartFilter === "private") {
      // Show private articles. Scope to current user when identity is known.
      scopedArticles = scopedArticles.filter((article) => {
        if (article.public !== false) return false;
        if (!currentUserEmail) return true;
        return (article.owner ?? "").trim().toLowerCase() === currentUserEmail;
      });
    } else if (articleSmartFilter === "public") {
      // Show public articles from OTHER owners only.
      // When identity is unknown we show nothing — we can't determine what's "mine".
      if (!currentUserEmail) {
        scopedArticles = [];
      } else {
        scopedArticles = scopedArticles.filter((article) => {
          if (!article.public) return false;
          const owner = (article.owner ?? "").trim().toLowerCase();
          if (!owner) return false;
          return owner !== currentUserEmail;
        });
      }
    }

    const query = articleSearchQuery.trim().toLowerCase();
    if (!query) {
      return scopedArticles;
    }

    const hasAnyCriteria =
      articleSearchCriteria.title || articleSearchCriteria.content || articleSearchCriteria.tag;
    if (!hasAnyCriteria) {
      return scopedArticles;
    }

    const words = query.split(/\s+/).filter(Boolean);
    return scopedArticles.filter((article) => {
      const haystackParts: string[] = [];
      if (articleSearchCriteria.title) {
        haystackParts.push(article.title);
      }
      if (articleSearchCriteria.content) {
        haystackParts.push(article.preview);
      }
      if (articleSearchCriteria.tag) {
        haystackParts.push((article.tags ?? []).join(" "));
      }

      const haystack = haystackParts.join(" ").toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [articleSearchQuery, articleSearchCriteria, articles, articleSmartFilter, currentUserEmail]);

  const filteredArticles = useMemo(() => {
    if (!showOnlyUnused || allNewsletterSummaries.length === 0) {
      return preFilteredArticles;
    }
    return preFilteredArticles.filter((article) => !usedArticleIds.has(article.id));
  }, [preFilteredArticles, showOnlyUnused, usedArticleIds, allNewsletterSummaries.length]);

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

  const iconSizeSliderThumbPosition = (customIconImageSizeDelta + 100) / 2;

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
        gridTemplateColumns: isMobile ? "1fr" : `${leftPaneWidth}px 1fr`,
        gap: 0,
        height: "calc(100vh - 120px)",
        minHeight: 560,
        position: "relative"
      }}
    >
      {!isMobile || !isMobileEditorOpen ? (
      <div style={{ overflow: "hidden" }}>
        <Group justify="space-between" p="sm" style={{ borderBottom: "1px solid #e9ecef" }}>
          <Text fw={600}>{articleFilterLabel} ({sortedArticles.length})</Text>
          <Group gap="xs">
            <Button
              variant="light"
              size="xs"
              onClick={() => {
                setIsManualNewArticleMode(true);
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

        <div style={{ padding: 10, borderBottom: "1px solid #e9ecef", display: "flex", alignItems: "center", gap: 6 }}>
          <TextInput
            radius="xl"
            style={{ flex: 1 }}
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
          {allNewsletterSummaries.length > 0 && (
            <Tooltip label={showOnlyUnused ? "Show all articles" : "Show unused only"} position="bottom" withArrow>
              <ActionIcon
                variant={showOnlyUnused ? "filled" : "subtle"}
                color={showOnlyUnused ? "blue" : "gray"}
                size="sm"
                aria-label="Toggle unused articles filter"
                onClick={() => setShowOnlyUnused((v) => !v)}
                style={{ flexShrink: 0 }}
              >
                <IconPointFilled size={12} />
              </ActionIcon>
            </Tooltip>
          )}
        </div>

        <ScrollArea h="calc(100% - 110px)" offsetScrollbars>
          <Stack gap={0}>
            {sortedArticles.map((article) => (
              (() => {
                const titleText = cutByChars(article.title, 72);
                const previewText = article.preview;
                return (
              <div
                key={article.id}
                onClick={() => void onEdit(article)}
                style={{
                  padding: 12,
                  borderBottom: "1px solid #f1f3f5",
                  cursor: "pointer",
                  backgroundColor: selectedArticleId === article.id ? "#f1fbff" : "transparent"
                }}
              >
                <Stack gap={6} style={{ flex: 1 }}>
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                    <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0, justifyContent: "flex-start" }}>
                      {allNewsletterSummaries.length > 0 && !usedArticleIds.has(article.id) ? (
                        <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#228be6", flexShrink: 0 }} />
                      ) : null}
                      <Text
                        fw={700}
                        size="sm"
                        style={{
                          minWidth: 0,
                          maxWidth: "100%",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis"
                        }}
                      >
                        {titleText}
                      </Text>
                      {favoriteNewsletterArticleIds.includes(article.id) ? (
                        <IconMail size={12} color="#228be6" style={{ flexShrink: 0 }} />
                      ) : null}
                    </Group>
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                      {formatArticleCreatedAt(article.createdAt)}
                    </Text>
                  </Group>
                  {(article.owner ?? "").trim() !== "" ? (
                    <Group gap={4} wrap="nowrap" align="center">
                      <IconUserFilled size={11} color="#868e96" style={{ flexShrink: 0 }} />
                      <Text size="xs" c="dimmed" style={{ minWidth: 0 }}>
                        {article.owner}
                      </Text>
                    </Group>
                  ) : null}
                  {previewText ? (
                    <Group gap={6} align="center" wrap="nowrap">
                      <Text size="xs" c="dimmed" lineClamp={3} style={{ flex: 1 }}>
                        {previewText}
                      </Text>
                      {(newsletterCountByArticleId.get(article.id) ?? 0) > 0 ? (
                        <Tooltip label={`Used in ${newsletterCountByArticleId.get(article.id)} newsletter${(newsletterCountByArticleId.get(article.id) ?? 0) > 1 ? "s" : ""}`} position="top" withArrow>
                          <div style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            minWidth: 18,
                            height: 18,
                            padding: "0 4px",
                            borderRadius: 6,
                            backgroundColor: "#b3c0cc",
                            color: "#fff",
                            fontSize: 11,
                            fontWeight: 600,
                            lineHeight: 1,
                            flexShrink: 0
                          }}>
                            {newsletterCountByArticleId.get(article.id)}
                          </div>
                        </Tooltip>
                      ) : null}
                    </Group>
                  ) : null}
                  {(article.public === false && (article.owner ?? "").trim() !== "") || (article.tags && article.tags.length > 0) ? (
                    <Group gap={4} wrap="wrap">
                      {(article.owner ?? "").trim() !== "" && article.public === false ? (
                        <Badge size="xs" color="gray" variant="light">
                          Private
                        </Badge>
                      ) : null}
                      {(article.tags ?? []).map((tag) => (
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
            {isLoading && articles.length === 0 ? (
              <Group justify="center" p="md" gap="xs">
                <Loader size="sm" />
                <Text c="dimmed" size="sm">Loading articles...</Text>
              </Group>
            ) : articles.length === 0 ? (
              <Text c="dimmed" size="sm" p="md">
                No articles.
              </Text>
            ) : sortedArticles.length === 0 ? (
              <Text c="dimmed" size="sm" p="md">
                No articles match your search or selected filters.
              </Text>
            ) : null}
          </Stack>
        </ScrollArea>
      </div>
      ) : null}

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
          background: "linear-gradient(to right, transparent 3px, #e9ecef 3px, #e9ecef 4px, transparent 4px)"
        }}
      />
      ) : null}

      {!isMobile || isMobileEditorOpen ? (
      <div style={{ padding: "12px clamp(8px, 2.5vw, 12px)", overflow: "auto" }}>
        {!hasLoadedArticles ? (
          <Center h="100%">
            <Stack align="center" gap="xs">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">Loading articles...</Text>
            </Stack>
          </Center>
        ) : (
        <Stack>
          <Group justify="space-between" wrap="nowrap" ref={headerRowRef}>
            <Group gap="xs" wrap="nowrap" ref={headerLeftRef}>
              {isMobile ? (
                <Button variant="subtle" size="xs" onClick={() => setIsMobileEditorOpen(false)}>
                  Back
                </Button>
              ) : null}
              <Text fw={700} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                {editingId ? "Edit Article" : "New Article"}
              </Text>
              {editingId && (autosaveStatus === "saving" || autosaveStatus === "error") ? (
                <Text size="xs" c={autosaveStatus === "error" ? "red" : "dimmed"}>
                  {autosaveStatus === "saving" ? "Saving..." : "Autosave failed"}
                </Text>
              ) : null}
            </Group>
            {editingId ? (
              <Group gap="xs" wrap="nowrap" ref={headerActionsRef}>
                {favoriteNewsletterId ? (
                  isCompactFavoriteAction ? (
                    <ActionIcon
                      ref={favoriteCompactRef}
                      variant="default"
                      size="md"
                      onClick={() => void onToggleFavoriteNewsletterMembership()}
                      disabled={!favoriteNewsletterId || !favoriteNewsletterName || isAddingToFavorite || isFavoriteMembershipLoading}
                      loading={isAddingToFavorite}
                      title={favoriteNewsletterName
                        ? `${isEditingArticleInFavorite ? "Remove from" : "Add to"} ${favoriteNewsletterName}`
                        : "Add to favorite newsletter"}
                      aria-label={favoriteNewsletterName
                        ? `${isEditingArticleInFavorite ? "Remove from" : "Add to"} ${favoriteNewsletterName}`
                        : "Add to favorite newsletter"}
                    >
                      <IconMail
                        size={14}
                        color={isEditingArticleInFavorite ? "#228be6" : "#adb5bd"}
                      />
                    </ActionIcon>
                  ) : (
                    <Button
                      variant="default"
                      size="xs"
                      leftSection={
                        <IconMail
                          size={14}
                          color={isEditingArticleInFavorite ? "#228be6" : "#adb5bd"}
                        />
                      }
                      onClick={() => void onToggleFavoriteNewsletterMembership()}
                      disabled={!favoriteNewsletterId || !favoriteNewsletterName || isAddingToFavorite || isFavoriteMembershipLoading}
                      loading={isAddingToFavorite}
                    >
                      {favoriteNewsletterName
                        ? `${isEditingArticleInFavorite ? "Remove from" : "Add to"} ${favoriteNewsletterName}`
                        : "Add to favorite newsletter"}
                    </Button>
                  )
                ) : null}
                <Button
                  variant="default"
                  size="xs"
                  onClick={() => void onDuplicateArticle()}
                  loading={isDuplicatingArticle}
                >
                  Duplicate
                </Button>
                {oidcEnabled && !articles.find((article) => article.id === editingId)?.owner ? (
                  <Button
                    variant="light"
                    color="blue"
                    size="xs"
                    onClick={() => void onClaimArticle()}
                    loading={isClaimingArticle}
                  >
                    Claim
                  </Button>
                ) : null}
                <Button color="red" variant="light" size="xs" onClick={() => requestDeleteArticle(editingId)}>
                  Delete
                </Button>
              </Group>
            ) : null}
          </Group>

          {editingId && favoriteNewsletterId ? (
            <Button
              ref={favoriteMeasureRef}
              variant="default"
              size="xs"
              leftSection={<IconMail size={14} color={isEditingArticleInFavorite ? "#228be6" : "#adb5bd"} />}
              style={{ position: "absolute", visibility: "hidden", pointerEvents: "none", height: 0, overflow: "hidden" }}
              tabIndex={-1}
              aria-hidden
            >
              {favoriteNewsletterName
                ? `${isEditingArticleInFavorite ? "Remove from" : "Add to"} ${favoriteNewsletterName}`
                : "Add to favorite newsletter"}
            </Button>
          ) : null}

          <Group align="flex-end" wrap="nowrap">
            <UnstyledButton
                onClick={() => {
                  setIsIconBrowserOpen(true);
                  void loadTablerIcons();
                }}
              aria-label="Select topic icon"
              style={{
                width: 40,
                height: 40,
                borderRadius: 9999,
                border: "1px solid #dee2e6",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                  background: topicIconIllustration ? "#fff" : "#f8f9fa",
                cursor: "pointer",
                padding: 0,
                overflow: "hidden",
                flexShrink: 0
              }}
            >
              {topicIconIllustration ? (
                <Box
                  component="img"
                  src={topicIconIllustration}
                  alt="Topic icon preview"
                  w={40}
                  h={40}
                  width={40}
                  height={40}
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
              description="Article title used in the article list and newsletter sections."
              placeholder="Article title"
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </Group>

          {canEditVisibility ? (
            <Checkbox
              checked={isPublic}
              onChange={(event) => setIsPublic(event.currentTarget.checked)}
              label="Public article"
              description="Private articles are visible only to their owner."
            />
          ) : null}

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
                        size="xs"
                        withRemoveButton
                        onRemove={() => setTags((current) => current.filter((item) => item !== tag))}
                        style={{
                          backgroundColor: `var(--mantine-color-${color}-1)`,
                          color: `var(--mantine-color-${color}-8)`,
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
                preview={isMobile ? "edit" : "live"}
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
                          style={{ maxWidth: NEWSLETTER_MAX_CONTENT_WIDTH_PX, height: "auto", borderRadius: 8, display: "block", margin: "0 auto" }}
                        />
                      );
                    }
                  }
                }}
              />
            </div>
          </Input.Wrapper>

          <Group justify="space-between">
            <div />
            {!editingId ? (
              <Button leftSection={<IconPencil size={16} />} onClick={() => void onSubmit()} loading={isSubmitting}>
                Create Article
              </Button>
            ) : null}
          </Group>

          {error ? <Text c="red">{error}</Text> : null}
        </Stack>
        )}
      </div>
      ) : null}

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
                onClick={() => {
                  setTopicIcon("");
                  setCustomIconImageDataUrl("");
                  setCustomIconImageSizeDelta(0);
                }}
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 9999,
                  border: "1px solid #dee2e6",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: topicIconIllustration ? "#fff" : "#f8f9fa",
                  padding: 0,
                  overflow: "hidden",
                  cursor: "pointer"
                }}
              >
                {topicIconIllustration ? (
                  <Box
                    component="img"
                    src={topicIconIllustration}
                    alt="Current icon preview"
                    w={96}
                    h={96}
                    width={96}
                    height={96}
                    style={{ display: "block" }}
                  />
                ) : (
                  <Text size="xl" c="dimmed">
                    +
                  </Text>
                )}
              </UnstyledButton>

              <Group gap="md" align="end" justify="center" wrap="wrap" style={{ width: "100%" }}>
                <ColorInput
                  label="Background"
                  format="hex"
                  value={topicIconBgColor}
                  onChange={setTopicIconBgColor}
                  swatches={["#228be6", "#15aabf", "#40c057", "#fab005", "#fd7e14", "#fa5252", "#ae3ec9", "#495057"]}
                  style={{ minWidth: 220 }}
                />
                <ColorInput
                  label="Stroke"
                  format="hex"
                  value={topicIconStrokeColor}
                  onChange={setTopicIconStrokeColor}
                  swatches={["#ffffff", "#f8f9fa", "#dee2e6", "#212529", "#000000"]}
                  style={{ minWidth: 220 }}
                />
              </Group>
            </Stack>

            <Group justify="flex-end" mt="sm">
              <Group gap="xs">
                <Button
                  variant="subtle"
                  color="gray"
                  onClick={() => {
                    setTopicIcon("");
                    setCustomIconImageDataUrl("");
                    setCustomIconImageSizeDelta(0);
                  }}
                >
                  Clear icon
                </Button>
                <Button variant="default" onClick={() => setIsIconBrowserOpen(false)}>
                  Done
                </Button>
              </Group>
            </Group>
          </Paper>

          <Paper
            withBorder
            p="sm"
            radius="md"
          >
            <Stack gap="sm">
              <Box
                tabIndex={0}
                onPaste={onPasteTopicIconImage}
                style={{ outline: "none" }}
              >
                <Stack gap={4}>
                  <Text fw={600} size="sm">Custom icon</Text>
                  <Text size="xs" c="dimmed">
                    Click here and paste an SVG image from clipboard or upload a file on disk.
                  </Text>
                  <Group justify="flex-start" style={{ width: "100%" }}>
                    <Button
                      variant="default"
                      size="xs"
                      onClick={() => iconSvgUploadInputRef.current?.click()}
                    >
                      Upload SVG
                    </Button>
                    <input
                      ref={iconSvgUploadInputRef}
                      type="file"
                      accept=".svg,image/svg+xml"
                      onChange={onUploadTopicIconSvg}
                      style={{ display: "none" }}
                    />
                    <Box style={{ width: 180, maxWidth: "100%" }}>
                      <Text size="xs" c="dimmed" mb={4}>Size</Text>
                      <Slider
                        startPointValue={0}
                        min={-100}
                        max={100}
                        step={1}
                        value={customIconImageSizeDelta}
                        onChange={setCustomIconImageSizeDelta}
                        label={(value) => (value > 0 ? `+${value}` : `${value}`)}
                        disabled={!customIconImageDataUrl}
                        styles={{
                          track: {
                            background:
                              customIconImageSizeDelta >= 0
                                ? `linear-gradient(to right, var(--mantine-color-gray-3) 0%, var(--mantine-color-gray-3) 50%, var(--mantine-color-blue-6) 50%, var(--mantine-color-blue-6) ${iconSizeSliderThumbPosition}%, var(--mantine-color-gray-3) ${iconSizeSliderThumbPosition}%, var(--mantine-color-gray-3) 100%)`
                                : `linear-gradient(to right, var(--mantine-color-gray-3) 0%, var(--mantine-color-gray-3) ${iconSizeSliderThumbPosition}%, var(--mantine-color-blue-6) ${iconSizeSliderThumbPosition}%, var(--mantine-color-blue-6) 50%, var(--mantine-color-gray-3) 50%, var(--mantine-color-gray-3) 100%)`,
                            opacity: customIconImageDataUrl ? 1 : 0.55
                          }
                        }}
                      />
                    </Box>
                  </Group>
                </Stack>
              </Box>

              <Group gap="xs" wrap="nowrap" align="center">
                <Box style={{ flex: 1, height: 1, background: "#dee2e6" }} />
                <Text size="xs" c="dimmed" fw={600}>or</Text>
                <Box style={{ flex: 1, height: 1, background: "#dee2e6" }} />
              </Group>

              <TextInput
                label="Search icon"
                description="Filter Tabler icon names before selecting one for the topic icon."
                placeholder="Search icon name (e.g. sparkles, mail, chart)"
                value={iconSearch}
                onChange={(event) => setIconSearch(event.currentTarget.value)}
              />

              <ScrollArea h={420}>
                <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="xs">
                  {isIconLibraryLoading ? (
                    <Center py="lg" style={{ gridColumn: "1 / -1" }}>
                      <Loader size="sm" />
                    </Center>
                  ) : null}
                  {filteredIconNames.map((iconName) => {
                    const IconComponent = tablerIconMap?.[iconName];

                    if (!IconComponent) {
                      return null;
                    }

                    const isSelected = topicIcon === iconName;
                    return (
                      <UnstyledButton
                        key={iconName}
                        onClick={() => {
                          setTopicIcon(iconName);
                          setCustomIconImageDataUrl("");
                          setCustomIconImageSizeDelta(0);
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
          </Paper>
        </Stack>
      </Modal>
    </div>
  );
}
