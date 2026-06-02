import { type MouseEvent as ReactMouseEvent, type ClipboardEvent as ReactClipboardEvent, useEffect, useMemo, useRef, useState } from "react";
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
import { IconCheck, IconChevronDown, IconChevronLeft, IconFiles, IconLanguage, IconMail, IconPencil, IconPlus, IconPointFilled, IconRefresh, IconSearch, IconTrash, IconUpload, IconUserCheck, IconUserFilled, IconX } from "@tabler/icons-react";
import { SimpleEditor } from "@/components/tiptap-templates/simple/simple-editor";
import { renderToStaticMarkup } from "react-dom/server";
import { useParams } from "react-router-dom";
import { createArticle, deleteArticle, getArticle, getNewsletter, getSavedIcons, listArticleSummaries, listNewsletterSummaries, putSavedIcons, renderMarkdown, updateArticle, updateNewsletter } from "../lib/api";
import { claimArticle } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { TablerIconMap } from "../lib/tablerIconsBrowser";
import type { Article, ArticleLanguageCode, ArticleSummary, NewsletterSummary } from "../types/domain";

const FALLBACK_AUTHOR_ID = "demo-user";

const DEFAULT_TOPIC_ICON_BG = "#228be6";
const DEFAULT_TOPIC_ICON_STROKE = "#ffffff";
const ARTICLES_PANE_WIDTH_STORAGE_KEY = "newsletter.articles.pane.width";
const FAVORITE_NEWSLETTER_ID_STORAGE_KEY = "newsletter.favorite.id";
const SAVED_ICONS_STORAGE_KEY = "newsletter.articles.savedIcons";
const MAX_SAVED_ICONS = 24;
const ICON_PNG_RASTER_SIZE = 90;
const RECENT_ARTICLES_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_NEWSLETTER_CONTENT_WIDTH = 680;
const TAG_COLORS = ["blue", "teal", "cyan", "grape", "indigo", "violet", "lime", "orange", "pink"] as const;
const DEFAULT_ARTICLE_LANGUAGE: ArticleLanguageCode = "fr";
const ARTICLE_LANGUAGES: Array<{ code: ArticleLanguageCode; label: string }> = [
  { code: "en", label: "English" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" }
];
const ARTICLE_LANGUAGE_FLAGS: Record<ArticleLanguageCode, string> = {
  en: "🇬🇧",
  fr: "🇫🇷",
  de: "🇩🇪",
  es: "🇪🇸",
  it: "🇮🇹",
  ja: "🇯🇵",
  zh: "🇨🇳"
};

function languageLabel(code?: ArticleLanguageCode): string {
  if (!code) {
    return "French";
  }
  return ARTICLE_LANGUAGES.find((language) => language.code === code)?.label ?? "French";
}

function languageFlag(code?: ArticleLanguageCode): string {
  if (!code) return ARTICLE_LANGUAGE_FLAGS.fr;
  return ARTICLE_LANGUAGE_FLAGS[code] ?? ARTICLE_LANGUAGE_FLAGS.fr;
}

function browserArticleListLanguage(): ArticleLanguageCode {
  const languageCandidates: string[] = [];
  if (typeof window !== "undefined") {
    if (Array.isArray(window.navigator.languages)) {
      languageCandidates.push(...window.navigator.languages);
    }
    languageCandidates.push(window.navigator.language);
  }

  for (const raw of languageCandidates) {
    const normalized = (raw ?? "").trim().toLowerCase();
    if (!normalized) continue;
    const base = normalized.split("-")[0] as ArticleLanguageCode;
    if (ARTICLE_LANGUAGES.some((language) => language.code === base)) {
      return base;
    }
  }

  return DEFAULT_ARTICLE_LANGUAGE;
}

function isEmptyArticleBodyContent(contentHTML: string): boolean {
  const raw = contentHTML?.trim() ?? "";
  if (!raw) return true;
  if (typeof window === "undefined" || typeof window.DOMParser === "undefined") {
    const textOnly = raw.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").trim();
    return textOnly.length === 0;
  }
  const parser = new window.DOMParser();
  const doc = parser.parseFromString(raw, "text/html");
  const textOnly = (doc.body.textContent ?? "").replace(/\u00a0/g, " ").trim();
  return textOnly.length === 0;
}

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

function getStoredSavedIcons(): string[] {
  try {
    const raw = window.localStorage.getItem(SAVED_ICONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v: unknown) => typeof v === "string" && v.startsWith("data:")) : [];
  } catch {
    return [];
  }
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

function buildTopicIconIllustration(iconMap: TablerIconMap | null, iconName: string, circleColor: string, strokeColor: string, fillColor?: string): string {
  if (!iconMap) {
    return "";
  }

  const IconComponent = iconMap[iconName];
  if (!IconComponent) {
    return "";
  }

  const iconSvgRaw = renderToStaticMarkup(<IconComponent size={22} />);
  let iconInner = iconSvgRaw
    .replace(/^<svg[^>]*>/i, "")
    .replace(/<\/svg>$/i, "");
  const resolvedFill = fillColor?.trim() || "none";
  if (fillColor?.trim()) {
    iconInner = iconInner.replace(/\sfill\s*=\s*"none"/gi, "");
  }
  const iconSvg = `<g transform="translate(8 8)" color="${strokeColor}" stroke="currentColor" fill="${resolvedFill}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconInner}</g>`;

  const finalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="${circleColor}"/>${iconSvg}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(finalSvg)}`;
}

async function rasterizeSvgDataUrlToPngDataUrl(svgDataUrl: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const img = new window.Image();
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

function applySvgFillColorOverride(svgDataUrl: string, fillColor: string): string {
  if (!fillColor.trim()) return svgDataUrl;
  const decoded = decodeSvgDataUrl(svgDataUrl);
  if (!decoded) return svgDataUrl;
  let modified = decoded
    .replace(/fill\s*=\s*"[^"]*"/gi, `fill="${fillColor}"`)
    .replace(/fill\s*=\s*'[^']*'/gi, `fill='${fillColor}'`)
    .replace(/(style\s*=\s*"[^"]*)(?<![a-z-])fill\s*:\s*[^;"]+/gi, `$1fill:${fillColor}`)
    .replace(/(style\s*=\s*'[^']*)(?<![a-z-])fill\s*:\s*[^;']+/gi, `$1fill:${fillColor}`);
  // Add fill to root <svg> for SVGs that rely on inherited default fill
  modified = modified.replace(/(<svg\b[^>]*)(>)/i, (match, before, close) => {
    if (/\bfill\s*=/i.test(before)) return match;
    return `${before} fill="${fillColor}"${close}`;
  });
  return `data:image/svg+xml,${encodeURIComponent(modified)}`;
}

function buildPastedImageTopicIconIllustration(imageDataUrl: string, circleColor: string, sizeDelta: number, fillColor?: string): string {
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

  const resolvedImage = fillColor?.trim() ? applySvgFillColorOverride(trimmed, fillColor) : trimmed;
  const finalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><defs><clipPath id="topicIconClip"><circle cx="20" cy="20" r="20"/></clipPath></defs><circle cx="20" cy="20" r="20" fill="${circleColor}"/><g clip-path="url(#topicIconClip)"><image href="${resolvedImage}" x="${imageX}" y="${imageY}" width="${imageWidth}" height="${imageHeight}" preserveAspectRatio="none"/></g></svg>`;
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

function htmlPreviewText(input: string, maxLines = 3): string {
  const withBreaks = input
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const plain = withBreaks
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\r/g, "");

  const lines = plain
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .map((line) => line.replace(/\s+/g, " "));

  return lines.join(" ");
}

function toArticleSummary(article: Article): ArticleSummary {
  const previewSource = article.contentHTML?.trim()
    ? htmlPreviewText(article.contentHTML)
    : markdownPreview(article.markdown);
  return {
    id: article.id,
    owner: article.owner,
    public: article.public !== false,
    availableLanguages: article.availableLanguages,
    title: article.title,
    tags: article.tags,
    topicIcon: article.topicIcon,
    illustration: article.illustration,
    sentCount: article.sentCount,
    lastUsed: article.lastUsed,
    status: article.status,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    preview: cutByChars(previewSource, 180)
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
  const expandedActionsWidthRef = useRef<number>(0);
  const iconSvgUploadInputRef = useRef<HTMLInputElement | null>(null);
  const articleListViewportRef = useRef<HTMLDivElement | null>(null);
  const editorPaneRef = useRef<HTMLDivElement | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveClearSavedRef = useRef<number | null>(null);
  const lastSavedDraftRef = useRef<string>("");
  const pendingEditRef = useRef<string | null>(null);
  const [leftPaneWidth, setLeftPaneWidth] = useState(getStoredArticlesPaneWidth);
  const isMobile = useMediaQuery("(max-width: 48em)");
  const [isMobileEditorOpen, setIsMobileEditorOpen] = useState(false);
  const [articles, setArticles] = useState<ArticleSummary[]>(
    () => (cachedArticleSummaries ?? []).map(normalizeArticleSummaryVisibility)
  );
  const [selectedArticleId, setSelectedArticleID] = useState<string | null>(null);
  const [articleListLanguage] = useState<ArticleLanguageCode>(browserArticleListLanguage);
  const [selectedLanguage, setSelectedLanguage] = useState<ArticleLanguageCode>(articleListLanguage);
  const [title, setTitle] = useState("");
  const [articleContentHTML, setArticleContentHTML] = useState("");
  const [articleEditorKey, setArticleEditorKey] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [tags, setTags] = useState<string[]>([]);
  const [topicIcon, setTopicIcon] = useState("");
  const [customIconImageDataUrl, setCustomIconImageDataUrl] = useState("");
  const [customIconImageSizeDelta, setCustomIconImageSizeDelta] = useState(0);
  const [topicIconBgColor, setTopicIconBgColor] = useState(DEFAULT_TOPIC_ICON_BG);
  const [topicIconStrokeColor, setTopicIconStrokeColor] = useState(DEFAULT_TOPIC_ICON_STROKE);
  const [topicIconFillColor, setTopicIconFillColor] = useState("");
  const [topicIconIllustration, setTopicIconIllustration] = useState("");
  const [isIconBrowserOpen, setIsIconBrowserOpen] = useState(false);
  const [savedIcons, setSavedIcons] = useState<string[]>(getStoredSavedIcons);
  const savedIconActiveRef = useRef(false);
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
  const [favoriteNewsletterContentWidth, setFavoriteNewsletterContentWidth] = useState<number>(DEFAULT_NEWSLETTER_CONTENT_WIDTH);
  const [favoriteNewsletterArticleIds, setFavoriteNewsletterArticleIds] = useState<string[]>([]);
  const [isAddingToFavorite, setIsAddingToFavorite] = useState(false);
  const [isFavoriteMembershipLoading, setIsFavoriteMembershipLoading] = useState(false);
  const [isEditingArticleInFavorite, setIsEditingArticleInFavorite] = useState(false);
  const [isCompactActions, setIsCompactActions] = useState(false);
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
  const isEditingOwnedByCurrentUser =
    !editingId ||
    !oidcEnabled ||
    (selectedArticleOwner !== "" && currentUserEmail !== "" && selectedArticleOwner === currentUserEmail);
  const canEditVisibility =
    !editingId || isEditingOwnedByCurrentUser;
  const isReadOnlyArticleView = Boolean(editingId && !isEditingOwnedByCurrentUser);

  const loadArticles = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [items, newsletters] = await Promise.all([
        listArticleSummaries(articleListLanguage).then((a) => a.map(normalizeArticleSummaryVisibility)),
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
    // Load saved icons from server (localStorage is the fast cache)
    getSavedIcons().then((icons) => {
      setSavedIcons(icons);
      try { window.localStorage.setItem(SAVED_ICONS_STORAGE_KEY, JSON.stringify(icons)); } catch { /* quota */ }
    }).catch(() => { /* keep localStorage fallback */ });
  }, []);

  useEffect(() => {
    const loadFavoriteNewsletterName = async () => {
      const currentFavoriteId = getStoredFavoriteNewsletterId();
      setFavoriteNewsletterId(currentFavoriteId);

      if (!currentFavoriteId) {
        setFavoriteNewsletterName("");
        setFavoriteNewsletterContentWidth(DEFAULT_NEWSLETTER_CONTENT_WIDTH);
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
          setFavoriteNewsletterContentWidth(DEFAULT_NEWSLETTER_CONTENT_WIDTH);
          setFavoriteNewsletterArticleIds([]);
          return;
        }
        setFavoriteNewsletterName(favorite.title);

        const favoriteDetails = await getNewsletter(currentFavoriteId);
        setFavoriteNewsletterContentWidth(favoriteDetails.contentWidth || DEFAULT_NEWSLETTER_CONTENT_WIDTH);
        setFavoriteNewsletterArticleIds(favoriteDetails.articleIds);
      } catch {
        setFavoriteNewsletterName("");
        setFavoriteNewsletterContentWidth(DEFAULT_NEWSLETTER_CONTENT_WIDTH);
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
          setFavoriteNewsletterContentWidth(newsletter.contentWidth || DEFAULT_NEWSLETTER_CONTENT_WIDTH);
          setIsEditingArticleInFavorite(newsletter.articleIds.includes(editingId));
          setFavoriteNewsletterArticleIds(newsletter.articleIds);
        }
      } catch {
        if (!cancelled) {
          setFavoriteNewsletterContentWidth(DEFAULT_NEWSLETTER_CONTENT_WIDTH);
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
        language: newsletter.language,
        headerId: newsletter.headerId ?? "",
        introMarkdown: newsletter.introMarkdown,
        includeIndex: newsletter.includeIndex,
        contentWidth: newsletter.contentWidth || 680,
        archived: newsletter.archived,
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

  const resolveArticleOpenLanguage = (article: ArticleSummary, languageOverride?: ArticleLanguageCode): ArticleLanguageCode => {
    if (languageOverride) {
      return languageOverride;
    }
    const available = (article.availableLanguages ?? []).filter((language) =>
      ARTICLE_LANGUAGES.some((supported) => supported.code === language)
    );
    if (available.length === 0) {
      return articleListLanguage;
    }
    if (available.includes(articleListLanguage)) {
      return articleListLanguage;
    }
    if (available.includes("en")) {
      return "en";
    }
    return available[0];
  };

  const resetForm = () => {
    setSelectedLanguage(articleListLanguage);
    setTitle("");
    setArticleContentHTML("");
    setArticleEditorKey("");
    setIsPublic(true);
    setTags([]);
    setTopicIcon("");
    setCustomIconImageDataUrl("");
    setCustomIconImageSizeDelta(0);
    setTopicIconBgColor(DEFAULT_TOPIC_ICON_BG);
    setTopicIconStrokeColor(DEFAULT_TOPIC_ICON_STROKE);
    setTopicIconFillColor("");
    setTopicIconIllustration("");
    setEditingID(null);
    setSelectedArticleID(null);
    lastSavedDraftRef.current = "";
    setAutosaveStatus("idle");
  };

  type LanguageSeedDraft = {
    language: ArticleLanguageCode;
    title: string;
    contentHTML: string;
  };

  const onEdit = async (
    article: ArticleSummary,
    languageOverride?: ArticleLanguageCode,
    seedDraft?: LanguageSeedDraft
  ) => {
    pendingEditRef.current = article.id;
    setIsManualNewArticleMode(false);
    setSelectedArticleID(article.id);
    setError(null);
    try {
      const requestedLanguage = resolveArticleOpenLanguage(article, languageOverride);
      const fullArticle = await getArticle(article.id, requestedLanguage);
      if (pendingEditRef.current !== article.id) return;
      setEditingID(fullArticle.id);
      setSelectedArticleID(fullArticle.id);
      const hasRequestedLanguageTranslation = (article.availableLanguages ?? []).includes(requestedLanguage);
      const useSeedDraft =
        !!seedDraft &&
        seedDraft.language !== requestedLanguage &&
        !hasRequestedLanguageTranslation;
      const editorTitle = useSeedDraft ? seedDraft.title : fullArticle.title;

      setSelectedLanguage(requestedLanguage);
      setTitle(editorTitle);
      setIsPublic(fullArticle.public !== false);
      setTags(fullArticle.tags ?? []);

      let htmlContent: string;
      if (useSeedDraft) {
        htmlContent = seedDraft.contentHTML;
      } else if (fullArticle.contentHTML?.trim()) {
        htmlContent = fullArticle.contentHTML;
      } else if (fullArticle.markdown?.trim()) {
        try {
          htmlContent = await renderMarkdown(fullArticle.markdown);
          if (pendingEditRef.current !== article.id) return;
        } catch {
          htmlContent = "<p></p>";
        }
      } else {
        htmlContent = "<p></p>";
      }
      setArticleContentHTML(htmlContent || "");
      setArticleEditorKey(`${fullArticle.id}:${requestedLanguage}`);

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
      setTopicIconFillColor(fullArticle.iconFillColor || "");
      setTopicIconIllustration(fullArticle.illustration ?? "");
      const loadedTopicIcon = (fullArticle.topicIcon ?? "").trim();
      const loadedIconSource = fullArticle.iconSource ?? "";
      const loadedCustomIconImageDataUrl = loadedTopicIcon
        ? ""
        : (loadedIconSource.startsWith("data:image/svg+xml") ? loadedIconSource : "");
      const loadedIconZoom = typeof fullArticle.iconZoom === "number" ? fullArticle.iconZoom : 0;
      const loadedIconBgColor = fullArticle.iconBgColor || extractTopicIconBackgroundColor(iconStyleSource);
      const loadedIconStrokeColor = fullArticle.iconStrokeColor || extractTopicIconStrokeColor(iconStyleSource);
      const loadedIconFillColor = fullArticle.iconFillColor || "";

      lastSavedDraftRef.current = JSON.stringify({
        language: requestedLanguage,
        title: editorTitle.trim(),
        markdown: "",
        contentHTML: htmlContent || "",
        public: fullArticle.public !== false,
        tags: fullArticle.tags ?? [],
        topicIcon: loadedTopicIcon,
        illustration: fullArticle.illustration ?? "",
        iconSource: loadedCustomIconImageDataUrl.trim()
          ? loadedCustomIconImageDataUrl.trim()
          : buildTopicIconIllustration(
              tablerIconMap,
              resolveTablerIconName(tablerIconMap, loadedTopicIcon),
              loadedIconBgColor,
              loadedIconStrokeColor,
              loadedIconFillColor
            ),
        iconZoom: loadedCustomIconImageDataUrl.trim() ? loadedIconZoom : 0,
        iconBgColor: loadedIconBgColor,
        iconStrokeColor: loadedIconStrokeColor,
        iconFillColor: loadedIconFillColor
      });
      setAutosaveStatus("idle");
      if (isMobile) {
        setIsMobileEditorOpen(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load article details");
    }
  };

  const onSelectEditorLanguage = (language: ArticleLanguageCode) => {
    if (language === selectedLanguage) {
      return;
    }
    if (editingId && selectedArticleSummary) {
      void onEdit(selectedArticleSummary, language, {
        language: selectedLanguage,
        title,
        contentHTML: articleContentHTML
      });
      return;
    }
    setSelectedLanguage(language);
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
      ? buildPastedImageTopicIconIllustration(customIconImageDataUrl, topicIconBgColor, customIconImageSizeDelta, topicIconFillColor)
      : buildTopicIconIllustration(tablerIconMap, resolvedTopicIconName, topicIconBgColor, topicIconStrokeColor, topicIconFillColor),
    [customIconImageDataUrl, customIconImageSizeDelta, tablerIconMap, resolvedTopicIconName, topicIconBgColor, topicIconStrokeColor, topicIconFillColor]
  );

  useEffect(() => {
    if (!customIconImageDataUrl.trim() && !topicIcon.trim()) {
      if (savedIconActiveRef.current) {
        savedIconActiveRef.current = false;
        return;
      }
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

  const onPasteTopicIconImage = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const applySvgMarkup = (svgMarkup: string) => {
      setError(null);
      setTopicIcon("");
      setCustomIconImageSizeDelta(0);
      setCustomIconImageDataUrl(svgMarkupToDataUrl(svgMarkup));
    };

    const clipboardData = event.clipboardData;
    const items = Array.from(clipboardData.items) as DataTransferItem[];

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
    if (!row || !left || !actions || !editingId) {
      setIsCompactActions(false);
      return;
    }

    const evaluateCompactMode = () => {
      const available = row.clientWidth;
      const overflowing = row.scrollWidth > row.clientWidth + 1;

      if (!isCompactActions) {
        expandedActionsWidthRef.current = actions.scrollWidth;
        if (overflowing) {
          setIsCompactActions(true);
          return;
        }
      }

      if (isCompactActions) {
        const leftNeeded = left.scrollWidth;
        const gap = 16;
        const neededIfExpanded = leftNeeded + expandedActionsWidthRef.current + gap;
        if (neededIfExpanded <= available - 12) {
          setIsCompactActions(false);
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
  }, [editingId, favoriteNewsletterId, favoriteNewsletterName, autosaveStatus, isCompactActions]);

  const buildArticleDraftPayload = () => ({
    language: selectedLanguage,
    title: title.trim(),
    markdown: "",
    contentHTML: articleContentHTML,
    public: isPublic,
    tags,
    topicIcon: topicIcon.trim(),
    illustration: topicIconIllustration,
    iconSource: customIconImageDataUrl.trim()
      ? customIconImageDataUrl.trim()
      : buildTopicIconIllustration(tablerIconMap, resolvedTopicIconName, topicIconBgColor, topicIconStrokeColor, topicIconFillColor),
    iconZoom: customIconImageDataUrl.trim() ? customIconImageSizeDelta : 0,
    iconBgColor: topicIconBgColor,
    iconStrokeColor: topicIconStrokeColor,
    iconFillColor: topicIconFillColor
  });

  const onSubmit = async () => {
    const emptyBody = isEmptyArticleBodyContent(articleContentHTML);
    if (!title.trim() && !emptyBody) {
      setError("Title is required");
      return;
    }

    if (editingId && !isEditingOwnedByCurrentUser) {
      setError("You cannot save an article you do not own.");
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

    if (!isEditingOwnedByCurrentUser) {
      setAutosaveStatus("idle");
      return;
    }

    const payload = buildArticleDraftPayload();
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === lastSavedDraftRef.current) {
      return;
    }

    const emptyBody = isEmptyArticleBodyContent(payload.contentHTML);
    if (!payload.title && !emptyBody) {
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
  }, [editingId, isEditingOwnedByCurrentUser, selectedLanguage, title, articleContentHTML, isPublic, tags, topicIcon, topicIconIllustration]);

  useEffect(() => () => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    if (autosaveClearSavedRef.current !== null) {
      window.clearTimeout(autosaveClearSavedRef.current);
    }
  }, [articleListLanguage]);

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
      const source = await getArticle(editingId, selectedLanguage);
      const created = await createArticle({
        authorId: oidcEnabled ? undefined : FALLBACK_AUTHOR_ID,
        language: selectedLanguage,
        public: source.public !== false,
        title: `${source.title} (copy)`,
        markdown: source.markdown,
        contentHTML: source.contentHTML ?? "",
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
        height: "calc(100vh - 60px)",
        minHeight: 560,
        position: "relative"
      }}
    >
      {isMobile && (
        <div
          onTouchEnd={() => {
            const target = isMobileEditorOpen ? editorPaneRef.current : articleListViewportRef.current;
            target?.scrollTo({ top: 0, behavior: "smooth" });
          }}
          style={{ position: "fixed", top: 0, left: 0, right: 0, height: 12, zIndex: 1000 }}
        />
      )}
      <div style={{ overflow: "hidden", display: isMobile && isMobileEditorOpen ? "none" : undefined }}>
        <Group justify="space-between" p="sm" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
          <Text fw={600}>{articleFilterLabel} ({sortedArticles.length})</Text>
          <Group gap="xs">
            <Button
              variant="light"
              size="xs"
              onClick={() => {
                pendingEditRef.current = null;
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

        <div style={{ padding: 10, borderBottom: "1px solid var(--mantine-color-default-border)", display: "flex", alignItems: "center", gap: 6 }}>
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

        <ScrollArea h="calc(100% - 110px)" offsetScrollbars viewportRef={articleListViewportRef}>
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
                  borderBottom: "1px solid var(--mantine-color-default-border)",
                  cursor: "pointer",
                  backgroundColor: selectedArticleId === article.id ? "var(--mantine-primary-color-light)" : "transparent",
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start"
                }}
              >
                {article.illustration ? (
                  <img
                    src={article.illustration}
                    alt=""
                    style={{ width: 36, height: 36, borderRadius: 6, flexShrink: 0, objectFit: "contain" }}
                  />
                ) : null}
                <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                    <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0, justifyContent: "flex-start" }}>
                      {allNewsletterSummaries.length > 0 && !usedArticleIds.has(article.id) ? (
                        <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "var(--mantine-primary-color-filled)", flexShrink: 0 }} />
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
                        <IconMail size={12} color="var(--mantine-primary-color-filled)" style={{ flexShrink: 0 }} />
                      ) : null}
                    </Group>
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                      {formatArticleCreatedAt(article.createdAt)}
                    </Text>
                  </Group>
                  {(article.owner ?? "").trim() !== "" ? (
                    <Group gap={4} wrap="nowrap" align="center">
                      <IconUserFilled size={11} color="var(--mantine-color-gray-6)" style={{ flexShrink: 0 }} />
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
                            backgroundColor: "var(--mantine-color-gray-5)",
                            color: "var(--mantine-color-white)",
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

      <div ref={editorPaneRef} style={{ padding: "12px clamp(8px, 2.5vw, 12px)", overflow: "auto", display: isMobile && !isMobileEditorOpen ? "none" : undefined }}>
        {!hasLoadedArticles || (!editingId && !isManualNewArticleMode && articles.length > 0) ? (
          <Center h="100%">
            <Stack align="center" gap="xs">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">{!hasLoadedArticles ? "Loading articles..." : "Loading article..."}</Text>
            </Stack>
          </Center>
        ) : (
        <Stack style={isReadOnlyArticleView ? { width: "100%", maxWidth: favoriteNewsletterContentWidth, margin: "0 auto" } : undefined}>
          <Group justify="space-between" wrap="nowrap" ref={headerRowRef} style={{ overflow: "hidden", minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap" ref={headerLeftRef}>
              {isMobile ? (
                <ActionIcon variant="light" size="md" aria-label="Back" onClick={() => setIsMobileEditorOpen(false)}>
                  <IconChevronLeft size={18} />
                </ActionIcon>
              ) : null}
              {isMobile && editingId ? (
                <ActionIcon
                  variant="light"
                  size="md"
                  aria-label="New Article"
                  title="New Article"
                  onClick={() => {
                    pendingEditRef.current = null;
                    setIsManualNewArticleMode(true);
                    resetForm();
                  }}
                >
                  <IconPlus size={16} />
                </ActionIcon>
              ) : null}
              {editingId && !isEditingOwnedByCurrentUser ? (
                <Tooltip label="Read only (not owner)" position="bottom" withArrow>
                  <Text fw={700} style={{ whiteSpace: "nowrap", flexShrink: 0, cursor: "help" }}>
                    View Article
                  </Text>
                </Tooltip>
              ) : (
                <Text fw={700} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                  {editingId ? "Edit Article" : "New Article"}
                </Text>
              )}
              {editingId && isEditingOwnedByCurrentUser && autosaveStatus === "error" ? (
                <Text size="xs" c="red">
                  Autosave failed
                </Text>
              ) : null}
              <Menu position="bottom-start" withArrow>
                <Menu.Target>
                  {isMobile ? (
                    <ActionIcon
                      variant="default"
                      size="md"
                      aria-label={`Language: ${languageLabel(selectedLanguage)}`}
                      title={`Language: ${languageLabel(selectedLanguage)}`}
                    >
                      <Text component="span" size="sm">
                        {languageFlag(selectedLanguage)}
                      </Text>
                    </ActionIcon>
                  ) : (
                    <Button variant="default" size="xs" leftSection={<IconLanguage size={14} />} rightSection={<IconChevronDown size={12} />}>
                      Language: {languageLabel(selectedLanguage)}
                    </Button>
                  )}
                </Menu.Target>
                <Menu.Dropdown>
                  {ARTICLE_LANGUAGES.map((language) => (
                    <Menu.Item
                      key={`article-language-${language.code}`}
                      onClick={() => onSelectEditorLanguage(language.code)}
                      leftSection={<IconCheck size={14} style={{ opacity: selectedLanguage === language.code ? 1 : 0 }} />}
                    >
                      {language.label}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            </Group>
            {editingId ? (
              <Group gap="xs" wrap="nowrap" ref={headerActionsRef}>
                {isEditingOwnedByCurrentUser && autosaveStatus === "saving" ? (
                  <Tooltip label="Saving changes" position="bottom" withArrow>
                    <Box
                      aria-label="Saving changes"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 28,
                        height: 28,
                        color: "var(--mantine-color-blue-6)"
                      }}
                    >
                      <IconRefresh size={14} className="article-autosave-refresh" />
                    </Box>
                  </Tooltip>
                ) : null}
                {favoriteNewsletterId ? (
                  isCompactActions || isMobile ? (
                    <ActionIcon
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
                        color={isEditingArticleInFavorite ? "var(--mantine-primary-color-filled)" : "var(--mantine-color-gray-5)"}
                      />
                    </ActionIcon>
                  ) : (
                    <Button
                      variant="default"
                      size="xs"
                      leftSection={
                        <IconMail
                          size={14}
                          color={isEditingArticleInFavorite ? "var(--mantine-primary-color-filled)" : "var(--mantine-color-gray-5)"}
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
                {isCompactActions || isMobile ? (
                  <ActionIcon variant="default" size="md" aria-label="Duplicate" title="Duplicate" onClick={() => void onDuplicateArticle()} loading={isDuplicatingArticle}>
                    <IconFiles size={16} />
                  </ActionIcon>
                ) : (
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() => void onDuplicateArticle()}
                    loading={isDuplicatingArticle}
                  >
                    Duplicate
                  </Button>
                )}
                {oidcEnabled && !articles.find((article) => article.id === editingId)?.owner ? (
                  isCompactActions || isMobile ? (
                    <ActionIcon variant="light" color="blue" size="md" aria-label="Claim" title="Claim" onClick={() => void onClaimArticle()} loading={isClaimingArticle}>
                      <IconUserCheck size={16} />
                    </ActionIcon>
                  ) : (
                    <Button
                      variant="light"
                      color="blue"
                      size="xs"
                      onClick={() => void onClaimArticle()}
                      loading={isClaimingArticle}
                    >
                      Claim
                    </Button>
                  )
                ) : null}
                {isReadOnlyArticleView ? null : (isCompactActions || isMobile ? (
                  <ActionIcon variant="light" color="red" size="md" aria-label="Delete" title="Delete" onClick={() => requestDeleteArticle(editingId)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                ) : (
                  <Button color="red" variant="light" size="xs" onClick={() => requestDeleteArticle(editingId)}>
                    Delete
                  </Button>
                ))}
              </Group>
            ) : null}
          </Group>

          {isReadOnlyArticleView ? (
            <Stack gap="xs">
              <Group align="center" gap="sm" wrap="nowrap">
                <Box
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 9999,
                    border: "1px solid var(--mantine-color-default-border)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: topicIconIllustration ? "var(--mantine-color-body)" : "var(--mantine-color-default)",
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
                    <Text size="xs" c="dimmed">No icon</Text>
                  )}
                </Box>
                <Text>{title || "Untitled article"}</Text>
              </Group>
            </Stack>
          ) : (
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
                  border: "1px solid var(--mantine-color-default-border)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                    background: topicIconIllustration ? "var(--mantine-color-body)" : "var(--mantine-color-default)",
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
          )}

          {canEditVisibility ? (
            <Checkbox
              checked={isPublic}
              onChange={(event) => setIsPublic(event.currentTarget.checked)}
              label="Public article"
              description="Private articles are visible only to their owner."
            />
          ) : null}

          {isReadOnlyArticleView ? (
            <Stack gap={6}>
              {(tags ?? []).length > 0 ? (
                <Group gap={6} wrap="wrap">
                  {(tags ?? []).map((tag) => (
                    <Badge key={`readonly-tag-${tag}`} size="xs" variant="light" color={colorForTag(tag)}>
                      {tag}
                    </Badge>
                  ))}
                </Group>
              ) : (
                <Text size="sm" c="dimmed">No tags</Text>
              )}
            </Stack>
          ) : (
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
          )}

          {isReadOnlyArticleView ? (
            <Box style={{ width: "100%", minHeight: 240 }}>
              {articleContentHTML?.trim() ? (
                <div className="article-readonly-preview" dangerouslySetInnerHTML={{ __html: articleContentHTML }} />
              ) : (
                <Text size="sm" c="dimmed">No content</Text>
              )}
            </Box>
          ) : (
            <Input.Wrapper
              label="Content"
              description="Compose the article body. Paste images to embed inline."
            >
              <SimpleEditor
                key={articleEditorKey}
                initialContent={articleContentHTML || undefined}
                onContentChange={setArticleContentHTML}
              />
            </Input.Wrapper>
          )}

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

      <style>{`
        .article-readonly-preview img {
          max-width: 100% !important;
          height: auto !important;
        }

        .article-autosave-refresh {
          animation: article-autosave-spin 0.9s linear infinite;
        }

        @keyframes article-autosave-spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>

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
                  border: "1px solid var(--mantine-color-default-border)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: topicIconIllustration ? "var(--mantine-color-body)" : "var(--mantine-color-default)",
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
                <ColorInput
                  label="Fill"
                  format="hex"
                  value={topicIconFillColor}
                  onChange={setTopicIconFillColor}
                  swatches={["#228be6", "#15aabf", "#40c057", "#fab005", "#fd7e14", "#fa5252", "#ffffff", "#000000"]}
                  style={{ minWidth: 220 }}
                />
              </Group>
            </Stack>

            <Group justify={isMobile ? "center" : "flex-end"} mt="sm" gap="xs" grow={isMobile || undefined}>
              <Button
                variant="outline"
                color="gray"
                onClick={() => {
                  setTopicIcon("");
                  setCustomIconImageDataUrl("");
                  setCustomIconImageSizeDelta(0);
                }}
              >
                Clear icon
              </Button>
              <Button
                variant="light"
                disabled={!topicIconIllustration}
                onClick={() => {
                  if (!topicIconIllustration) return;
                  const next = [topicIconIllustration, ...savedIcons.filter((s) => s !== topicIconIllustration)].slice(0, MAX_SAVED_ICONS);
                  setSavedIcons(next);
                  try { window.localStorage.setItem(SAVED_ICONS_STORAGE_KEY, JSON.stringify(next)); } catch { /* quota */ }
                  putSavedIcons(next).catch(() => { /* best effort */ });
                }}
              >
                Save icon
              </Button>
            </Group>
          </Paper>

          {savedIcons.length > 0 && (
            <Paper withBorder p="sm" radius="md">
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text fw={600} size="sm">Saved icons</Text>
                  <Button
                    variant="subtle"
                    color="gray"
                    size="compact-xs"
                    onClick={() => {
                      setSavedIcons([]);
                      window.localStorage.removeItem(SAVED_ICONS_STORAGE_KEY);
                      putSavedIcons([]).catch(() => { /* best effort */ });
                    }}
                  >
                    Clear all
                  </Button>
                </Group>
                <Group gap="xs" wrap="wrap">
                  {savedIcons.map((icon, idx) => (
                    <Box key={idx} style={{ position: "relative", width: 48, height: 48 }}>
                      <Tooltip label="Click to use">
                        <UnstyledButton
                          onClick={() => {
                            savedIconActiveRef.current = true;
                            setTopicIcon("");
                            setCustomIconImageDataUrl("");
                            setCustomIconImageSizeDelta(0);
                            setTopicIconIllustration(icon);
                          }}
                          style={{
                            width: 48,
                            height: 48,
                            borderRadius: 9999,
                            border: topicIconIllustration === icon ? "2px solid var(--mantine-primary-color-filled)" : "1px solid var(--mantine-color-default-border)",
                            overflow: "hidden",
                            cursor: "pointer",
                            padding: 0,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Box
                            component="img"
                            src={icon}
                            alt={`Saved icon ${idx + 1}`}
                            w={48}
                            h={48}
                            width={48}
                            height={48}
                            style={{ display: "block" }}
                          />
                        </UnstyledButton>
                      </Tooltip>
                      <ActionIcon
                        size={16}
                        radius="xl"
                        variant="filled"
                        color="dark"
                        onClick={(e: ReactMouseEvent) => {
                          e.stopPropagation();
                          const next = savedIcons.filter((_, i) => i !== idx);
                          setSavedIcons(next);
                          window.localStorage.setItem(SAVED_ICONS_STORAGE_KEY, JSON.stringify(next));
                          putSavedIcons(next).catch(() => { /* best effort */ });
                        }}
                        style={{
                          position: "absolute",
                          top: -4,
                          right: -4,
                          zIndex: 1,
                          cursor: "pointer",
                        }}
                      >
                        <IconX size={10} />
                      </ActionIcon>
                    </Box>
                  ))}
                </Group>
              </Stack>
            </Paper>
          )}

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
                      leftSection={isMobile ? undefined : <IconUpload size={14} />}
                      onClick={() => iconSvgUploadInputRef.current?.click()}
                    >
                      {isMobile ? <IconUpload size={14} /> : "Upload SVG"}
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
                <Box style={{ flex: 1, height: 1, background: "var(--mantine-color-default-border)" }} />
                <Text size="xs" c="dimmed" fw={600}>or</Text>
                <Box style={{ flex: 1, height: 1, background: "var(--mantine-color-default-border)" }} />
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
                          border: isSelected ? "1px solid var(--mantine-primary-color-filled)" : "1px solid var(--mantine-color-default-border)",
                          borderRadius: 8,
                          background: isSelected ? "var(--mantine-primary-color-light)" : "var(--mantine-color-body)",
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
