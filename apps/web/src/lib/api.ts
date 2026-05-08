import type { Article, ArticleSummary, Contact, Header, ListResponse, Newsletter, NewsletterPreview, NewsletterSummary } from "../types/domain";

const API_ROOT = "/api";

export class TokenExpiredError extends Error {
  constructor() {
    super("token_expired");
    this.name = "TokenExpiredError";
  }
}

type CreateArticlePayload = {
  authorId?: string;
  public?: boolean;
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
};

type CreateNewsletterPayload = {
  creatorId?: string;
  title: string;
  headerId?: string;
  introMarkdown: string;
  introHTML?: string;
  includeIndex: boolean;
  articleIds: string[];
  recipientIds: string[];
  contactTags?: string[];
  contactTagsMode?: string;
};

type UpdateNewsletterPayload = {
  title: string;
  headerId?: string;
  introMarkdown: string;
  introHTML?: string;
  includeIndex: boolean;
  contentWidth: number;
  archived: boolean;
  articleIds: string[];
  recipientIds: string[];
  contactTags?: string[];
  contactTagsMode?: string;
};

type UpdateArticlePayload = {
  public?: boolean;
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
};

type CreateHeaderPayload = {
  creatorId?: string;
  title: string;
  markdown: string;
};

type UpdateHeaderPayload = {
  title: string;
  markdown: string;
};

type RuntimeConfig = {
  smtpConfigured: boolean;
  oidcEnabled: boolean;
  contactsDisabled: boolean;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isJSON = contentType.includes("application/json");
  const payload = isJSON
    ? ((await response.json()) as T | { error: string })
    : ((await response.text()) as unknown as T | { error: string });

  if (!response.ok) {
    if (response.status === 401 && (payload as { error?: string }).error === "token_expired") {
      throw new TokenExpiredError();
    }
    const message =
      (payload as { error?: string }).error ??
      (typeof payload === "string" && payload.length > 0 ? payload : "Request failed");
    throw new Error(message);
  }

  return payload as T;
}

export async function listArticleSummaries(): Promise<ArticleSummary[]> {
  const data = await request<ListResponse<ArticleSummary>>("/articles/");
  return data.items;
}

export async function getArticle(id: string): Promise<Article> {
  return request<Article>(`/articles/${id}`);
}

export async function claimArticle(id: string): Promise<Article> {
  return request<Article>(`/articles/${id}/claim`, {
    method: "POST"
  });
}

export async function createArticle(payload: CreateArticlePayload): Promise<Article> {
  return request<Article>("/articles/", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateArticle(id: string, payload: UpdateArticlePayload): Promise<Article> {
  return request<Article>(`/articles/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function deleteArticle(id: string): Promise<void> {
  await request(`/articles/${id}`, {
    method: "DELETE"
  });
}

export async function listNewsletters(): Promise<Newsletter[]> {
  const data = await request<ListResponse<Newsletter>>("/newsletters/");
  return data.items;
}

export async function listNewsletterSummaries(): Promise<NewsletterSummary[]> {
  const data = await request<ListResponse<NewsletterSummary>>("/newsletters/?view=summary");
  return data.items;
}

export async function getNewsletter(id: string): Promise<Newsletter> {
  return request<Newsletter>(`/newsletters/${id}`);
}

export async function claimNewsletter(id: string): Promise<Newsletter> {
  return request<Newsletter>(`/newsletters/${id}/claim`, {
    method: "POST"
  });
}

export async function listHeaders(): Promise<Header[]> {
  const data = await request<ListResponse<Header>>("/headers/");
  return data.items;
}

export async function createHeader(payload: CreateHeaderPayload): Promise<Header> {
  return request<Header>("/headers/", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateHeader(id: string, payload: UpdateHeaderPayload): Promise<Header> {
  return request<Header>(`/headers/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function deleteHeader(id: string): Promise<void> {
  await request(`/headers/${id}`, {
    method: "DELETE"
  });
}

export async function createNewsletter(payload: CreateNewsletterPayload): Promise<Newsletter> {
  return request<Newsletter>("/newsletters/", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateNewsletter(id: string, payload: UpdateNewsletterPayload): Promise<Newsletter> {
  return request<Newsletter>(`/newsletters/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function scheduleNewsletter(id: string, scheduledAt: string): Promise<void> {
  await request(`/newsletters/${id}/schedule`, {
    method: "POST",
    body: JSON.stringify({ scheduledAt })
  });
}

export async function setNewsletterFavorite(id: string, isFavorite: boolean): Promise<Newsletter> {
  return request<Newsletter>(`/newsletters/${id}/favorite`, {
    method: "POST",
    body: JSON.stringify({ isFavorite })
  });
}

export async function sendNewsletterNow(id: string): Promise<void> {
  await request(`/newsletters/${id}/send-now`, {
    method: "POST"
  });
}

export async function deleteNewsletter(id: string): Promise<void> {
  await request(`/newsletters/${id}`, {
    method: "DELETE"
  });
}

export async function getNewsletterPreview(id: string): Promise<NewsletterPreview> {
  return request<NewsletterPreview>(`/newsletters/${id}/preview`);
}

export async function renderMarkdown(markdown: string): Promise<string> {
  const response = await request<{ html: string }>("/render/markdown", {
    method: "POST",
    body: JSON.stringify({ markdown })
  });
  return response.html;
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  return request<RuntimeConfig>("/runtime-config");
}

type ContactPayload = {
  firstName: string;
  lastName: string;
  email: string;
  tags?: string[];
};

type BulkImportResult = {
  imported: number;
  skipped: number;
};

export async function listContacts(): Promise<Contact[]> {
  const data = await request<ListResponse<Contact>>("/contacts/");
  return data.items;
}

export async function createContact(payload: ContactPayload): Promise<Contact> {
  return request<Contact>("/contacts/", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateContact(id: string, payload: ContactPayload): Promise<Contact> {
  return request<Contact>(`/contacts/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function deleteContact(id: string): Promise<void> {
  await request(`/contacts/${id}`, {
    method: "DELETE"
  });
}

export async function bulkImportContacts(contacts: ContactPayload[]): Promise<BulkImportResult> {
  return request<BulkImportResult>("/contacts/import", {
    method: "POST",
    body: JSON.stringify({ contacts })
  });
}

export async function getSavedIcons(): Promise<string[]> {
  const data = await request<{ icons: string[] }>("/saved-icons");
  return data.icons;
}

export async function putSavedIcons(icons: string[]): Promise<string[]> {
  const data = await request<{ icons: string[] }>("/saved-icons", {
    method: "PUT",
    body: JSON.stringify({ icons })
  });
  return data.icons;
}
