export type ArticleStatus = "draft" | "published" | "archived";

export type ArticleLanguageCode = "en" | "fr" | "de" | "es" | "it" | "ja" | "zh";

export type HeaderStatus = "draft" | "published" | "archived";

export interface Article {
  id: string;
  authorId: string;
  owner?: string;
  public: boolean;
  availableLanguages?: ArticleLanguageCode[];
  title: string;
  markdown: string;
  contentHTML?: string;
  tags?: string[];
  topicIcon?: string;
  illustration?: string;
  iconSource?: string;
  iconZoom?: number;
  iconBgColor?: string;
  iconStrokeColor?: string;
  iconFillColor?: string;
  sentCount?: number;
  lastUsed?: string;
  status: ArticleStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArticleSummary {
  id: string;
  owner?: string;
  public: boolean;
  availableLanguages?: ArticleLanguageCode[];
  title: string;
  tags?: string[];
  topicIcon?: string;
  illustration?: string;
  sentCount?: number;
  lastUsed?: string;
  status: ArticleStatus;
  createdAt: string;
  updatedAt: string;
  preview: string;
}

export type NewsletterStatus = "draft" | "scheduled" | "sending" | "sent" | "failed";

export interface Newsletter {
  id: string;
  creatorId: string;
  owner?: string;
  title: string;
  template?: string;
  headerId?: string;
  introMarkdown: string;
  introHTML?: string;
  footerMarkdown: string;
  footerHTML?: string;
  includeIndex: boolean;
  contentWidth: number;
  articleIds: string[];
  recipientIds: string[];
  contactTags?: string[];
  contactTagsMode?: string;
  isFavorite: boolean;
  archived: boolean;
  status: NewsletterStatus;
  deliveryError?: string;
  scheduledAt?: string;
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewsletterSummary {
  id: string;
  owner?: string;
  title: string;
  template?: string;
  headerId?: string;
  includeIndex: boolean;
  articleIds: string[];
  recipientIds: string[];
  contactTags?: string[];
  contactTagsMode?: string;
  isFavorite: boolean;
  archived: boolean;
  status: NewsletterStatus;
  deliveryError?: string;
  scheduledAt?: string;
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
}

export interface Header {
  id: string;
  creatorId: string;
  title: string;
  markdown: string;
  status: HeaderStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NewsletterPreview {
  newsletter: Newsletter;
  articles: Article[];
  html: string;
  text: string;
}

export interface ListResponse<T> {
  items: T[];
}
