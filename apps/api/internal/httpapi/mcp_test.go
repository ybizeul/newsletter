package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"newsletter/api/internal/model"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestNewMCPDraftArticleIsPrivateDraft(t *testing.T) {
	user := &User{ID: "subject-a", Email: "A@Example.com", Name: "A"}
	article, html, err := newMCPDraftArticle(user, "  Launch note  ", "Hello from Claude", []string{"News", "news"}, time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("newMCPDraftArticle() error = %v", err)
	}
	if article.Public {
		t.Fatal("MCP draft is public")
	}
	if article.Status != model.ArticleStatusDraft {
		t.Fatalf("status = %q, want draft", article.Status)
	}
	if article.Owner != "a@example.com" {
		t.Fatalf("owner = %q, want lowercased token email", article.Owner)
	}
	if article.AuthorID != "subject-a" {
		t.Fatalf("authorId = %q, want token subject", article.AuthorID)
	}
	if len(article.Tags) != 1 || article.Tags[0] != "News" {
		t.Fatalf("tags = %#v, want deduped [News]", article.Tags)
	}
	if article.Preview == "" {
		t.Fatal("preview is empty")
	}
	if !strings.Contains(html, "Hello from Claude") {
		t.Fatalf("rendered html = %q, want the markdown text", html)
	}
	if strings.Contains(strings.ToLower(html), "<script") {
		t.Fatalf("rendered html kept a script tag: %s", html)
	}
}

func TestNewMCPDraftArticleSanitizesMarkdown(t *testing.T) {
	user := &User{ID: "subject-a", Email: "a@example.com"}
	_, html, err := newMCPDraftArticle(user, "Unsafe", "Hello <script>alert(1)</script>", nil, time.Now())
	if err != nil {
		t.Fatalf("newMCPDraftArticle() error = %v", err)
	}
	if strings.Contains(strings.ToLower(html), "<script") || strings.Contains(html, "alert(1)") {
		t.Fatalf("sanitizer left script content in html: %s", html)
	}
	if !strings.Contains(html, "Hello") {
		t.Fatalf("sanitizer removed the article text: %s", html)
	}
}

func TestNewMCPDraftArticleRejectsIncompleteInput(t *testing.T) {
	user := &User{ID: "subject-a", Email: "a@example.com"}
	for _, test := range []struct {
		title, markdown string
	}{
		{"", "body"},
		{"   ", "body"},
		{"Title", ""},
		{"Title", "  \n"},
	} {
		if _, _, err := newMCPDraftArticle(user, test.title, test.markdown, nil, time.Now()); err == nil {
			t.Fatalf("newMCPDraftArticle(%q, %q) succeeded", test.title, test.markdown)
		}
	}
	if _, _, err := newMCPDraftArticle(&User{ID: "subject-a"}, "Title", "body", nil, time.Now()); err == nil {
		t.Fatal("draft without an owner email succeeded")
	}
}

func TestMCPVisibleArticleFilterScopesToCaller(t *testing.T) {
	userA := &User{ID: "a", Email: "A@Example.com"}
	filter := mcpVisibleArticleByIDFilter(userA, "article-1")
	raw, err := bson.Marshal(filter)
	if err != nil {
		t.Fatalf("marshal filter: %v", err)
	}
	if filter["_id"] != "article-1" {
		t.Fatalf("id filter = %#v", filter["_id"])
	}
	if !bytes.Contains(raw, []byte("a@example.com")) {
		t.Fatal("visibility filter does not include the caller email")
	}
	if bytes.Contains(raw, []byte("b@example.com")) {
		t.Fatal("visibility filter includes another user's email")
	}
	if !bytes.Contains(raw, []byte("public")) {
		t.Fatal("visibility filter does not include the public rule")
	}

	search := mcpVisibleArticleFilter(userA, model.ArticleStatusDraft)
	searchRaw, err := bson.Marshal(search)
	if err != nil {
		t.Fatalf("marshal search filter: %v", err)
	}
	if !bytes.Contains(searchRaw, []byte("a@example.com")) || !bytes.Contains(searchRaw, []byte("draft")) {
		t.Fatal("search filter lost the caller or status constraint")
	}
}

func TestParseMCPFilters(t *testing.T) {
	if _, err := parseMCPStatus("nope"); err == nil {
		t.Fatal("invalid status was accepted")
	}
	status, err := parseMCPStatus(" Draft ")
	if err != nil || status != model.ArticleStatusDraft {
		t.Fatalf("parseMCPStatus() = %q, %v", status, err)
	}
	if _, err := parseMCPLanguage("english", ""); err == nil {
		t.Fatal("invalid language was accepted")
	}
	language, err := parseMCPLanguage("", model.LanguageFrench)
	if err != nil || language != model.LanguageFrench {
		t.Fatalf("parseMCPLanguage() = %q, %v", language, err)
	}
	language, err = parseMCPLanguage("EN", "")
	if err != nil || language != model.LanguageEnglish {
		t.Fatalf("parseMCPLanguage(EN) = %q, %v", language, err)
	}
}

func TestMCPTranslationAndQueryMatch(t *testing.T) {
	article := model.Article{Title: "Legacy title", Markdown: "legacy body"}
	byLang := map[model.LanguageCode]model.ArticleTranslation{
		model.LanguageEnglish: {Language: model.LanguageEnglish, Title: "Hello", Markdown: "revenue grew"},
	}
	if _, ok := mcpTranslation(article, byLang, model.LanguageFrench); ok {
		t.Fatal("missing french translation was accepted")
	}
	got, ok := mcpTranslation(article, byLang, "")
	if !ok || got.Title != "Hello" || got.Language != model.LanguageEnglish {
		t.Fatalf("default translation = %#v, ok=%t", got, ok)
	}
	if !mcpMatchesQuery(got, []string{"Finance"}, "revenue") {
		t.Fatal("query did not match markdown")
	}
	if !mcpMatchesQuery(got, []string{"Finance"}, "fin") {
		t.Fatal("query did not match a tag")
	}
	if mcpMatchesQuery(got, []string{"Finance"}, "absent") {
		t.Fatal("unrelated query matched")
	}
	if !mcpHasTag([]string{"Finance"}, "finance") {
		t.Fatal("tag comparison is case-sensitive")
	}
	if mcpHasTag([]string{"Finance"}, "news") {
		t.Fatal("unrelated tag matched")
	}
	byLang[model.LanguageFrench] = model.ArticleTranslation{Language: model.LanguageFrench, Title: "Bonjour", Markdown: "chiffre d'affaires"}
	if !mcpMatchesAnyTranslation(article, byLang, nil, "chiffre") {
		t.Fatal("query did not match a translation other than the displayed language")
	}
	if mcpMatchesAnyTranslation(article, byLang, nil, "absent") {
		t.Fatal("unrelated query matched a translation")
	}
}

func TestMCPCreateTranslations(t *testing.T) {
	legacy, err := mcpCreateTranslations(mcpCreateArticleInput{Title: "  Hello ", Markdown: "Body", Language: "EN"})
	if err != nil {
		t.Fatalf("legacy create: %v", err)
	}
	if len(legacy) != 1 || legacy[0].Language != model.LanguageEnglish || legacy[0].Title != "Hello" {
		t.Fatalf("legacy translations = %#v", legacy)
	}
	if strings.Contains(strings.ToLower(legacy[0].ContentHTML), "<script") {
		t.Fatal("legacy translation was not rendered")
	}

	multi, err := mcpCreateTranslations(mcpCreateArticleInput{Translations: []mcpTranslationInput{
		{Language: "en", Title: "Hello", Markdown: "English body"},
		{Language: "fr", Title: "Bonjour", Markdown: "Corps français"},
	}})
	if err != nil {
		t.Fatalf("multi create: %v", err)
	}
	preview := mcpPreviewTranslation(multi)
	if preview.Language != model.LanguageFrench || preview.Title != "Bonjour" {
		t.Fatalf("preview = %#v, want the french translation", preview)
	}
	languages := mcpPreparedLanguages(multi)
	if len(languages) != 2 || languages[0] != "en" || languages[1] != "fr" {
		t.Fatalf("languages = %#v", languages)
	}

	if _, err := mcpCreateTranslations(mcpCreateArticleInput{
		Title:        "Hello",
		Markdown:     "Body",
		Translations: []mcpTranslationInput{{Language: "fr", Title: "Bonjour", Markdown: "Corps"}},
	}); err == nil || !strings.Contains(err.Error(), "not both") {
		t.Fatalf("both shapes error = %v", err)
	}
	if _, err := mcpCreateTranslations(mcpCreateArticleInput{Translations: []mcpTranslationInput{
		{Language: "en", Title: "One", Markdown: "A"},
		{Language: "EN", Title: "Two", Markdown: "B"},
	}}); err == nil || !strings.Contains(err.Error(), "duplicate language") {
		t.Fatalf("duplicate language error = %v", err)
	}
	if _, err := mcpCreateTranslations(mcpCreateArticleInput{Translations: []mcpTranslationInput{
		{Language: "english", Title: "Hello", Markdown: "Body"},
	}}); err == nil {
		t.Fatal("unsupported language was accepted")
	}
	if _, err := mcpCreateTranslations(mcpCreateArticleInput{Translations: []mcpTranslationInput{
		{Language: "en", Title: " ", Markdown: "  "},
	}}); err == nil {
		t.Fatal("blank create translation was accepted")
	}

	removed, err := prepareMCPTranslations([]mcpTranslationInput{{Language: "de", Title: " ", Markdown: ""}}, true)
	if err != nil || len(removed) != 1 || !removed[0].Remove || removed[0].Language != model.LanguageGerman {
		t.Fatalf("remove translation = %#v, err = %v", removed, err)
	}
}

func TestMCPVisibleNewsletterFilterScopesToCaller(t *testing.T) {
	userA := &User{ID: "a", Email: "A@Example.com"}
	filter := mcpVisibleNewsletterByIDFilter(userA, "newsletter-1")
	raw, err := bson.Marshal(filter)
	if err != nil {
		t.Fatalf("marshal filter: %v", err)
	}
	if filter["_id"] != "newsletter-1" {
		t.Fatalf("id filter = %#v", filter["_id"])
	}
	if !bytes.Contains(raw, []byte("a@example.com")) {
		t.Fatal("visibility filter does not include the caller email")
	}
	if bytes.Contains(raw, []byte("b@example.com")) {
		t.Fatal("visibility filter includes another user's email")
	}
	if bytes.Contains(raw, []byte("public")) {
		t.Fatal("newsletter visibility filter includes a public rule")
	}

	search := mcpVisibleNewsletterFilter(userA, model.NewsletterStatusDraft)
	searchRaw, err := bson.Marshal(search)
	if err != nil {
		t.Fatalf("marshal search filter: %v", err)
	}
	if !bytes.Contains(searchRaw, []byte("a@example.com")) || !bytes.Contains(searchRaw, []byte("draft")) {
		t.Fatal("search filter lost the caller or status constraint")
	}
}

func TestNewMCPDraftNewsletterIsPrivateDraft(t *testing.T) {
	user := &User{ID: "subject-a", Email: "A@Example.com", Name: "A"}
	newsletter, err := newMCPDraftNewsletter(user, mcpCreateNewsletterInput{
		Title:           "  November  ",
		IntroMarkdown:   "Hello <script>alert(1)</script>",
		ArticleIDs:      []string{" a ", "a", "b"},
		ContactTags:     []string{"Customers", "customers"},
		ContactTagsMode: "all",
		RecipientIDs:    []string{"Ada <Ada@Example.com>"},
		IncludeIndex:    true,
	}, time.Date(2026, 11, 2, 8, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("newMCPDraftNewsletter() error = %v", err)
	}
	if newsletter.PublicLink || newsletter.Status != model.NewsletterStatusDraft {
		t.Fatalf("newsletter = %#v, want a private draft", newsletter)
	}
	if newsletter.Owner != "a@example.com" || newsletter.CreatorID != "subject-a" {
		t.Fatalf("owner = %q creator = %q", newsletter.Owner, newsletter.CreatorID)
	}
	if newsletter.Title != "November" || newsletter.Language != model.LanguageFrench || newsletter.Template != defaultNewsletterTemplateName {
		t.Fatalf("title/language/template = %q %q %q", newsletter.Title, newsletter.Language, newsletter.Template)
	}
	if newsletter.IncludeIndex != true || len(newsletter.ArticleIDs) != 2 || newsletter.ArticleIDs[0] != "a" || newsletter.ArticleIDs[1] != "b" {
		t.Fatalf("articles = %#v includeIndex=%t", newsletter.ArticleIDs, newsletter.IncludeIndex)
	}
	if len(newsletter.ContactTags) != 1 || newsletter.ContactTagsMode != "all" {
		t.Fatalf("tags = %#v mode=%q", newsletter.ContactTags, newsletter.ContactTagsMode)
	}
	if strings.Contains(strings.ToLower(newsletter.IntroHTML), "<script") || strings.Contains(newsletter.IntroHTML, "alert(1)") {
		t.Fatalf("intro html kept script content: %s", newsletter.IntroHTML)
	}
	if !strings.Contains(newsletter.IntroHTML, "Hello") {
		t.Fatalf("intro html dropped the text: %s", newsletter.IntroHTML)
	}

	if _, err := newMCPDraftNewsletter(user, mcpCreateNewsletterInput{Title: " "}, time.Now()); err == nil {
		t.Fatal("blank title was accepted")
	}
	if _, err := newMCPDraftNewsletter(&User{ID: "subject-a"}, mcpCreateNewsletterInput{Title: "November"}, time.Now()); err == nil {
		t.Fatal("draft without an owner email succeeded")
	}
	if _, err := newMCPDraftNewsletter(user, mcpCreateNewsletterInput{Title: "November", Template: "missing"}, time.Now()); err == nil {
		t.Fatal("unknown template was accepted")
	}
	if _, err := newMCPDraftNewsletter(user, mcpCreateNewsletterInput{Title: "November", RecipientIDs: []string{"not-an-email"}}, time.Now()); err == nil {
		t.Fatal("invalid recipient was accepted")
	}
	if _, err := parseMCPNewsletterStatus("nope"); err == nil {
		t.Fatal("invalid newsletter status was accepted")
	}
	if _, err := parseMCPContactTagsMode("or"); err == nil {
		t.Fatal("invalid contact tag mode was accepted")
	}

	updated, err := applyMCPNewsletterUpdate(newsletter, mcpUpdateNewsletterInput{Title: "December", Language: stringPtr("en")}, time.Now())
	if err != nil {
		t.Fatalf("applyMCPNewsletterUpdate() error = %v", err)
	}
	if updated.Title != "December" || updated.Language != model.LanguageEnglish || updated.IntroMarkdown != newsletter.IntroMarkdown {
		t.Fatalf("partial update = %#v", updated)
	}
}

func stringPtr(value string) *string {
	return &value
}

func TestMCPRateLimiterHidesToken(t *testing.T) {
	secret := "nlmcp_supersecretvalue"
	limiter := newMCPRateLimiter(1, time.Minute)
	var calls int
	handler := limiter.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))

	first := postWithBearer(t, handler, secret, "")
	if first.Code != http.StatusNoContent {
		t.Fatalf("first status = %d, want 204", first.Code)
	}
	second := postWithBearer(t, handler, secret, "")
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second status = %d, want 429", second.Code)
	}
	if strings.Contains(second.Body.String(), secret) {
		t.Fatal("rate-limit response contains the bearer token")
	}
	if calls != 1 {
		t.Fatalf("handler calls = %d, want 1", calls)
	}
}

func TestStripCredentialQuery(t *testing.T) {
	secret := "nlmcp_querysecret"
	var seen string
	handler := StripCredentialQuery(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.RequestURI
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/mcp?token="+secret+"&q=ok", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if strings.Contains(seen, secret) {
		t.Fatalf("request URI still contains the token: %s", seen)
	}
	if !strings.Contains(seen, "q=ok") {
		t.Fatalf("request URI dropped an unrelated query: %s", seen)
	}
}

func TestMCPEndpointRequiresBearerAndIgnoresQueryToken(t *testing.T) {
	endpoint := (&Handler{}).MCPEndpoint(&OIDCAuth{})
	secret := "nlmcp_querysecret"

	noHeader := httptest.NewRequest(http.MethodPost, "/mcp?token="+secret, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	noHeader.Header.Set("Content-Type", "application/json")
	noHeader.Header.Set("Accept", "application/json, text/event-stream")
	rec := httptest.NewRecorder()
	endpoint.ServeHTTP(rec, noHeader)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Fatal("unauthorized response contains the query token")
	}

	get := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	get.Header.Set("Authorization", "Bearer "+secret)
	getRec := httptest.NewRecorder()
	endpoint.ServeHTTP(getRec, get)
	if getRec.Code != http.StatusUnauthorized {
		t.Fatalf("GET status = %d, want 401 while OIDC is disabled", getRec.Code)
	}
}

func TestMCPToolsAreStatelessAndUseTheRequestUser(t *testing.T) {
	handler := (&Handler{appVersion: "test"}).mcpStreamHandler()
	withUser := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := contextWithUser(r.Context(), &User{ID: "subject-a", Email: "a@example.com", Name: "A"})
		handler.ServeHTTP(w, r.WithContext(ctx))
	})

	list := postMCP(t, handler, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if list.Code != http.StatusOK {
		t.Fatalf("tools/list status = %d body=%s", list.Code, list.Body.String())
	}
	if ct := list.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("content type = %q, want application/json", ct)
	}
	if session := list.Header().Get("Mcp-Session-Id"); session != "" {
		t.Fatalf("stateless response set Mcp-Session-Id %q", session)
	}
	if strings.HasPrefix(strings.TrimSpace(list.Body.String()), "event:") {
		t.Fatalf("stateless response used an event stream: %s", list.Body.String())
	}

	var listed struct {
		Result struct {
			Tools []struct {
				Name        string         `json:"name"`
				InputSchema map[string]any `json:"inputSchema"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode tools/list: %v body=%s", err, list.Body.String())
	}
	tools := map[string]map[string]any{}
	for _, tool := range listed.Result.Tools {
		props, _ := tool.InputSchema["properties"].(map[string]any)
		tools[tool.Name] = props
	}
	for _, name := range []string{
		"search_articles", "get_article", "create_article", "update_article", "delete_article",
		"search_newsletters", "get_newsletter", "create_newsletter", "update_newsletter", "delete_newsletter",
	} {
		if _, ok := tools[name]; !ok {
			t.Fatalf("missing tool %s in %#v", name, tools)
		}
	}
	for _, required := range []string{"title", "markdown", "translations"} {
		if _, ok := tools["create_article"][required]; !ok {
			t.Fatalf("create_article schema = %#v", tools["create_article"])
		}
	}
	for _, name := range []string{"query", "tag", "status", "language"} {
		if _, ok := tools["search_articles"][name]; !ok {
			t.Fatalf("search_articles schema = %#v", tools["search_articles"])
		}
	}
	for _, name := range []string{"id", "tags", "translations"} {
		if _, ok := tools["update_article"][name]; !ok {
			t.Fatalf("update_article schema = %#v", tools["update_article"])
		}
	}
	for _, name := range []string{"title", "language", "template", "introMarkdown", "footerMarkdown", "articleIds"} {
		if _, ok := tools["create_newsletter"][name]; !ok {
			t.Fatalf("create_newsletter schema = %#v", tools["create_newsletter"])
		}
	}
	for _, forbidden := range []string{"owner", "authorId", "author", "public", "status"} {
		if _, ok := tools["create_article"][forbidden]; ok {
			t.Fatalf("create_article accepts %s from the model", forbidden)
		}
		if _, ok := tools["update_article"][forbidden]; ok {
			t.Fatalf("update_article accepts %s from the model", forbidden)
		}
	}
	for _, forbidden := range []string{"owner", "creatorId", "publicLink", "status"} {
		if _, ok := tools["create_newsletter"][forbidden]; ok {
			t.Fatalf("create_newsletter accepts %s from the model", forbidden)
		}
		if _, ok := tools["update_newsletter"][forbidden]; ok {
			t.Fatalf("update_newsletter accepts %s from the model", forbidden)
		}
	}

	anonymous := postMCP(t, handler, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_articles","arguments":{}}}`)
	if !strings.Contains(anonymous.Body.String(), "not authenticated") {
		t.Fatalf("anonymous search body = %s", anonymous.Body.String())
	}

	for _, call := range []struct {
		id   int
		name string
		args string
		want string
	}{
		{3, "search_articles", `{}`, "article store unavailable"},
		{4, "get_article", `{"id":"article-1"}`, "article store unavailable"},
		{5, "create_article", `{"title":"Draft","markdown":"Hello"}`, "article store unavailable"},
		{7, "update_article", `{"id":"article-1","tags":["News"]}`, "article store unavailable"},
		{8, "delete_article", `{"id":"article-1"}`, "article store unavailable"},
		{9, "search_newsletters", `{}`, "newsletter store unavailable"},
		{10, "get_newsletter", `{"id":"newsletter-1"}`, "newsletter store unavailable"},
		{11, "create_newsletter", `{"title":"November"}`, "newsletter store unavailable"},
		{12, "update_newsletter", `{"id":"newsletter-1","title":"November"}`, "newsletter store unavailable"},
		{13, "delete_newsletter", `{"id":"newsletter-1"}`, "newsletter store unavailable"},
	} {
		body := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, call.id, call.name, call.args)
		authed := postMCP(t, withUser, body)
		if !strings.Contains(authed.Body.String(), call.want) {
			t.Fatalf("%s body = %s", call.name, authed.Body.String())
		}
	}

	bothShapes := postMCP(t, withUser, `{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"create_article","arguments":{"title":"Draft","markdown":"Hello","translations":[{"language":"en","title":"Draft","markdown":"Hello"}]}}}`)
	if !strings.Contains(bothShapes.Body.String(), "provide translations or title and markdown, not both") {
		t.Fatalf("create_article accepted both shapes: %s", bothShapes.Body.String())
	}
	missingChange := postMCP(t, withUser, `{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"update_article","arguments":{"id":"article-1"}}}`)
	if !strings.Contains(missingChange.Body.String(), "tags or translations are required") {
		t.Fatalf("update_article accepted an empty change: %s", missingChange.Body.String())
	}

	rejected := postMCP(t, withUser, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"create_article","arguments":{"title":"Draft","markdown":"Hello","owner":"other@example.com","public":true,"authorId":"someone-else"}}}`)
	if !strings.Contains(rejected.Body.String(), "unexpected additional properties") {
		t.Fatalf("create_article accepted ownership arguments: %s", rejected.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	getReq.Header.Set("Accept", "application/json, text/event-stream")
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", getRec.Code)
	}
}

func postMCP(t *testing.T, handler http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	return postWithBearer(t, handler, "", body)
}

func postWithBearer(t *testing.T, handler http.Handler, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}
