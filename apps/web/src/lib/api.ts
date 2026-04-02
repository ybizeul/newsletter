import type { Article, ListResponse, Newsletter, NewsletterPreview } from "../types/domain";

const API_ROOT = "/api";

type CreateArticlePayload = {
  authorId: string;
  title: string;
  markdown: string;
  topicIcon?: string;
  illustration?: string;
};

type CreateNewsletterPayload = {
  creatorId: string;
  title: string;
  introMarkdown: string;
  includeIndex: boolean;
  articleIds: string[];
  recipientIds: string[];
};

type UpdateNewsletterPayload = {
  title: string;
  introMarkdown: string;
  includeIndex: boolean;
  articleIds: string[];
  recipientIds: string[];
};

type UpdateArticlePayload = {
  title: string;
  markdown: string;
  topicIcon?: string;
  illustration?: string;
};

type RuntimeConfig = {
  smtpConfigured: boolean;
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
    const message =
      (payload as { error?: string }).error ??
      (typeof payload === "string" && payload.length > 0 ? payload : "Request failed");
    throw new Error(message);
  }

  return payload as T;
}

export async function listArticles(): Promise<Article[]> {
  const data = await request<ListResponse<Article>>("/articles/");
  return data.items;
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
