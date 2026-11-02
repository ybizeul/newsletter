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

	mcpInstructions = "Search, read, create, update, and delete articles and newsletters for the authenticated user. " +
		"Articles store one translation per language (en, fr, de, es, it, ja, zh). " +
		"search_articles returns at most 20 articles and includes every translation on each article. search_newsletters returns at most 20 summaries. " +
		"Article search includes the caller's articles plus articles that are already public or unclaimed. " +
		"Newsletter search includes the caller's newsletters plus unclaimed newsletters. " +
		"create_article and create_newsletter always store a private draft. The owner and author come from the access token, not from tool arguments. " +
		"Update and delete require the caller to own the document. Sending and scheduling are not available."
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
	destructive := true
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &closedWorld}
	write := &mcp.ToolAnnotations{DestructiveHint: &closedWorld, OpenWorldHint: &closedWorld}
	remove := &mcp.ToolAnnotations{DestructiveHint: &destructive, OpenWorldHint: &closedWorld}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "search_articles",
		Description: "Search articles visible to the authenticated user. Returns at most 20 articles. Each article includes every translation, with its language, title, and preview. A language filter keeps articles that have that translation. Without one, the query matches every translation.",
		Annotations: readOnly,
	}, h.mcpSearchArticles)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_article",
		Description: "Read one article by id, including every translation, when the visibility rules allow it.",
		Annotations: readOnly,
	}, h.mcpGetArticle)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "create_article",
		Description: "Create a private draft article with one or more translations. Provide translations, or a single title and markdown. Owner and author are taken from the access token.",
		Annotations: write,
	}, h.mcpCreateArticle)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "update_article",
		Description: "Update tags or translations on an article the caller owns. A translation with a blank title and markdown removes that language.",
		Annotations: write,
	}, h.mcpUpdateArticle)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delete_article",
		Description: "Delete an article the caller owns, including every translation.",
		Annotations: remove,
	}, h.mcpDeleteArticle)
	h.registerMCPNewsletterTools(server, readOnly, write, remove)

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

type mcpTranslationInput struct {
	Language string `json:"language" jsonschema:"language code: en, fr, de, es, it, ja, or zh"`
	Title    string `json:"title" jsonschema:"title in this language. Blank title and markdown removes the translation on update"`
	Markdown string `json:"markdown" jsonschema:"markdown body in this language"`
}

type mcpTranslationOutput struct {
	Language string `json:"language" jsonschema:"language code"`
	Title    string `json:"title" jsonschema:"title in this language"`
	Markdown string `json:"markdown" jsonschema:"markdown in this language"`
}

type mcpPreparedTranslation struct {
	Language    model.LanguageCode
	Title       string
	Markdown    string
	ContentHTML string
	Remove      bool
}

type mcpListedTranslation struct {
	Language string `json:"language" jsonschema:"language code"`
	Title    string `json:"title" jsonschema:"title in this language"`
	Preview  string `json:"preview" jsonschema:"short plain-text preview in this language"`
}

type mcpArticleSummary struct {
	ID           string                 `json:"id" jsonschema:"article id"`
	Tags         []string               `json:"tags" jsonschema:"article tags"`
	Status       string                 `json:"status" jsonschema:"draft, published, or archived"`
	Translations []mcpListedTranslation `json:"translations" jsonschema:"every stored translation, one entry per language"`
	UpdatedAt    string                 `json:"updatedAt" jsonschema:"last update time in RFC3339"`
}

type mcpSearchArticlesOutput struct {
	Articles []mcpArticleSummary `json:"articles" jsonschema:"matching articles visible to the caller"`
}

type mcpGetArticleInput struct {
	ID       string `json:"id" jsonschema:"article id"`
	Language string `json:"language,omitempty" jsonschema:"optional language code such as en or fr"`
}

type mcpArticleDetail struct {
	ID                 string                 `json:"id" jsonschema:"article id"`
	Title              string                 `json:"title" jsonschema:"title in the selected language"`
	Markdown           string                 `json:"markdown" jsonschema:"markdown in the selected language"`
	Tags               []string               `json:"tags" jsonschema:"article tags"`
	Status             string                 `json:"status" jsonschema:"draft, published, or archived"`
	Language           string                 `json:"language" jsonschema:"language code of the selected translation"`
	AvailableLanguages []string               `json:"availableLanguages" jsonschema:"language codes that have content"`
	Translations       []mcpTranslationOutput `json:"translations" jsonschema:"every stored translation"`
	UpdatedAt          string                 `json:"updatedAt" jsonschema:"last update time in RFC3339"`
}

type mcpCreateArticleInput struct {
	Title        string                `json:"title,omitempty" jsonschema:"title used when translations is omitted"`
	Markdown     string                `json:"markdown,omitempty" jsonschema:"markdown used when translations is omitted"`
	Language     string                `json:"language,omitempty" jsonschema:"optional language code such as en or fr. Defaults to fr when translations is omitted"`
	Translations []mcpTranslationInput `json:"translations,omitempty" jsonschema:"one or more translations. Do not combine with title, markdown, or language"`
	Tags         []string              `json:"tags,omitempty" jsonschema:"optional tags"`
}

type mcpCreateArticleOutput struct {
	ID        string   `json:"id" jsonschema:"id of the created draft"`
	Title     string   `json:"title" jsonschema:"title of the preview translation"`
	Status    string   `json:"status" jsonschema:"always draft"`
	Public    bool     `json:"public" jsonschema:"always false; the draft is private to its owner"`
	Language  string   `json:"language" jsonschema:"language code of the preview translation"`
	Languages []string `json:"languages" jsonschema:"language codes stored on the draft"`
	Tags      []string `json:"tags" jsonschema:"article tags"`
}

type mcpUpdateArticleInput struct {
	ID           string                `json:"id" jsonschema:"article id"`
	Tags         *[]string             `json:"tags,omitempty" jsonschema:"optional tags. Replaces the tag list when provided"`
	Translations []mcpTranslationInput `json:"translations,omitempty" jsonschema:"translations to create, replace, or remove. A blank title and markdown removes that language"`
}

type mcpDeleteInput struct {
	ID string `json:"id" jsonschema:"document id"`
}

type mcpDeleteOutput struct {
	ID      string `json:"id" jsonschema:"deleted document id"`
	Deleted bool   `json:"deleted" jsonschema:"true when the document was deleted"`
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
		byLang := translations[article.ID]
		if _, ok := mcpSearchTranslation(article, byLang, language, query); !ok {
			continue
		}
		out.Articles = append(out.Articles, mcpArticleSummary{
			ID:           article.ID,
			Tags:         mcpStringList(article.Tags),
			Status:       string(article.Status),
			Translations: mcpListedTranslations(article, byLang),
			UpdatedAt:    article.UpdatedAt.UTC().Format(time.RFC3339),
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

	article, err := h.mcpVisibleArticle(ctx, user, id)
	if err != nil {
		return nil, out, err
	}
	translations, err := h.loadArticleTranslations(ctx, []string{article.ID})
	if err != nil {
		log.Printf("mcp get article: %v", err)
		return nil, out, fmt.Errorf("failed to fetch article")
	}
	detail, err := mcpArticleDetailFrom(article, translations[article.ID], language)
	if err != nil {
		return nil, out, err
	}
	return nil, detail, nil
}

func (h *Handler) mcpCreateArticle(ctx context.Context, _ *mcp.CallToolRequest, in mcpCreateArticleInput) (*mcp.CallToolResult, mcpCreateArticleOutput, error) {
	var out mcpCreateArticleOutput
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	prepared, err := mcpCreateTranslations(in)
	if err != nil {
		return nil, out, err
	}
	preview := mcpPreviewTranslation(prepared)
	article, _, err := newMCPDraftArticle(user, preview.Title, preview.Markdown, in.Tags, time.Now())
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
	for _, translation := range prepared {
		if err := h.upsertArticleTranslation(ctx, article.ID, translation.Language, article.Owner, translation.Title, translation.Markdown, translation.ContentHTML, article.UpdatedAt); err != nil {
			_, _ = h.articleTranslations.DeleteMany(ctx, bson.M{"articleId": article.ID})
			_, _ = h.articles.DeleteOne(ctx, bson.M{"_id": article.ID})
			log.Printf("mcp create article translation: %v", err)
			return nil, out, fmt.Errorf("failed to create article")
		}
	}

	out = mcpCreateArticleOutput{
		ID:        article.ID,
		Title:     preview.Title,
		Status:    string(article.Status),
		Public:    article.Public,
		Language:  string(preview.Language),
		Languages: mcpPreparedLanguages(prepared),
		Tags:      mcpStringList(article.Tags),
	}
	return nil, out, nil
}

func (h *Handler) mcpUpdateArticle(ctx context.Context, _ *mcp.CallToolRequest, in mcpUpdateArticleInput) (*mcp.CallToolResult, mcpArticleDetail, error) {
	var out mcpArticleDetail
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	id := strings.TrimSpace(in.ID)
	if id == "" {
		return nil, out, fmt.Errorf("id is required")
	}
	if in.Tags == nil && len(in.Translations) == 0 {
		return nil, out, fmt.Errorf("tags or translations are required")
	}
	var prepared []mcpPreparedTranslation
	if len(in.Translations) > 0 {
		prepared, err = prepareMCPTranslations(in.Translations, true)
		if err != nil {
			return nil, out, err
		}
	}
	if err := h.mcpArticlesReady(); err != nil {
		return nil, out, err
	}

	article, err := h.mcpVisibleArticle(ctx, user, id)
	if err != nil {
		return nil, out, err
	}
	if !mcpCallerOwns(user, article.Owner) {
		return nil, out, fmt.Errorf("only the owner can update this article")
	}
	caller := resolveOwnerEmail(user, "")
	if len(prepared) > 0 {
		existing, err := h.loadArticleTranslations(ctx, []string{article.ID})
		if err != nil {
			log.Printf("mcp update article: %v", err)
			return nil, out, fmt.Errorf("failed to update article")
		}
		if err := mcpTranslationWriteAllowed(existing[article.ID], prepared, caller); err != nil {
			return nil, out, err
		}
	}

	now := time.Now().UTC()
	for _, translation := range prepared {
		if translation.Remove {
			if err := h.deleteArticleTranslation(ctx, article.ID, translation.Language, caller); err != nil {
				if strings.Contains(err.Error(), "only the translation owner") {
					return nil, out, err
				}
				log.Printf("mcp update article translation: %v", err)
				return nil, out, fmt.Errorf("failed to update article")
			}
			continue
		}
		if err := h.upsertArticleTranslation(ctx, article.ID, translation.Language, caller, translation.Title, translation.Markdown, translation.ContentHTML, now); err != nil {
			if strings.Contains(err.Error(), "only the translation owner") {
				return nil, out, err
			}
			log.Printf("mcp update article translation: %v", err)
			return nil, out, fmt.Errorf("failed to update article")
		}
	}

	set := bson.M{"updatedAt": now}
	if in.Tags != nil {
		set["tags"] = normalizeArticleTags(*in.Tags)
	}
	if len(prepared) > 0 {
		fresh, err := h.loadArticleTranslations(ctx, []string{article.ID})
		if err != nil {
			log.Printf("mcp update article: %v", err)
			return nil, out, fmt.Errorf("failed to update article")
		}
		preview := ""
		if translation, ok := mcpTranslation(article, fresh[article.ID], ""); ok {
			preview = contentPreview(translation.Markdown, translation.ContentHTML, 3, 180)
		}
		set["preview"] = preview
	}
	if _, err := h.articles.UpdateByID(ctx, article.ID, bson.M{"$set": set, "$inc": bson.M{"version": 1}}); err != nil {
		log.Printf("mcp update article: %v", err)
		return nil, out, fmt.Errorf("failed to update article")
	}

	var updated model.Article
	if err := h.articles.FindOne(ctx, bson.M{"_id": article.ID}).Decode(&updated); err != nil {
		log.Printf("mcp update article: %v", err)
		return nil, out, fmt.Errorf("failed to update article")
	}
	translations, err := h.loadArticleTranslations(ctx, []string{updated.ID})
	if err != nil {
		log.Printf("mcp update article: %v", err)
		return nil, out, fmt.Errorf("failed to update article")
	}
	detail, err := mcpArticleDetailFrom(updated, translations[updated.ID], "")
	if err != nil {
		return nil, out, err
	}
	return nil, detail, nil
}

func (h *Handler) mcpDeleteArticle(ctx context.Context, _ *mcp.CallToolRequest, in mcpDeleteInput) (*mcp.CallToolResult, mcpDeleteOutput, error) {
	var out mcpDeleteOutput
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	id := strings.TrimSpace(in.ID)
	if id == "" {
		return nil, out, fmt.Errorf("id is required")
	}
	if err := h.mcpArticlesReady(); err != nil {
		return nil, out, err
	}
	article, err := h.mcpVisibleArticle(ctx, user, id)
	if err != nil {
		return nil, out, err
	}
	if !mcpCallerOwns(user, article.Owner) {
		return nil, out, fmt.Errorf("only the owner can delete this article")
	}
	result, err := h.articles.DeleteOne(ctx, bson.M{"_id": article.ID, "owner": article.Owner})
	if err != nil {
		log.Printf("mcp delete article: %v", err)
		return nil, out, fmt.Errorf("failed to delete article")
	}
	if result.DeletedCount == 0 {
		return nil, out, fmt.Errorf("article not found")
	}
	if _, err := h.articleTranslations.DeleteMany(ctx, bson.M{"articleId": article.ID}); err != nil {
		log.Printf("mcp delete article translations: %v", err)
		return nil, out, fmt.Errorf("failed to delete article")
	}
	return nil, mcpDeleteOutput{ID: article.ID, Deleted: true}, nil
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

func mcpCallerOwns(user *User, owner string) bool {
	caller := resolveOwnerEmail(user, "")
	return caller != "" && strings.EqualFold(strings.TrimSpace(owner), caller)
}

func (h *Handler) mcpVisibleArticle(ctx context.Context, user *User, id string) (model.Article, error) {
	var article model.Article
	err := h.articles.FindOne(ctx, mcpVisibleArticleByIDFilter(user, id)).Decode(&article)
	if err == mongo.ErrNoDocuments {
		return model.Article{}, fmt.Errorf("article not found")
	}
	if err != nil {
		log.Printf("mcp fetch article: %v", err)
		return model.Article{}, fmt.Errorf("failed to fetch article")
	}
	return article, nil
}

func mcpCreateTranslations(in mcpCreateArticleInput) ([]mcpPreparedTranslation, error) {
	legacy := strings.TrimSpace(in.Title) != "" || strings.TrimSpace(in.Markdown) != "" || strings.TrimSpace(in.Language) != ""
	if len(in.Translations) > 0 && legacy {
		return nil, fmt.Errorf("provide translations or title and markdown, not both")
	}
	if len(in.Translations) > 0 {
		return prepareMCPTranslations(in.Translations, false)
	}
	language, err := parseMCPLanguage(in.Language, model.LanguageFrench)
	if err != nil {
		return nil, err
	}
	return prepareMCPTranslations([]mcpTranslationInput{{
		Language: string(language),
		Title:    in.Title,
		Markdown: in.Markdown,
	}}, false)
}

func prepareMCPTranslations(inputs []mcpTranslationInput, allowRemove bool) ([]mcpPreparedTranslation, error) {
	if len(inputs) == 0 {
		return nil, fmt.Errorf("at least one translation is required")
	}
	seen := make(map[model.LanguageCode]struct{}, len(inputs))
	out := make([]mcpPreparedTranslation, 0, len(inputs))
	for _, in := range inputs {
		language, err := parseMCPLanguage(in.Language, "")
		if err != nil {
			return nil, err
		}
		if language == "" {
			return nil, fmt.Errorf("translation language is required")
		}
		if _, ok := seen[language]; ok {
			return nil, fmt.Errorf("duplicate language %q", language)
		}
		seen[language] = struct{}{}

		title := strings.TrimSpace(in.Title)
		if isBlankArticleTranslationInput(title, in.Markdown, "") {
			if !allowRemove {
				return nil, fmt.Errorf("title and markdown are required")
			}
			out = append(out, mcpPreparedTranslation{Language: language, Remove: true})
			continue
		}
		if title == "" {
			return nil, fmt.Errorf("title is required")
		}
		if strings.TrimSpace(in.Markdown) == "" {
			return nil, fmt.Errorf("markdown is required")
		}
		contentHTML, err := renderMarkdownToSafeHTML(in.Markdown)
		if err != nil {
			return nil, fmt.Errorf("failed to render markdown")
		}
		out = append(out, mcpPreparedTranslation{
			Language:    language,
			Title:       title,
			Markdown:    in.Markdown,
			ContentHTML: contentHTML,
		})
	}
	return out, nil
}

func mcpPreviewTranslation(items []mcpPreparedTranslation) mcpPreparedTranslation {
	for _, item := range items {
		if !item.Remove && item.Language == model.LanguageFrench {
			return item
		}
	}
	for _, item := range items {
		if !item.Remove {
			return item
		}
	}
	return mcpPreparedTranslation{}
}

func mcpPreparedLanguages(items []mcpPreparedTranslation) []string {
	present := make(map[model.LanguageCode]struct{}, len(items))
	for _, item := range items {
		if !item.Remove {
			present[item.Language] = struct{}{}
		}
	}
	out := make([]string, 0, len(present))
	for _, supported := range model.SupportedArticleLanguages {
		if _, ok := present[supported]; ok {
			out = append(out, string(supported))
		}
	}
	return mcpStringList(out)
}

func mcpTranslationWriteAllowed(existing map[model.LanguageCode]model.ArticleTranslation, prepared []mcpPreparedTranslation, caller string) error {
	caller = strings.TrimSpace(strings.ToLower(caller))
	for _, translation := range prepared {
		current, ok := existing[translation.Language]
		if !ok {
			continue
		}
		owner := strings.TrimSpace(strings.ToLower(current.Owner))
		if owner != "" && owner != caller {
			return fmt.Errorf("only the translation owner can update this translation")
		}
	}
	return nil
}

func mcpAvailableLanguages(byLang map[model.LanguageCode]model.ArticleTranslation) []string {
	if len(byLang) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(byLang))
	for _, supported := range model.SupportedArticleLanguages {
		translation, ok := byLang[supported]
		if !ok || isBlankArticleTranslation(translation) {
			continue
		}
		out = append(out, string(supported))
	}
	return out
}

func mcpListedTranslations(article model.Article, byLang map[model.LanguageCode]model.ArticleTranslation) []mcpListedTranslation {
	languages := mcpAvailableLanguages(byLang)
	if len(languages) == 0 {
		translation, ok := mcpTranslation(article, nil, "")
		if !ok {
			return []mcpListedTranslation{}
		}
		return []mcpListedTranslation{{
			Language: string(translation.Language),
			Title:    translation.Title,
			Preview:  contentPreview(translation.Markdown, translation.ContentHTML, 3, 180),
		}}
	}
	out := make([]mcpListedTranslation, 0, len(languages))
	for _, language := range languages {
		translation := byLang[model.LanguageCode(language)]
		out = append(out, mcpListedTranslation{
			Language: language,
			Title:    translation.Title,
			Preview:  contentPreview(translation.Markdown, translation.ContentHTML, 3, 180),
		})
	}
	return out
}

func mcpTranslationViews(byLang map[model.LanguageCode]model.ArticleTranslation) []mcpTranslationOutput {
	languages := mcpAvailableLanguages(byLang)
	if len(languages) == 0 {
		return []mcpTranslationOutput{}
	}
	out := make([]mcpTranslationOutput, 0, len(languages))
	for _, language := range languages {
		translation := byLang[model.LanguageCode(language)]
		out = append(out, mcpTranslationOutput{
			Language: language,
			Title:    translation.Title,
			Markdown: translation.Markdown,
		})
	}
	return out
}

func mcpArticleDetailFrom(article model.Article, byLang map[model.LanguageCode]model.ArticleTranslation, language model.LanguageCode) (mcpArticleDetail, error) {
	translation, ok := mcpTranslation(article, byLang, language)
	if !ok {
		if language != "" {
			return mcpArticleDetail{}, fmt.Errorf("article has no content in that language")
		}
		translation = model.ArticleTranslation{}
	}
	return mcpArticleDetail{
		ID:                 article.ID,
		Title:              translation.Title,
		Markdown:           translation.Markdown,
		Tags:               mcpStringList(article.Tags),
		Status:             string(article.Status),
		Language:           string(translation.Language),
		AvailableLanguages: mcpAvailableLanguages(byLang),
		Translations:       mcpTranslationViews(byLang),
		UpdatedAt:          article.UpdatedAt.UTC().Format(time.RFC3339),
	}, nil
}

func mcpSearchTranslation(article model.Article, byLang map[model.LanguageCode]model.ArticleTranslation, language model.LanguageCode, query string) (model.ArticleTranslation, bool) {
	if language != "" {
		translation, ok := mcpTranslation(article, byLang, language)
		if !ok || !mcpMatchesQuery(translation, article.Tags, query) {
			return model.ArticleTranslation{}, false
		}
		return translation, true
	}
	if !mcpMatchesAnyTranslation(article, byLang, article.Tags, query) {
		return model.ArticleTranslation{}, false
	}
	return mcpTranslation(article, byLang, "")
}

func mcpMatchesAnyTranslation(article model.Article, byLang map[model.LanguageCode]model.ArticleTranslation, tags []string, query string) bool {
	if strings.TrimSpace(query) == "" {
		return true
	}
	sawContent := false
	for _, supported := range model.SupportedArticleLanguages {
		translation, ok := byLang[supported]
		if !ok || isBlankArticleTranslation(translation) {
			continue
		}
		sawContent = true
		if mcpMatchesQuery(translation, nil, query) {
			return true
		}
	}
	if !sawContent {
		if translation, ok := mcpTranslation(article, nil, ""); ok && mcpMatchesQuery(translation, nil, query) {
			return true
		}
	}
	return mcpMatchesQuery(model.ArticleTranslation{}, tags, query)
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
