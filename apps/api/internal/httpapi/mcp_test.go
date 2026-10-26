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
	for _, name := range []string{"search_articles", "get_article", "create_article"} {
		if _, ok := tools[name]; !ok {
			t.Fatalf("missing tool %s in %#v", name, tools)
		}
	}
	for _, required := range []string{"title", "markdown"} {
		if _, ok := tools["create_article"][required]; !ok {
			t.Fatalf("create_article schema = %#v", tools["create_article"])
		}
	}
	for _, name := range []string{"query", "tag", "status", "language"} {
		if _, ok := tools["search_articles"][name]; !ok {
			t.Fatalf("search_articles schema = %#v", tools["search_articles"])
		}
	}
	for _, forbidden := range []string{"owner", "authorId", "author", "public"} {
		if _, ok := tools["create_article"][forbidden]; ok {
			t.Fatalf("create_article accepts %s from the model", forbidden)
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
	}{
		{3, "search_articles", `{}`},
		{4, "get_article", `{"id":"article-1"}`},
		{5, "create_article", `{"title":"Draft","markdown":"Hello"}`},
	} {
		body := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, call.id, call.name, call.args)
		authed := postMCP(t, withUser, body)
		if !strings.Contains(authed.Body.String(), "article store unavailable") {
			t.Fatalf("%s body = %s", call.name, authed.Body.String())
		}
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
