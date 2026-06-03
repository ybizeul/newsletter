import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Center,
  Checkbox,
  Group,
  Input,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Tooltip
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronUp,
  IconEye,
  IconFiles,
  IconGripVertical,
  IconPlus,
  IconRefresh,
  IconSend,
  IconStar,
  IconTrash,
  IconUserCheck,
  IconX
} from "@tabler/icons-react";
import {
  claimNewsletter,
  createNewsletter,
  deleteNewsletter,
  getNewsletter,
  getRuntimeConfig,
  listArticleSummaries,
  listContacts,
  listHeaders,
  listNewsletterTemplates,
  listNewsletterSummaries,
  scheduleNewsletter,
  sendNewsletterNow,
  updateNewsletter,
  renderMarkdown,
  TokenExpiredError
} from "../lib/api";
import type { ArticleLanguageCode, ArticleSummary, Contact, Header, Newsletter, NewsletterSummary } from "../types/domain";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { DateTimePicker } from "@mantine/dates";
import { SimpleEditor } from "@/components/tiptap-templates/simple/simple-editor";

const FALLBACK_CREATOR_ID = "demo-user";
const NEWSLETTERS_PANE_WIDTH_STORAGE_KEY = "newsletter.newsletters.pane.width";
const FAVORITE_NEWSLETTER_ID_STORAGE_KEY = "newsletter.favorite.id";
const PENDING_SEND_NEWSLETTER_ID_KEY = "newsletter.pending_send.id";
const MAX_RECIPIENTS = 3;
const ARTICLE_REUSE_WARNING_TEXT = "already used in another newsletter";
const DEFAULT_NEWSLETTER_TEMPLATE = "default";
const DEFAULT_NEWSLETTER_LANGUAGE: ArticleLanguageCode = "fr";
const NO_HEADER_OPTION_VALUE = "__none__";
const NEWSLETTER_LANGUAGE_OPTIONS: Array<{ value: ArticleLanguageCode; label: string }> = [
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" }
];

function formatTemplateLabel(templateName: string): string {
  return templateName
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

type NewslettersDataCache = {
  articles: ArticleSummary[];
  headers: Header[];
  newsletterTemplates: string[];
  newsletters: NewsletterSummary[];
  smtpConfigured: boolean;
  contacts: Contact[];
};

let cachedNewslettersData: NewslettersDataCache | null = null;

function getStoredNewslettersPaneWidth(): number {
  const raw = window.localStorage.getItem(NEWSLETTERS_PANE_WIDTH_STORAGE_KEY);
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

function formatNewsletterCreatedAt(value: string): string {
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

function getDefaultNewsletterTitle(date = new Date()): string {
  const month = date.toLocaleDateString(undefined, { month: "long" });
  return `Newsletter ${month}`;
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

function toNewsletterSummary(newsletter: Newsletter): NewsletterSummary {
  const previewSource = newsletter.introHTML?.trim()
    ? htmlPreviewText(newsletter.introHTML)
    : markdownPreview(newsletter.introMarkdown);
  return {
    id: newsletter.id,
    owner: newsletter.owner,
    title: newsletter.title,
    language: newsletter.language,
    template: newsletter.template,
    headerId: newsletter.headerId,
    includeIndex: newsletter.includeIndex,
    articleIds: newsletter.articleIds,
    recipientIds: newsletter.recipientIds,
    isFavorite: newsletter.isFavorite,
    archived: newsletter.archived,
    status: newsletter.status,
    deliveryError: newsletter.deliveryError,
    scheduledAt: newsletter.scheduledAt,
    sentAt: newsletter.sentAt,
    createdAt: newsletter.createdAt,
    updatedAt: newsletter.updatedAt,
    preview: cutByChars(previewSource, 180)
  };
}

export default function NewslettersPage() {
  const { user, oidcEnabled, contactsDisabled, scheduleDisabled } = useAuth();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const headerRowRef = useRef<HTMLDivElement | null>(null);
  const headerLeftRef = useRef<HTMLDivElement | null>(null);
  const headerActionsRef = useRef<HTMLDivElement | null>(null);
  const expandedActionsWidthRef = useRef<number>(0);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveClearSavedRef = useRef<number | null>(null);
  const lastSavedDraftRef = useRef<string>("");
  const isLoadingNewsletterRef = useRef(false);
  const pendingEditRef = useRef<string | null>(null);
  const wasNewslettersRouteActiveRef = useRef(false);
  const [leftPaneWidth, setLeftPaneWidth] = useState(getStoredNewslettersPaneWidth);
  const isMobile = useMediaQuery("(max-width: 48em)");
  const [isMobileEditorOpen, setIsMobileEditorOpen] = useState(false);
  const [isCompactActions, setIsCompactActions] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const [articles, setArticles] = useState<ArticleSummary[]>(() => cachedNewslettersData?.articles ?? []);
  const [headers, setHeaders] = useState<Header[]>(() => cachedNewslettersData?.headers ?? []);
  const [newsletterTemplates, setNewsletterTemplates] = useState<string[]>(() => cachedNewslettersData?.newsletterTemplates ?? [DEFAULT_NEWSLETTER_TEMPLATE]);
  const [newsletters, setNewsletters] = useState<NewsletterSummary[]>(() => {
    const favoriteId = getStoredFavoriteNewsletterId();
    return (cachedNewslettersData?.newsletters ?? []).map((newsletter) => ({
      ...newsletter,
      isFavorite: newsletter.id === favoriteId
    }));
  });
  const restoredNewsletterIdRef = useRef(
    (location.state as { selectedNewsletterId?: string } | null)?.selectedNewsletterId ??
    new URLSearchParams(location.search).get("selected") ??
    null
  );

  const [selectedNewsletterId, setSelectedNewsletterID] = useState<string | null>(
    () => restoredNewsletterIdRef.current
  );
  const [title, setTitle] = useState("");
  const [newsletterLanguage, setNewsletterLanguage] = useState<ArticleLanguageCode>(DEFAULT_NEWSLETTER_LANGUAGE);
  const [headerId, setHeaderId] = useState<string | null>(null);
  const [newsletterTemplate, setNewsletterTemplate] = useState(DEFAULT_NEWSLETTER_TEMPLATE);
  const [, setIntroMarkdown] = useState("");
  const [introContentHTML, setIntroContentHTML] = useState("");
  const [introEditorKey, setIntroEditorKey] = useState("");
  const [, setFooterMarkdown] = useState("");
  const [footerContentHTML, setFooterContentHTML] = useState("");
  const [footerEditorKey, setFooterEditorKey] = useState("");
  const [includeIndex, setIncludeIndex] = useState(false);
  const [archived, setArchived] = useState(false);
  const [contentWidth, setContentWidth] = useState(680);
  const [articleIds, setArticleIDs] = useState<string[]>([]);
  const [draggedArticleId, setDraggedArticleId] = useState<string | null>(null);
  const [recipientRaw, setRecipientRaw] = useState("");
  const [recipientMode, setRecipientMode] = useState<"emails" | "contacts">("emails");
  const [contactTags, setContactTags] = useState<string[]>([]);
  const [contactTagsMode, setContactTagsMode] = useState<"all" | "any">("any");
  const [contacts, setContacts] = useState<Contact[]>(() => cachedNewslettersData?.contacts ?? []);
  const [scheduledAtInput, setScheduledAtInput] = useState<string | null>(null);
  const [smtpConfigured, setSmtpConfigured] = useState(() => cachedNewslettersData?.smtpConfigured ?? true);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSendingNow, setIsSendingNow] = useState(false);
  const [isDuplicatingNewsletter, setIsDuplicatingNewsletter] = useState(false);
  const [isClaimingNewsletter, setIsClaimingNewsletter] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteNewsletterId, setDeleteNewsletterId] = useState<string | null>(null);
  const [hasLoadedNewslettersData, setHasLoadedNewslettersData] = useState(() => cachedNewslettersData !== null);
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [favoriteNewsletterId, setFavoriteNewsletterId] = useState<string | null>(getStoredFavoriteNewsletterId);
  const [isManualNewNewsletterMode, setIsManualNewNewsletterMode] = useState(false);

  const [isCreatingNewsletter, setIsCreatingNewsletter] = useState(false);

  const withFavoriteFlag = (newsletter: NewsletterSummary): NewsletterSummary => ({
    ...newsletter,
    isFavorite: newsletter.id === favoriteNewsletterId
  });

  const normalizedUserEmail = useMemo(
    () => (user?.email ?? "").trim().toLowerCase(),
    [user?.email]
  );

  const articleIdsUsedInOtherNewsletters = useMemo(() => {
    const used = new Set<string>();
    for (const newsletter of newsletters) {
      if (newsletter.id === selectedNewsletterId) {
        continue;
      }
      if (oidcEnabled) {
        if (!normalizedUserEmail) {
          continue;
        }
        const normalizedOwner = (newsletter.owner ?? "").trim().toLowerCase();
        if (normalizedOwner !== normalizedUserEmail) {
          continue;
        }
      }
      for (const articleId of newsletter.articleIds ?? []) {
        used.add(articleId);
      }
    }
    return used;
  }, [newsletters, selectedNewsletterId, oidcEnabled, normalizedUserEmail]);

  const availableArticleOptions = useMemo(
    () =>
      articles.map((article) => ({
        value: article.id,
        label: article.title
      })),
    [articles]
  );

  const headerOptions = useMemo(
    () => headers.map((header) => ({ value: header.id, label: header.title })),
    [headers]
  );

  const newsletterTemplateOptions = useMemo(
    () =>
      newsletterTemplates.map((templateName) => ({
        value: templateName,
        label: formatTemplateLabel(templateName)
      })),
    [newsletterTemplates]
  );

  const selectedArticleRows = useMemo(
    () =>
      articleIds.map((articleId) => {
        const article = articles.find((item) => item.id === articleId);
        return {
          id: articleId,
          title: article?.title ?? "(missing article)",
          illustration: article?.illustration ?? "",
          exists: Boolean(article),
          usedInAnotherNewsletter: articleIdsUsedInOtherNewsletters.has(articleId)
        };
      }),
    [articleIds, articles, articleIdsUsedInOtherNewsletters]
  );

  const articleOptionsForAdd = useMemo(
    () =>
      availableArticleOptions
        .filter((option) => !articleIds.includes(option.value))
        .sort((a, b) => {
          const aUsed = articleIdsUsedInOtherNewsletters.has(a.value) ? 1 : 0;
          const bUsed = articleIdsUsedInOtherNewsletters.has(b.value) ? 1 : 0;
          return aUsed - bUsed;
        }),
    [availableArticleOptions, articleIds, articleIdsUsedInOtherNewsletters]
  );

  const allContactTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) {
      for (const t of c.tags ?? []) {
        set.add(t);
      }
    }
    return Array.from(set).sort();
  }, [contacts]);

  const resolvedContactCount = useMemo(() => {
    if (recipientMode !== "contacts" || contactTags.length === 0) return null;
    const lowerTags = contactTags.map((t) => t.toLowerCase());
    const matched = contacts.filter((c) => {
      const cTags = (c.tags ?? []).map((t) => t.toLowerCase());
      if (contactTagsMode === "all") {
        return lowerTags.every((tag) => cTags.includes(tag));
      }
      return lowerTags.some((tag) => cTags.includes(tag));
    });
    return matched.length;
  }, [recipientMode, contactTags, contactTagsMode, contacts]);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [articleItems, headerItems, newsletterItems, runtimeConfig, contactItems, templateItems] = await Promise.all([
        listArticleSummaries(newsletterLanguage),
        listHeaders(),
        listNewsletterSummaries(),
        getRuntimeConfig(),
        listContacts(),
        listNewsletterTemplates()
      ]);
      const normalizedTemplates = templateItems.length > 0 ? templateItems : [DEFAULT_NEWSLETTER_TEMPLATE];
      cachedNewslettersData = {
        articles: articleItems,
        headers: headerItems,
        newsletterTemplates: normalizedTemplates,
        newsletters: newsletterItems,
        smtpConfigured: runtimeConfig.smtpConfigured,
        contacts: contactItems
      };
      setArticles(articleItems);
      setHeaders(headerItems);
      setNewsletterTemplates(normalizedTemplates);
      setNewsletters(newsletterItems.map(withFavoriteFlag));
      setSmtpConfigured(runtimeConfig.smtpConfigured);
      setContacts(contactItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load newsletters");
    } finally {
      setIsLoading(false);
      setHasLoadedNewslettersData(true);
    }
  };

  useEffect(() => {
    if (!hasLoadedNewslettersData) {
      return;
    }
    cachedNewslettersData = {
      articles,
      headers,
      newsletterTemplates,
      newsletters,
      smtpConfigured,
      contacts
    };
  }, [articles, headers, newsletterTemplates, newsletters, smtpConfigured, contacts, hasLoadedNewslettersData]);

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    setNewsletters((current) =>
      current.map((newsletter) => ({
        ...newsletter,
        isFavorite: newsletter.id === favoriteNewsletterId
      }))
    );
  }, [favoriteNewsletterId]);

  useEffect(() => {
    const isNewslettersRoute =
      location.pathname.startsWith("/newsletters") &&
      !/\/newsletters\/[^/]+\/preview$/.test(location.pathname);

    if (!isNewslettersRoute) {
      wasNewslettersRouteActiveRef.current = false;
      return;
    }

    if (wasNewslettersRouteActiveRef.current) {
      return;
    }

    wasNewslettersRouteActiveRef.current = true;

    void (async () => {
      try {
        const latestArticles = await listArticleSummaries(newsletterLanguage);
        setArticles(latestArticles);
        cachedNewslettersData = {
          articles: latestArticles,
          headers,
          newsletterTemplates,
          newsletters,
          smtpConfigured,
          contacts
        };
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to refresh articles");
      }
    })();
  }, [location.pathname, newsletterLanguage, headers, newsletterTemplates, newsletters, smtpConfigured, contacts]);

  const refreshArticleOptions = async (language: ArticleLanguageCode = newsletterLanguage) => {
    const latestArticles = await listArticleSummaries(language);
    setArticles(latestArticles);
    cachedNewslettersData = {
      articles: latestArticles,
      headers,
      newsletterTemplates,
      newsletters,
      smtpConfigured,
      contacts
    };
  };

  useEffect(() => {
    if (!hasLoadedNewslettersData) {
      return;
    }
    void (async () => {
      try {
        await refreshArticleOptions(newsletterLanguage);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to refresh articles");
      }
    })();
  }, [newsletterLanguage, hasLoadedNewslettersData]);

  const resetForm = () => {
    setSelectedNewsletterID(null);
    setTitle("");
    setNewsletterLanguage(DEFAULT_NEWSLETTER_LANGUAGE);
    setNewsletterTemplate(DEFAULT_NEWSLETTER_TEMPLATE);
    setHeaderId(null);
    setIntroContentHTML("");
    setIntroEditorKey("");
    setIntroMarkdown("");
    setFooterContentHTML("");
    setFooterEditorKey("");
    setFooterMarkdown("");
    setIncludeIndex(false);
    setArchived(false);
    setContentWidth(680);
    setArticleIDs([]);
    setDraggedArticleId(null);
    setRecipientRaw("");
    setRecipientMode("emails");
    setContactTags([]);
    setContactTagsMode("any");
    setScheduledAtInput(null);
    lastSavedDraftRef.current = "";
    setAutosaveStatus("idle");
  };

  const onSelectNewsletter = async (newsletter: NewsletterSummary) => {
    pendingEditRef.current = newsletter.id;
    isLoadingNewsletterRef.current = true;
    setIsManualNewNewsletterMode(false);
    setSelectedNewsletterID(newsletter.id);
    setError(null);
    try {
      const fullNewsletter = await getNewsletter(newsletter.id);
      if (pendingEditRef.current !== newsletter.id) return;
      setSelectedNewsletterID(fullNewsletter.id);
      setTitle(fullNewsletter.title);
      setNewsletterLanguage(fullNewsletter.language ?? DEFAULT_NEWSLETTER_LANGUAGE);
      setNewsletterTemplate((fullNewsletter.template ?? DEFAULT_NEWSLETTER_TEMPLATE).trim() || DEFAULT_NEWSLETTER_TEMPLATE);
      setHeaderId(fullNewsletter.headerId ?? null);
      setIntroMarkdown(fullNewsletter.introMarkdown);
      let introHTML: string;
      if (fullNewsletter.introHTML?.trim()) {
        introHTML = fullNewsletter.introHTML;
      } else if (fullNewsletter.introMarkdown?.trim()) {
        try { introHTML = await renderMarkdown(fullNewsletter.introMarkdown); if (pendingEditRef.current !== newsletter.id) return; } catch { introHTML = "<p></p>"; }
      } else {
        introHTML = "<p></p>";
      }
      setIntroContentHTML(introHTML || "");
      setIntroEditorKey(fullNewsletter.id);
      setFooterMarkdown(fullNewsletter.footerMarkdown);
      let footerHTML: string;
      if (fullNewsletter.footerHTML?.trim()) {
        footerHTML = fullNewsletter.footerHTML;
      } else if (fullNewsletter.footerMarkdown?.trim()) {
        try { footerHTML = await renderMarkdown(fullNewsletter.footerMarkdown); if (pendingEditRef.current !== newsletter.id) return; } catch { footerHTML = "<p></p>"; }
      } else {
        footerHTML = "<p></p>";
      }
      setFooterContentHTML(footerHTML || "");
      setFooterEditorKey(fullNewsletter.id + "-footer");
      setIncludeIndex(Boolean(fullNewsletter.includeIndex));
      setArchived(Boolean(fullNewsletter.archived));
      setContentWidth(fullNewsletter.contentWidth || 680);
      setArticleIDs(fullNewsletter.articleIds);
      setRecipientRaw(fullNewsletter.recipientIds.join(","));
      if (fullNewsletter.contactTags && fullNewsletter.contactTags.length > 0) {
        setRecipientMode("contacts");
        setContactTags(fullNewsletter.contactTags);
        setContactTagsMode(
          fullNewsletter.contactTagsMode === "all" ? "all" : "any"
        );
      } else {
        setRecipientMode("emails");
        setContactTags([]);
        setContactTagsMode("any");
      }
      if (fullNewsletter.scheduledAt) {
        setScheduledAtInput(fullNewsletter.scheduledAt);
      } else {
        setScheduledAtInput(null);
      }
      lastSavedDraftRef.current = JSON.stringify({
        title: fullNewsletter.title.trim(),
        language: fullNewsletter.language ?? DEFAULT_NEWSLETTER_LANGUAGE,
        template: (fullNewsletter.template ?? DEFAULT_NEWSLETTER_TEMPLATE).trim() || DEFAULT_NEWSLETTER_TEMPLATE,
        headerId: fullNewsletter.headerId ?? "",
        introMarkdown: "",
        introHTML: introHTML,
        footerMarkdown: "",
        footerHTML: footerHTML,
        includeIndex: Boolean(fullNewsletter.includeIndex),
        contentWidth: fullNewsletter.contentWidth || 680,
        articleIds: fullNewsletter.articleIds,
        recipientIds: fullNewsletter.recipientIds,
        contactTags: fullNewsletter.contactTags ?? [],
        contactTagsMode: fullNewsletter.contactTagsMode ?? "any"
      });
      isLoadingNewsletterRef.current = false;
      setAutosaveStatus("idle");
      if (isMobile) {
        setIsMobileEditorOpen(true);
      }
      if (window.sessionStorage.getItem(PENDING_SEND_NEWSLETTER_ID_KEY) === fullNewsletter.id) {
        window.sessionStorage.removeItem(PENDING_SEND_NEWSLETTER_ID_KEY);
        setIsSendingNow(true);
        try {
          await sendNewsletterNow(fullNewsletter.id);
          await loadData();
        } catch (sendErr) {
          if (sendErr instanceof TokenExpiredError) {
            window.sessionStorage.setItem(PENDING_SEND_NEWSLETTER_ID_KEY, fullNewsletter.id);
            const returnTo = `/newsletters?selected=${encodeURIComponent(fullNewsletter.id)}`;
            window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
            return;
          }
          setError(sendErr instanceof Error ? sendErr.message : "Failed to send newsletter now");
        } finally {
          setIsSendingNow(false);
        }
      }
    } catch (err) {
      isLoadingNewsletterRef.current = false;
      setError(err instanceof Error ? err.message : "Failed to load newsletter details");
    }
  };

  useEffect(() => {
    if (newsletters.length === 0) {
      return;
    }

    if (restoredNewsletterIdRef.current) {
      const restoredId = restoredNewsletterIdRef.current;
      restoredNewsletterIdRef.current = null;
      const match = newsletters.find((n) => n.id === restoredId);
      if (match) {
        void onSelectNewsletter(match);
        return;
      }
    }

    if (isMobile && !selectedNewsletterId) {
      return;
    }

    if (!selectedNewsletterId) {
      if (isManualNewNewsletterMode) {
        return;
      }
      void onSelectNewsletter(newsletters[0]);
      return;
    }

    if (!newsletters.some((newsletter) => newsletter.id === selectedNewsletterId)) {
      setIsManualNewNewsletterMode(false);
      resetForm();
    }
  }, [newsletters, isMobile, selectedNewsletterId, isManualNewNewsletterMode]);

  useEffect(() => {
    if (!isMobile) {
      setIsMobileEditorOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    const row = headerRowRef.current;
    const left = headerLeftRef.current;
    const actions = headerActionsRef.current;
    if (!row || !left || !actions || !selectedNewsletterId) {
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
  }, [selectedNewsletterId, autosaveStatus, isCompactActions]);

  const parseRecipients = () =>
    recipientRaw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

  const parsedRecipients = useMemo(() => parseRecipients(), [recipientRaw]);
  const hasTooManyRecipients = parsedRecipients.length > MAX_RECIPIENTS;

  const buildNewsletterDraftPayload = () => ({
    title: title.trim(),
    language: newsletterLanguage,
    template: newsletterTemplate,
    headerId: headerId ?? "",
    introMarkdown: "",
    introHTML: introContentHTML,
    footerMarkdown: "",
    footerHTML: footerContentHTML,
    includeIndex,
    contentWidth,
    archived,
    articleIds,
    recipientIds: recipientMode === "emails" ? parseRecipients() : [],
    contactTags: recipientMode === "contacts" ? contactTags : [],
    contactTagsMode: recipientMode === "contacts" ? contactTagsMode : "any"
  });

  const scheduleAutosaveSavedReset = () => {
    if (autosaveClearSavedRef.current !== null) {
      window.clearTimeout(autosaveClearSavedRef.current);
    }
    autosaveClearSavedRef.current = window.setTimeout(() => {
      setAutosaveStatus("idle");
    }, 1200);
  };

  const onCreateNewsletter = async () => {
    setIsCreatingNewsletter(true);
    setError(null);
    try {
      const created = await createNewsletter({
        creatorId: oidcEnabled ? undefined : FALLBACK_CREATOR_ID,
        title: getDefaultNewsletterTitle(),
        language: DEFAULT_NEWSLETTER_LANGUAGE,
        template: DEFAULT_NEWSLETTER_TEMPLATE,
        introMarkdown: "",
        includeIndex: false,
        articleIds: [],
        recipientIds: [],
      });
      const summary = withFavoriteFlag(toNewsletterSummary(created));
      setNewsletters((current) => [summary, ...current]);
      await onSelectNewsletter(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create newsletter");
    } finally {
      setIsCreatingNewsletter(false);
    }
  };

  const onSave = async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    if (hasTooManyRecipients && recipientMode === "emails") {
      setError(`A maximum of ${MAX_RECIPIENTS} recipients is allowed`);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const payload = buildNewsletterDraftPayload();

      if (selectedNewsletterId) {
        const updated = await updateNewsletter(selectedNewsletterId, payload);
        setNewsletters((current) =>
          current.map((newsletter) => (newsletter.id === selectedNewsletterId ? withFavoriteFlag(toNewsletterSummary(updated)) : newsletter))
        );
        lastSavedDraftRef.current = JSON.stringify(payload);
        setAutosaveStatus("saved");
        scheduleAutosaveSavedReset();
      } else {
        const created = await createNewsletter({
          creatorId: oidcEnabled ? undefined : FALLBACK_CREATOR_ID,
          ...payload
        });
        setNewsletters((current) => [withFavoriteFlag(toNewsletterSummary(created)), ...current]);
        setSelectedNewsletterID(created.id);
        setIsManualNewNewsletterMode(false);
        lastSavedDraftRef.current = JSON.stringify(payload);
        setAutosaveStatus("saved");
        scheduleAutosaveSavedReset();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save newsletter");
      setAutosaveStatus("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!selectedNewsletterId || isSubmitting || isLoadingNewsletterRef.current) {
      return;
    }

    if (hasTooManyRecipients && recipientMode === "emails") {
      return;
    }

    const payload = buildNewsletterDraftPayload();
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
        const updated = await updateNewsletter(selectedNewsletterId, payload);
        setNewsletters((current) =>
          current.map((newsletter) => (newsletter.id === selectedNewsletterId ? withFavoriteFlag(toNewsletterSummary(updated)) : newsletter))
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
  }, [selectedNewsletterId, title, newsletterLanguage, newsletterTemplate, headerId, introContentHTML, footerContentHTML, includeIndex, contentWidth, archived, articleIds, recipientRaw, recipientMode, contactTags, contactTagsMode, hasTooManyRecipients, isSubmitting]);

  useEffect(() => () => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    if (autosaveClearSavedRef.current !== null) {
      window.clearTimeout(autosaveClearSavedRef.current);
    }
  }, []);

  const onSchedule = async () => {
    if (!selectedNewsletterId) {
      setError("Select a newsletter first");
      return;
    }
    if (!scheduledAtInput) {
      setError("Select schedule date and time first");
      return;
    }

    setError(null);
    try {
      await scheduleNewsletter(selectedNewsletterId, new Date(scheduledAtInput).toISOString());
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to schedule newsletter");
    }
  };

  const onSendNow = async () => {
    if (!selectedNewsletterId) {
      setError("Select a newsletter first");
      return;
    }
    if (!contactsDisabled && recipientMode === "contacts" && contactTags.length === 0) {
      setError("Add at least one tag to send to contacts");
      return;
    }

    setError(null);
    setIsSendingNow(true);
    try {
      await sendNewsletterNow(selectedNewsletterId);
      await loadData();
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        window.sessionStorage.setItem(PENDING_SEND_NEWSLETTER_ID_KEY, selectedNewsletterId);
        const returnTo = `/newsletters?selected=${encodeURIComponent(selectedNewsletterId)}`;
        window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to send newsletter now");
    } finally {
      setIsSendingNow(false);
    }
  };

  const onToggleFavorite = async () => {
    if (!selectedNewsletterId) {
      return;
    }

    const selected = newsletters.find((newsletter) => newsletter.id === selectedNewsletterId);
    if (!selected) {
      return;
    }

    const nextFavoriteId = selected.isFavorite ? null : selectedNewsletterId;
    setFavoriteNewsletterId(nextFavoriteId);
    if (nextFavoriteId) {
      window.localStorage.setItem(FAVORITE_NEWSLETTER_ID_STORAGE_KEY, nextFavoriteId);
    } else {
      window.localStorage.removeItem(FAVORITE_NEWSLETTER_ID_STORAGE_KEY);
    }

    setNewsletters((current) =>
      current.map((newsletter) => ({
        ...newsletter,
        isFavorite: newsletter.id === nextFavoriteId
      }))
    );
  };

  const requestDeleteNewsletter = (newsletterId: string) => {
    setDeleteNewsletterId(newsletterId);
  };

  const confirmDeleteNewsletter = async () => {
    if (!deleteNewsletterId) {
      return;
    }

    setError(null);
    try {
      await deleteNewsletter(deleteNewsletterId);
      setNewsletters((current) => current.filter((newsletter) => newsletter.id !== deleteNewsletterId));
      if (favoriteNewsletterId === deleteNewsletterId) {
        setFavoriteNewsletterId(null);
        window.localStorage.removeItem(FAVORITE_NEWSLETTER_ID_STORAGE_KEY);
      }
      if (selectedNewsletterId === deleteNewsletterId) {
        resetForm();
        if (isMobile) {
          setIsMobileEditorOpen(false);
        }
      }
      setDeleteNewsletterId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete newsletter");
    }
  };

  const onDuplicateNewsletter = async () => {
    if (!selectedNewsletterId) {
      return;
    }

    setIsDuplicatingNewsletter(true);
    setError(null);

    try {
      const source = await getNewsletter(selectedNewsletterId);
      const created = await createNewsletter({
        creatorId: oidcEnabled ? undefined : FALLBACK_CREATOR_ID,
        title: `${source.title} (copy)`,
        language: source.language ?? DEFAULT_NEWSLETTER_LANGUAGE,
        template: source.template ?? DEFAULT_NEWSLETTER_TEMPLATE,
        headerId: source.headerId ?? "",
        introMarkdown: source.introMarkdown ?? "",
        introHTML: source.introHTML ?? "",
        footerMarkdown: source.footerMarkdown ?? "",
        footerHTML: source.footerHTML ?? "",
        includeIndex: Boolean(source.includeIndex),
        articleIds: source.articleIds,
        recipientIds: source.recipientIds,
        contactTags: source.contactTags ?? [],
        contactTagsMode: source.contactTagsMode ?? "any"
      });

      const createdSummary = withFavoriteFlag(toNewsletterSummary(created));
      setNewsletters((current) => [createdSummary, ...current]);
      void onSelectNewsletter(createdSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to duplicate newsletter");
    } finally {
      setIsDuplicatingNewsletter(false);
    }
  };

  const onClaimNewsletter = async () => {
    if (!selectedNewsletterId) {
      return;
    }

    setIsClaimingNewsletter(true);
    setError(null);
    try {
      const claimed = await claimNewsletter(selectedNewsletterId);
      setNewsletters((current) =>
        current.map((newsletter) =>
          newsletter.id === selectedNewsletterId ? withFavoriteFlag(toNewsletterSummary(claimed)) : newsletter
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to claim newsletter");
    } finally {
      setIsClaimingNewsletter(false);
    }
  };

  const removeArticleFromNewsletter = (articleId: string) => {
    setArticleIDs((current) => current.filter((id) => id !== articleId));
  };

  const moveArticle = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) {
      return;
    }

    setArticleIDs((current) => {
      const sourceIndex = current.indexOf(sourceId);
      const targetIndex = current.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };

  const moveArticleByOffset = (articleId: string, offset: -1 | 1) => {
    setArticleIDs((current) => {
      const sourceIndex = current.indexOf(articleId);
      if (sourceIndex < 0) {
        return current;
      }

      const targetIndex = sourceIndex + offset;
      if (targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };

  const selectedNewsletter = newsletters.find((newsletter) => newsletter.id === selectedNewsletterId) ?? null;

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
      window.localStorage.setItem(NEWSLETTERS_PANE_WIDTH_STORAGE_KEY, String(clampedWidth));
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
          <Text fw={600}>Newsletters ({newsletters.length})</Text>
          <Group gap="xs">
            <Button
              variant="light"
              size="xs"
              onClick={() => void onCreateNewsletter()}
              loading={isCreatingNewsletter}
            >
              New
            </Button>
          </Group>
        </Group>

        <ScrollArea h="calc(100% - 52px)" offsetScrollbars>
          <Stack gap={0}>
            {[...newsletters].sort((a, b) => (a.archived === b.archived ? 0 : a.archived ? 1 : -1)).map((newsletter) => (
              (() => {
                const titleText = cutByChars(newsletter.title, 72);
                const previewText = newsletter.preview;
                return (
              <div
                key={newsletter.id}
                onClick={() => void onSelectNewsletter(newsletter)}
                style={{
                  padding: 12,
                  borderBottom: "1px solid var(--mantine-color-default-border)",
                  cursor: "pointer",
                  backgroundColor: selectedNewsletterId === newsletter.id ? "var(--mantine-primary-color-light)" : "transparent",
                  opacity: newsletter.archived ? 0.5 : 1
                }}
              >
                <Stack gap={6} style={{ flex: 1 }}>
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                    <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0, justifyContent: "flex-start" }}>
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
                      {newsletter.isFavorite ? (
                        <IconStar size={12} fill="var(--mantine-color-yellow-4)" color="var(--mantine-color-yellow-6)" style={{ flexShrink: 0 }} />
                      ) : null}
                    </Group>
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                      {formatNewsletterCreatedAt(newsletter.createdAt)}
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
            {isLoading && newsletters.length === 0 ? (
              <Group justify="center" p="md" gap="xs">
                <Loader size="sm" />
                <Text c="dimmed" size="sm">Loading newsletters...</Text>
              </Group>
            ) : newsletters.length === 0 ? (
              <Text c="dimmed" size="sm" p="md">
                No newsletters.
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
        {!hasLoadedNewslettersData || (!selectedNewsletterId && !isManualNewNewsletterMode && newsletters.length > 0) ? (
          <Center h="100%">
            <Stack align="center" gap="xs">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">{!hasLoadedNewslettersData ? "Loading newsletters..." : "Loading newsletter..."}</Text>
            </Stack>
          </Center>
        ) : (
        <Stack>
          <Group justify="space-between" wrap="nowrap" ref={headerRowRef} style={{ overflow: "hidden", minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap" ref={headerLeftRef}>
              {isMobile ? (
                <ActionIcon variant="light" size="md" aria-label="Back" onClick={() => setIsMobileEditorOpen(false)}>
                  <IconChevronLeft size={18} />
                </ActionIcon>
              ) : null}
              {isMobile && selectedNewsletterId ? (
                <ActionIcon
                  variant="light"
                  size="md"
                  aria-label="New Newsletter"
                  title="New Newsletter"
                  onClick={() => void onCreateNewsletter()}
                  loading={isCreatingNewsletter}
                >
                  <IconPlus size={16} />
                </ActionIcon>
              ) : null}
              <Text fw={700} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>{selectedNewsletterId ? "Edit Newsletter" : "New Newsletter"}</Text>
              {selectedNewsletterId && autosaveStatus === "error" ? (
                <Text size="xs" c={autosaveStatus === "error" ? "red" : "dimmed"}>
                  Autosave failed
                </Text>
              ) : null}
            </Group>
            {selectedNewsletterId ? (
              <Group gap="xs" wrap="nowrap" ref={headerActionsRef}>
                {autosaveStatus === "saving" ? (
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
                      <IconRefresh size={14} className="newsletter-autosave-refresh" />
                    </Box>
                  </Tooltip>
                ) : null}
                <ActionIcon
                  variant={selectedNewsletter?.isFavorite ? "light" : "default"}
                  color={selectedNewsletter?.isFavorite ? "yellow" : "gray"}
                  size="md"
                  aria-label={selectedNewsletter?.isFavorite ? "Unset favorite" : "Set favorite"}
                  title={selectedNewsletter?.isFavorite ? "Unset favorite" : "Set favorite"}
                  onClick={() => void onToggleFavorite()}
                >
                  <IconStar
                    size={16}
                    fill={selectedNewsletter?.isFavorite ? "var(--mantine-color-yellow-4)" : "var(--mantine-color-body)"}
                    color={selectedNewsletter?.isFavorite ? "var(--mantine-color-yellow-6)" : "var(--mantine-color-gray-5)"}
                  />
                </ActionIcon>
                {isCompactActions || isMobile ? (
                  <ActionIcon variant="light" color="blue" size="md" aria-label="Preview" title="Preview" onClick={() => navigate(`/newsletters/${selectedNewsletterId}/preview`, { state: { selectedNewsletterId } })}>
                    <IconEye size={16} />
                  </ActionIcon>
                ) : (
                  <Button
                    variant="light"
                    color="blue"
                    size="xs"
                    onClick={() => navigate(`/newsletters/${selectedNewsletterId}/preview`, { state: { selectedNewsletterId } })}
                  >
                    Preview
                  </Button>
                )}
                {isCompactActions || isMobile ? (
                  <ActionIcon variant="default" size="md" aria-label="Duplicate" title="Duplicate" onClick={() => void onDuplicateNewsletter()} loading={isDuplicatingNewsletter}>
                    <IconFiles size={16} />
                  </ActionIcon>
                ) : (
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() => void onDuplicateNewsletter()}
                    loading={isDuplicatingNewsletter}
                  >
                    Duplicate
                  </Button>
                )}
                {oidcEnabled && !selectedNewsletter?.owner ? (
                  isCompactActions || isMobile ? (
                    <ActionIcon variant="light" color="blue" size="md" aria-label="Claim" title="Claim" onClick={() => void onClaimNewsletter()} loading={isClaimingNewsletter}>
                      <IconUserCheck size={16} />
                    </ActionIcon>
                  ) : (
                    <Button
                      variant="light"
                      color="blue"
                      size="xs"
                      onClick={() => void onClaimNewsletter()}
                      loading={isClaimingNewsletter}
                    >
                      Claim
                    </Button>
                  )
                ) : null}
                {isCompactActions || isMobile ? (
                  <ActionIcon variant="light" color="red" size="md" aria-label="Delete" title="Delete" onClick={() => requestDeleteNewsletter(selectedNewsletterId)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                ) : (
                  <Button color="red" variant="light" size="xs" onClick={() => requestDeleteNewsletter(selectedNewsletterId)}>
                    Delete
                  </Button>
                )}
              </Group>
            ) : null}
          </Group>

          <Checkbox
            label="Archived"
            checked={archived}
            onChange={(event) => setArchived(event.currentTarget.checked)}
          />

          <Group grow align="flex-start" wrap="nowrap">
            <Select
              label="Language"
              data={NEWSLETTER_LANGUAGE_OPTIONS}
              value={newsletterLanguage}
              onChange={(value) => setNewsletterLanguage((value ?? DEFAULT_NEWSLETTER_LANGUAGE) as ArticleLanguageCode)}
              allowDeselect={false}
              withCheckIcon={false}
            />

            <Select
              label="Header"
              data={[{ value: NO_HEADER_OPTION_VALUE, label: "No header" }, ...headerOptions]}
              value={headerId ?? NO_HEADER_OPTION_VALUE}
              onChange={(value) => setHeaderId(!value || value === NO_HEADER_OPTION_VALUE ? null : value)}
              allowDeselect={false}
              withCheckIcon={false}
            />

            {newsletterTemplateOptions.length > 1 ? (
              <Select
                label="Template"
                data={newsletterTemplateOptions}
                value={newsletterTemplate}
                onChange={(value) => setNewsletterTemplate(value ?? DEFAULT_NEWSLETTER_TEMPLATE)}
                allowDeselect={false}
                withCheckIcon={false}
              />
            ) : null}
          </Group>

          <TextInput
            label="Title"
            description="Display title for this newsletter edition."
            placeholder="April Product Digest"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />

          <Input.Wrapper
            label="Introduction"
            description="Write the opening section shown before the selected articles."
          >
            <SimpleEditor
              key={introEditorKey}
              initialContent={introContentHTML || undefined}
              onContentChange={setIntroContentHTML}
              minHeight={150}
            />
          </Input.Wrapper>

          <Checkbox
            label="Index"
            description="Generate an index of the articles after the introduction"
            checked={includeIndex}
            onChange={(event) => setIncludeIndex(event.currentTarget.checked)}
          />

            <Stack gap="xs">

            <Group align="end" grow>
              <Select
                label="Add existing article"
                description="Choose an article from the library to append to this newsletter. Articles already used in another newsletter appear last."
                placeholder="Choose an article"
                data={articleOptionsForAdd}
                renderOption={({ option }) => (
                  <span style={articleIdsUsedInOtherNewsletters.has(option.value) ? { color: "var(--mantine-color-dimmed)" } : undefined}>
                    {option.label}
                  </span>
                )}
                value={null}
                onChange={(value) => {
                  if (!value || articleIds.includes(value)) {
                    return;
                  }
                  setArticleIDs((current) => [...current, value]);
                }}
                onDropdownOpen={() => {
                  void (async () => {
                    try {
                      await refreshArticleOptions(newsletterLanguage);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Failed to refresh articles");
                    }
                  })();
                }}
                searchable
                nothingFoundMessage="No more articles available"
              />
            </Group>

            <Stack gap={8}>
              {selectedArticleRows.map((article, index) => (
                <div
                  key={article.id}
                  draggable={!isMobile}
                  onDragStart={() => {
                    if (!isMobile) {
                      setDraggedArticleId(article.id);
                    }
                  }}
                  onDragEnd={() => {
                    if (!isMobile) {
                      setDraggedArticleId(null);
                    }
                  }}
                  onDragOver={(event) => {
                    if (!isMobile) {
                      event.preventDefault();
                    }
                  }}
                  onDragEnter={() => {
                    if (!isMobile && draggedArticleId) {
                      moveArticle(draggedArticleId, article.id);
                    }
                  }}
                  style={{
                    width: "100%",
                    border: "1px solid var(--mantine-color-default-border)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    background: "var(--mantine-color-body)",
                    cursor: isMobile ? "default" : "grab"
                  }}
                >
                  <Group justify="space-between" wrap="nowrap" style={{ width: "100%" }}>
                    <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                      {!isMobile ? (
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center"
                          }}
                          title="Drag row to reorder"
                        >
                          <IconGripVertical size={16} color="var(--mantine-color-gray-6)" />
                        </div>
                      ) : null}
                      <Box
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: 9999,
                          border: "1px solid var(--mantine-color-default-border)",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                          background: "var(--mantine-color-default)",
                          flexShrink: 0
                        }}
                      >
                        {article.illustration ? (
                          <Box
                            component="img"
                            src={article.illustration}
                            alt="Article icon"
                            w={26}
                            h={26}
                            width={26}
                            height={26}
                            style={{ display: "block" }}
                          />
                        ) : (
                          <Text size="xs" c="dimmed">
                            -
                          </Text>
                        )}
                      </Box>
                      <Text
                        size="sm"
                        c={!article.exists ? "dimmed" : article.usedInAnotherNewsletter ? "red.9" : undefined}
                        truncate="end"
                        title={article.usedInAnotherNewsletter ? ARTICLE_REUSE_WARNING_TEXT : undefined}
                      >
                        {article.title}
                      </Text>
                    </Group>
                    <Group gap={4} wrap="nowrap">
                      {isMobile ? (
                        <>
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            onClick={() => moveArticleByOffset(article.id, -1)}
                            disabled={index === 0}
                            title="Move up"
                          >
                            <IconChevronUp size={16} />
                          </ActionIcon>
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            onClick={() => moveArticleByOffset(article.id, 1)}
                            disabled={index === selectedArticleRows.length - 1}
                            title="Move down"
                          >
                            <IconChevronDown size={16} />
                          </ActionIcon>
                        </>
                      ) : null}
                      <ActionIcon
                        color="red"
                        variant="subtle"
                        onClick={() => removeArticleFromNewsletter(article.id)}
                        title="Remove"
                      >
                        <IconX size={16} />
                      </ActionIcon>
                    </Group>
                  </Group>
                </div>
              ))}

              {selectedArticleRows.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No articles selected.
                </Text>
              ) : null}
            </Stack>
            </Stack>

          <Input.Wrapper
            label="Footer"
            description="Write the closing section shown after the selected articles."
          >
            <SimpleEditor
              key={footerEditorKey}
              initialContent={footerContentHTML || undefined}
              onContentChange={setFooterContentHTML}
              minHeight={150}
            />
          </Input.Wrapper>
            
          {smtpConfigured ? (
            <Stack gap="xs">
              {!contactsDisabled ? (
                <SegmentedControl
                  value={recipientMode}
                  onChange={(value) => setRecipientMode(value as "emails" | "contacts")}
                  data={[
                    { label: "Email list", value: "emails" },
                    { label: "Contacts by tag", value: "contacts" }
                  ]}
                  size="xs"
                />
              ) : null}

              {!contactsDisabled && recipientMode === "contacts" ? (
                <Stack gap="xs">
                  <TagsInput
                    label="Contact tags"
                    description="Send to all contacts that have these tags."
                    placeholder="Add a tag and press Enter"
                    value={contactTags}
                    onChange={setContactTags}
                    data={allContactTags}
                    clearable
                  />
                  <Select
                    label="Match mode"
                    description='"All" — contact must have every tag. "Any" — contact must have at least one tag.'
                    data={[
                      { value: "any", label: "Any tag" },
                      { value: "all", label: "All tags" }
                    ]}
                    value={contactTagsMode}
                    onChange={(v) => setContactTagsMode((v ?? "any") as "all" | "any")}
                    allowDeselect={false}
                  />
                </Stack>
              ) : (
                <TextInput
                  label="Recipients (emails, comma-separated)"
                  description={`Comma-separated recipient addresses used for send and schedule actions (${parsedRecipients.length}/${MAX_RECIPIENTS}).`}
                  placeholder="first@example.com,second@example.com"
                  value={recipientRaw}
                  onChange={(event) => setRecipientRaw(event.currentTarget.value)}
                  error={hasTooManyRecipients ? `A maximum of ${MAX_RECIPIENTS} recipients is allowed` : undefined}
                />
              )}
            </Stack>
          ) : null}

          {smtpConfigured && !scheduleDisabled ? (
            <Group grow>
              <DateTimePicker
                label="Schedule send"
                description="Set when this newsletter should be sent automatically."
                value={scheduledAtInput}
                onChange={setScheduledAtInput}
                clearable
              />
            </Group>
          ) : null}

          <Group justify="space-between">
            <Group gap="xs">
              {!selectedNewsletterId ? (
                <Button onClick={() => void onSave()} loading={isSubmitting}>
                  Create Newsletter
                </Button>
              ) : null}
              {smtpConfigured && !scheduleDisabled ? (
                <Button variant="light" onClick={() => void onSchedule()} disabled={!selectedNewsletterId}>
                  Schedule
                </Button>
              ) : null}
              {smtpConfigured ? (
                <Button
                  color="green"
                  variant="light"
                  leftSection={<IconSend size={16} />}
                  onClick={() => void onSendNow()}
                  loading={isSendingNow}
                  disabled={
                    !selectedNewsletterId ||
                    (recipientMode === "emails" && parsedRecipients.length === 0) ||
                    (!contactsDisabled && recipientMode === "contacts" && contactTags.length === 0)
                  }
                >
                  Send Now{resolvedContactCount !== null ? ` (${resolvedContactCount})` : recipientMode === "emails" && parsedRecipients.length > 0 ? ` (${parsedRecipients.length})` : ""}
                </Button>
              ) : null}
            </Group>
            <div />
          </Group>

          {selectedNewsletter?.deliveryError ? (
            <Text c="red" size="sm">
              Last Error: {selectedNewsletter.deliveryError}
            </Text>
          ) : null}

          {error ? <Text c="red">{error}</Text> : null}
        </Stack>
        )}
      </div>

      <style>{`
        .newsletter-autosave-refresh {
          animation: newsletter-autosave-spin 0.9s linear infinite;
        }

        @keyframes newsletter-autosave-spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>

      <Modal
        opened={Boolean(deleteNewsletterId)}
        onClose={() => setDeleteNewsletterId(null)}
        title="Confirm deletion"
        centered
      >
        <Stack>
          <Text size="sm">Delete this newsletter? This action cannot be undone.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteNewsletterId(null)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => void confirmDeleteNewsletter()}>
              Delete newsletter
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
