package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"newsletter/api/internal/model"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	mcpSearchLimit       = 20
	mcpRequestsPerMinute = 60

	mcpInstructions = "Search, read, and create newsletter articles for the authenticated user. " +
		"search_articles returns at most 20 summaries the caller is allowed to see: their own articles plus articles that are already public or unclaimed. " +
		"create_article always stores a private draft. The owner and author come from the access token, not from tool arguments."
)

// MCPEndpoint is the stateless Streamable HTTP handler mounted at /mcp.
// A personal access token authenticates the caller. Responses are a single
// JSON body, so the request does not stay open as a server-sent event stream.
func (h *Handler) MCPEndpoint(auth *OIDCAuth) http.Handler {
	if auth == nil {
		auth = &OIDCAuth{}
	}
	stream := h.mcpStreamHandler()
	return newMCPRateLimiter(mcpRequestsPerMinute, time.Minute).middleware(auth.MCPBearerMiddleware(stream))
}

// StripCredentialQuery drops token query parameters so a bearer token cannot
// be authenticated from the URL and is not written to the request log.
func StripCredentialQuery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		removed := false
		for key := range query {
			switch strings.ToLower(key) {
			case "token", "access_token", "authorization":
				query.Del(key)
				removed = true
			}
		}
		if removed {
			r.URL.RawQuery = query.Encode()
			r.RequestURI = r.URL.RequestURI()
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Handler) mcpStreamHandler() http.Handler {
	version := strings.TrimSpace(h.appVersion)
	if version == "" {
		version = "dev"
	}
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "newsletter",
		Version: version,
	}, &mcp.ServerOptions{Instructions: mcpInstructions})

	closedWorld := false
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &closedWorld}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "search_articles",
		Description: "Search articles visible to the authenticated user. Returns at most 20 summaries with id, title, preview, tags, status, language, and updated time.",
		Annotations: readOnly,
	}, h.mcpSearchArticles)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_article",
		Description: "Read one article by id, including its markdown, when the visibility rules allow it.",
		Annotations: readOnly,
	}, h.mcpGetArticle)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "create_article",
		Description: "Create a private draft article. Title and markdown are required. Owner and author are taken from the access token.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: &closedWorld, OpenWorldHint: &closedWorld},
	}, h.mcpCreateArticle)

	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		return server
	}, &mcp.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
	})
}

type mcpSearchArticlesInput struct {
	Query    string `json:"query,omitempty" jsonschema:"optional text matched against title, preview, markdown, and tags"`
	Tag      string `json:"tag,omitempty" jsonschema:"optional tag; matched case-insensitively"`
	Status   string `json:"status,omitempty" jsonschema:"optional status filter: draft, published, or archived"`
	Language string `json:"language,omitempty" jsonschema:"optional language code such as en or fr"`
}

type mcpArticleSummary struct {
	ID        string   `json:"id" jsonschema:"article id"`
	Title     string   `json:"title" jsonschema:"article title"`
	Preview   string   `json:"preview" jsonschema:"short plain-text preview"`
	Tags      []string `json:"tags" jsonschema:"article tags"`
	Status    string   `json:"status" jsonschema:"draft, published, or archived"`
	Language  string   `json:"language" jsonschema:"language code of the returned text"`
	UpdatedAt string   `json:"updatedAt" jsonschema:"last update time in RFC3339"`
}

type mcpSearchArticlesOutput struct {
	Articles []mcpArticleSummary `json:"articles" jsonschema:"matching articles visible to the caller"`
}

type mcpGetArticleInput struct {
	ID       string `json:"id" jsonschema:"article id"`
	Language string `json:"language,omitempty" jsonschema:"optional language code such as en or fr"`
}

type mcpArticleDetail struct {
	ID        string   `json:"id" jsonschema:"article id"`
	Title     string   `json:"title" jsonschema:"article title"`
	Markdown  string   `json:"markdown" jsonschema:"article markdown"`
	Tags      []string `json:"tags" jsonschema:"article tags"`
	Status    string   `json:"status" jsonschema:"draft, published, or archived"`
	Language  string   `json:"language" jsonschema:"language code of the returned markdown"`
	UpdatedAt string   `json:"updatedAt" jsonschema:"last update time in RFC3339"`
}

type mcpCreateArticleInput struct {
	Title    string   `json:"title" jsonschema:"article title"`
	Markdown string   `json:"markdown" jsonschema:"article body in markdown"`
	Language string   `json:"language,omitempty" jsonschema:"optional language code such as en or fr. Defaults to fr"`
	Tags     []string `json:"tags,omitempty" jsonschema:"optional tags"`
}

type mcpCreateArticleOutput struct {
	ID       string   `json:"id" jsonschema:"id of the created draft"`
	Title    string   `json:"title" jsonschema:"article title"`
	Status   string   `json:"status" jsonschema:"always draft"`
	Public   bool     `json:"public" jsonschema:"always false; the draft is private to its owner"`
	Language string   `json:"language" jsonschema:"language code of the created draft"`
	Tags     []string `json:"tags" jsonschema:"article tags"`
}

func (h *Handler) mcpSearchArticles(ctx context.Context, _ *mcp.CallToolRequest, in mcpSearchArticlesInput) (*mcp.CallToolResult, mcpSearchArticlesOutput, error) {
	out := mcpSearchArticlesOutput{Articles: []mcpArticleSummary{}}
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	status, err := parseMCPStatus(in.Status)
	if err != nil {
		return nil, out, err
	}
	language, err := parseMCPLanguage(in.Language, "")
	if err != nil {
		return nil, out, err
	}
	if err := h.mcpArticlesReady(); err != nil {
		return nil, out, err
	}

	cursor, err := h.articles.Find(ctx, mcpVisibleArticleFilter(user, status), options.Find().SetSort(bson.D{{Key: "updatedAt", Value: -1}}))
	if err != nil {
		log.Printf("mcp search articles: %v", err)
		return nil, out, fmt.Errorf("failed to search articles")
	}
	defer cursor.Close(ctx)

	var articles []model.Article
	if err := cursor.All(ctx, &articles); err != nil {
		log.Printf("mcp search articles: %v", err)
		return nil, out, fmt.Errorf("failed to search articles")
	}

	tag := strings.TrimSpace(in.Tag)
	candidates := make([]model.Article, 0, len(articles))
	ids := make([]string, 0, len(articles))
	for _, article := range articles {
		if tag != "" && !mcpHasTag(article.Tags, tag) {
			continue
		}
		candidates = append(candidates, article)
		ids = append(ids, article.ID)
	}

	translations, err := h.loadArticleTranslations(ctx, ids)
	if err != nil {
		log.Printf("mcp search articles: %v", err)
		return nil, out, fmt.Errorf("failed to search articles")
	}

	query := strings.TrimSpace(in.Query)
	for _, article := range candidates {
		translation, ok := mcpTranslation(article, translations[article.ID], language)
		if !ok || !mcpMatchesQuery(translation, article.Tags, query) {
			continue
		}
		out.Articles = append(out.Articles, mcpArticleSummary{
			ID:        article.ID,
			Title:     translation.Title,
			Preview:   contentPreview(translation.Markdown, translation.ContentHTML, 3, 180),
			Tags:      mcpStringList(article.Tags),
			Status:    string(article.Status),
			Language:  string(translation.Language),
			UpdatedAt: article.UpdatedAt.UTC().Format(time.RFC3339),
		})
		if len(out.Articles) >= mcpSearchLimit {
			break
		}
	}
	return nil, out, nil
}

func (h *Handler) mcpGetArticle(ctx context.Context, _ *mcp.CallToolRequest, in mcpGetArticleInput) (*mcp.CallToolResult, mcpArticleDetail, error) {
	var out mcpArticleDetail
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	id := strings.TrimSpace(in.ID)
	if id == "" {
		return nil, out, fmt.Errorf("id is required")
	}
	language, err := parseMCPLanguage(in.Language, "")
	if err != nil {
		return nil, out, err
	}
	if err := h.mcpArticlesReady(); err != nil {
		return nil, out, err
	}

	var article model.Article
	err = h.articles.FindOne(ctx, mcpVisibleArticleByIDFilter(user, id)).Decode(&article)
	if err == mongo.ErrNoDocuments {
		return nil, out, fmt.Errorf("article not found")
	}
	if err != nil {
		log.Printf("mcp get article: %v", err)
		return nil, out, fmt.Errorf("failed to fetch article")
	}

	translations, err := h.loadArticleTranslations(ctx, []string{article.ID})
	if err != nil {
		log.Printf("mcp get article: %v", err)
		return nil, out, fmt.Errorf("failed to fetch article")
	}
	translation, ok := mcpTranslation(article, translations[article.ID], language)
	if !ok {
		if language != "" {
			return nil, out, fmt.Errorf("article has no content in that language")
		}
		translation = model.ArticleTranslation{}
	}

	out = mcpArticleDetail{
		ID:        article.ID,
		Title:     translation.Title,
		Markdown:  translation.Markdown,
		Tags:      mcpStringList(article.Tags),
		Status:    string(article.Status),
		Language:  string(translation.Language),
		UpdatedAt: article.UpdatedAt.UTC().Format(time.RFC3339),
	}
	return nil, out, nil
}

func (h *Handler) mcpCreateArticle(ctx context.Context, _ *mcp.CallToolRequest, in mcpCreateArticleInput) (*mcp.CallToolResult, mcpCreateArticleOutput, error) {
	var out mcpCreateArticleOutput
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	language, err := parseMCPLanguage(in.Language, model.LanguageFrench)
	if err != nil {
		return nil, out, err
	}
	title := strings.TrimSpace(in.Title)
	article, contentHTML, err := newMCPDraftArticle(user, title, in.Markdown, in.Tags, time.Now())
	if err != nil {
		return nil, out, err
	}
	if err := h.mcpArticlesReady(); err != nil {
		return nil, out, err
	}

	if _, err := h.articles.InsertOne(ctx, article); err != nil {
		log.Printf("mcp create article: %v", err)
		return nil, out, fmt.Errorf("failed to create article")
	}
	if err := h.upsertArticleTranslation(ctx, article.ID, language, article.Owner, title, in.Markdown, contentHTML, article.UpdatedAt); err != nil {
		_, _ = h.articles.DeleteOne(ctx, bson.M{"_id": article.ID})
		log.Printf("mcp create article translation: %v", err)
		return nil, out, fmt.Errorf("failed to create article")
	}

	out = mcpCreateArticleOutput{
		ID:       article.ID,
		Title:    title,
		Status:   string(article.Status),
		Public:   article.Public,
		Language: string(language),
		Tags:     mcpStringList(article.Tags),
	}
	return nil, out, nil
}

func (h *Handler) mcpArticlesReady() error {
	if h == nil || h.articles == nil || h.articleTranslations == nil {
		return fmt.Errorf("article store unavailable")
	}
	return nil
}

func mcpCaller(ctx context.Context) (*User, error) {
	user := UserFromContext(ctx)
	if user == nil || strings.TrimSpace(user.ID) == "" || resolveOwnerEmail(user, "") == "" {
		return nil, fmt.Errorf("not authenticated")
	}
	return user, nil
}

func mcpVisibleArticleFilter(user *User, status model.ArticleStatus) bson.M {
	visibility := articleVisibilityFilter(user)
	if status == "" {
		return visibility
	}
	return bson.M{"$and": []bson.M{
		visibility,
		{"status": status},
	}}
}

func mcpVisibleArticleByIDFilter(user *User, id string) bson.M {
	return bson.M{
		"_id":  id,
		"$and": []bson.M{articleVisibilityFilter(user)},
	}
}

func newMCPDraftArticle(user *User, title, markdown string, tags []string, now time.Time) (model.Article, string, error) {
	if user == nil || strings.TrimSpace(user.ID) == "" || resolveOwnerEmail(user, "") == "" {
		return model.Article{}, "", fmt.Errorf("not authenticated")
	}
	title = strings.TrimSpace(title)
	if title == "" || strings.TrimSpace(markdown) == "" {
		return model.Article{}, "", fmt.Errorf("title and markdown are required")
	}
	contentHTML, err := renderMarkdownToSafeHTML(markdown)
	if err != nil {
		return model.Article{}, "", fmt.Errorf("failed to render markdown")
	}
	now = now.UTC()
	article := model.Article{
		ID:        bson.NewObjectID().Hex(),
		AuthorID:  user.ID,
		Owner:     resolveOwnerEmail(user, ""),
		Public:    false,
		Tags:      normalizeArticleTags(tags),
		SentCount: 0,
		Preview:   contentPreview(markdown, contentHTML, 3, 180),
		Status:    model.ArticleStatusDraft,
		Version:   1,
		CreatedAt: now,
		UpdatedAt: now,
	}
	return article, contentHTML, nil
}

func parseMCPStatus(raw string) (model.ArticleStatus, error) {
	switch status := model.ArticleStatus(strings.ToLower(strings.TrimSpace(raw))); status {
	case "":
		return "", nil
	case model.ArticleStatusDraft, model.ArticleStatusPublished, model.ArticleStatusArchived:
		return status, nil
	default:
		return "", fmt.Errorf("status must be draft, published, or archived")
	}
}

func parseMCPLanguage(raw string, fallback model.LanguageCode) (model.LanguageCode, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fallback, nil
	}
	language := normalizeArticleLanguage(trimmed, "")
	if language == "" {
		return "", fmt.Errorf("unsupported language %q", trimmed)
	}
	return language, nil
}

func mcpTranslation(article model.Article, byLang map[model.LanguageCode]model.ArticleTranslation, language model.LanguageCode) (model.ArticleTranslation, bool) {
	if language != "" {
		translation, ok := byLang[language]
		if !ok || isBlankArticleTranslation(translation) {
			return model.ArticleTranslation{}, false
		}
		return translation, true
	}
	if translation, ok := pickArticleTranslation(byLang, "", false, model.LanguageFrench); ok && !isBlankArticleTranslation(translation) {
		return translation, true
	}
	if strings.TrimSpace(article.Title) == "" && strings.TrimSpace(article.Markdown) == "" && strings.TrimSpace(article.ContentHTML) == "" {
		return model.ArticleTranslation{}, false
	}
	return model.ArticleTranslation{
		Title:       article.Title,
		Markdown:    article.Markdown,
		ContentHTML: article.ContentHTML,
	}, true
}

func mcpMatchesQuery(translation model.ArticleTranslation, tags []string, query string) bool {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return true
	}
	if strings.Contains(strings.ToLower(translation.Title), query) {
		return true
	}
	if strings.Contains(strings.ToLower(translation.Markdown), query) {
		return true
	}
	preview := contentPreview(translation.Markdown, translation.ContentHTML, 3, 180)
	if strings.Contains(strings.ToLower(preview), query) {
		return true
	}
	for _, tag := range tags {
		if strings.Contains(strings.ToLower(tag), query) {
			return true
		}
	}
	return false
}

func mcpHasTag(tags []string, want string) bool {
	want = strings.ToLower(strings.TrimSpace(want))
	if want == "" {
		return true
	}
	for _, tag := range tags {
		if strings.ToLower(strings.TrimSpace(tag)) == want {
			return true
		}
	}
	return false
}

func mcpStringList(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	out := make([]string, len(values))
	copy(out, values)
	return out
}

type mcpRateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string][]time.Time
	now    func() time.Time
}

func newMCPRateLimiter(limit int, window time.Duration) *mcpRateLimiter {
	return &mcpRateLimiter{
		limit:  limit,
		window: window,
		hits:   make(map[string][]time.Time),
		now:    time.Now,
	}
}

func (l *mcpRateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token, ok := bearerToken(r.Header.Get("Authorization")); ok {
			sum := sha256.Sum256([]byte(token))
			if !l.allow(base64.RawURLEncoding.EncodeToString(sum[:])) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", "60")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"error":"rate limit exceeded"}`))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (l *mcpRateLimiter) allow(key string) bool {
	if key == "" || l.limit <= 0 {
		return true
	}
	now := l.now()
	cutoff := now.Add(-l.window)

	l.mu.Lock()
	defer l.mu.Unlock()

	kept := make([]time.Time, 0, len(l.hits[key])+1)
	for _, ts := range l.hits[key] {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= l.limit {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	if len(l.hits) > 1024 {
		for existing, ts := range l.hits {
			if len(ts) == 0 || !ts[len(ts)-1].After(cutoff) {
				delete(l.hits, existing)
			}
		}
	}
	return true
}
