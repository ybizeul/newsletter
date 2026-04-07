export type ArticleStatus = "draft" | "published" | "archived";

export type HeaderStatus = "draft" | "published" | "archived";

export interface Article {
  id: string;
  authorId: string;
  title: string;
  markdown: string;
  tags?: string[];
  topicIcon?: string;
  illustration?: string;
  iconSource?: string;
  iconZoom?: number;
  iconBgColor?: string;
  iconStrokeColor?: string;
  sentCount?: number;
  lastUsed?: string;
  status: ArticleStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArticleSummary {
  id: string;
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
  title: string;
  headerId?: string;
  introMarkdown: string;
  includeIndex: boolean;
  articleIds: string[];
  recipientIds: string[];
  isFavorite: boolean;
  status: NewsletterStatus;
  deliveryError?: string;
  scheduledAt?: string;
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewsletterSummary {
  id: string;
  title: string;
  headerId?: string;
  includeIndex: boolean;
  articleIds: string[];
  recipientIds: string[];
  isFavorite: boolean;
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

export interface NewsletterPreview {
  newsletter: Newsletter;
  articles: Article[];
  html: string;
  text: string;
}

export interface ListResponse<T> {
  items: T[];
}
