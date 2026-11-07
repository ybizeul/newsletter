package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"newsletter/api/internal/config"
	"newsletter/api/internal/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func TestMCPStoredTokenIsHashOnly(t *testing.T) {
	auth, _, endpoint := newMCPIsolation(t)
	user := &User{ID: "subject-a", Email: "A@Example.com", Name: "Ada"}

	id, raw := issueMCPToken(t, auth, user, "Claude Code")
	sum := sha256.Sum256([]byte(raw))
	wantHash := base64.RawURLEncoding.EncodeToString(sum[:])

	var stored bson.M
	if err := auth.mcpTokens.FindOne(context.Background(), bson.M{"_id": id}).Decode(&stored); err != nil {
		t.Fatalf("load stored token: %v", err)
	}
	if stored["tokenHash"] != wantHash {
		t.Fatalf("stored tokenHash = %#v, want SHA-256 digest %q", stored["tokenHash"], wantHash)
	}
	if stored["userID"] != user.ID {
		t.Fatalf("stored userID = %#v, want %q", stored["userID"], user.ID)
	}
	if stored["email"] != "a@example.com" {
		t.Fatalf("stored email = %#v, want lowercased owner email", stored["email"])
	}
	if _, ok := stored["token"]; ok {
		t.Fatal("stored token document has a plaintext token field")
	}
	encoded, err := bson.Marshal(stored)
	if err != nil {
		t.Fatalf("marshal stored token: %v", err)
	}
	if bytes.Contains(encoded, []byte(raw)) {
		t.Fatal("stored token document contains the plaintext token")
	}

	list := listMCPTokens(t, auth, user)
	if strings.Contains(list, raw) {
		t.Fatal("token list contains the plaintext token")
	}
	assertToolsList(t, postWithBearer(t, endpoint, raw, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
}

func TestRevokedAndExpiredMCPTokensFail(t *testing.T) {
	auth, _, endpoint := newMCPIsolation(t)
	user := &User{ID: "subject-a", Email: "a@example.com", Name: "Ada"}
	listBody := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`

	id, raw := issueMCPToken(t, auth, user, "laptop")
	assertToolsList(t, postWithBearer(t, endpoint, raw, listBody))
	revokeMCPToken(t, auth, user, id)
	assertMCPUnauthorized(t, postWithBearer(t, endpoint, raw, listBody), raw)

	expired := time.Now().Add(-time.Hour).UTC()
	expiredToken := insertMCPToken(t, auth.mcpTokens, user, nil, &expired)
	assertMCPUnauthorized(t, postWithBearer(t, endpoint, expiredToken, listBody), expiredToken)

	revokedAt := time.Now().Add(-time.Minute).UTC()
	future := time.Now().Add(time.Hour).UTC()
	revokedToken := insertMCPToken(t, auth.mcpTokens, user, &revokedAt, &future)
	assertMCPUnauthorized(t, postWithBearer(t, endpoint, revokedToken, listBody), revokedToken)

	validToken := insertMCPToken(t, auth.mcpTokens, user, nil, &future)
	assertToolsList(t, postWithBearer(t, endpoint, validToken, listBody))

	assertMCPUnauthorized(t, postWithBearer(t, endpoint, "nlmcp_unknown", listBody), "nlmcp_unknown")
}

func TestMCPTokenCannotReadAnotherUsersPrivateArticle(t *testing.T) {
	auth, handler, endpoint := newMCPIsolation(t)
	userA := &User{ID: "subject-a", Email: "A@Example.com", Name: "Ada"}
	userB := &User{ID: "subject-b", Email: "B@Example.com", Name: "Bea"}
	_, tokenA := issueMCPToken(t, auth, userA, "Ada")
	_, tokenB := issueMCPToken(t, auth, userB, "Bea")

	now := time.Now().UTC()
	insertArticle(t, handler.articles, model.Article{
		ID:        "b-private",
		AuthorID:  userB.ID,
		Owner:     "b@example.com",
		Public:    false,
		Title:     "B Private Launch",
		Markdown:  "b-only-secret-7f3a",
		Status:    model.ArticleStatusPublished,
		CreatedAt: now,
		UpdatedAt: now,
	})
	insertArticle(t, handler.articles, model.Article{
		ID:        "a-private",
		AuthorID:  userA.ID,
		Owner:     "a@example.com",
		Public:    false,
		Title:     "A Private Note",
		Markdown:  "a-only-secret",
		Status:    model.ArticleStatusPublished,
		CreatedAt: now.Add(-time.Minute),
		UpdatedAt: now.Add(-time.Minute),
	})
	insertArticle(t, handler.articles, model.Article{
		ID:        "public-shared",
		AuthorID:  userB.ID,
		Owner:     "b@example.com",
		Public:    true,
		Title:     "Shared Public Note",
		Markdown:  "shared-public-body",
		Status:    model.ArticleStatusPublished,
		CreatedAt: now.Add(-2 * time.Minute),
		UpdatedAt: now.Add(-2 * time.Minute),
	})
	if stored := storedArticle(t, handler.articles, "b-private"); stored["public"] != false || stored["owner"] != "b@example.com" {
		t.Fatalf("private fixture = %#v", stored)
	}

	denied := mcpToolsCall(t, endpoint, tokenA, "get_article", `{"id":"b-private"}`)
	assertToolError(t, denied, "article not found", "b-only-secret-7f3a")

	own := decodeTool[mcpArticleDetail](t, mcpToolsCall(t, endpoint, tokenA, "get_article", `{"id":"a-private"}`))
	if own.Markdown != "a-only-secret" {
		t.Fatalf("owner markdown = %q", own.Markdown)
	}
	shared := decodeTool[mcpArticleDetail](t, mcpToolsCall(t, endpoint, tokenA, "get_article", `{"id":"public-shared"}`))
	if shared.Markdown != "shared-public-body" {
		t.Fatalf("public markdown = %q", shared.Markdown)
	}
	otherOwner := decodeTool[mcpArticleDetail](t, mcpToolsCall(t, endpoint, tokenB, "get_article", `{"id":"b-private"}`))
	if otherOwner.Markdown != "b-only-secret-7f3a" {
		t.Fatalf("owner B markdown = %q", otherOwner.Markdown)
	}

	privateSearch := mcpToolsCall(t, endpoint, tokenA, "search_articles", `{"query":"private"}`)
	visible := articleIDs(t, privateSearch)
	if visible["b-private"] {
		t.Fatalf("search leaked the other user's private article: %#v", visible)
	}
	if !visible["a-private"] {
		t.Fatalf("search hid the caller's private article: %#v", visible)
	}
	allSearch := mcpToolsCall(t, endpoint, tokenA, "search_articles", `{}`)
	all := articleIDs(t, allSearch)
	if all["b-private"] || !all["a-private"] || !all["public-shared"] {
		t.Fatalf("visible ids = %#v", all)
	}
	for _, rec := range []*httptest.ResponseRecorder{denied, privateSearch, allSearch} {
		if strings.Contains(rec.Body.String(), "b-only-secret-7f3a") {
			t.Fatalf("response contains the other user's private markdown: %s", rec.Body.String())
		}
	}
}

func TestMCPCreateArticleIsPrivateDraftForTokenOwner(t *testing.T) {
	auth, handler, endpoint := newMCPIsolation(t)
	userA := &User{ID: "subject-a", Email: "A@Example.com", Name: "Ada"}
	userB := &User{ID: "subject-b", Email: "B@Example.com", Name: "Bea"}
	_, tokenA := issueMCPToken(t, auth, userA, "Ada")
	_, tokenB := issueMCPToken(t, auth, userB, "Bea")

	const markdown = "mcp-draft-secret-body"
	created := decodeTool[mcpCreateArticleOutput](t, mcpToolsCall(t, endpoint, tokenA, "create_article", `{"title":"Launch note","markdown":"`+markdown+`"}`))
	if created.ID == "" || created.Status != string(model.ArticleStatusDraft) || created.Public {
		t.Fatalf("create result = %#v, want a private draft id", created)
	}

	stored := storedArticle(t, handler.articles, created.ID)
	if _, ok := stored["public"]; !ok || stored["public"] != false {
		t.Fatalf("stored public = %#v, want false", stored["public"])
	}
	if stored["status"] != string(model.ArticleStatusDraft) {
		t.Fatalf("stored status = %#v, want draft", stored["status"])
	}
	if stored["owner"] != "a@example.com" {
		t.Fatalf("stored owner = %#v, want token email", stored["owner"])
	}
	if stored["authorId"] != userA.ID {
		t.Fatalf("stored authorId = %#v, want token subject", stored["authorId"])
	}

	var translation model.ArticleTranslation
	if err := handler.articleTranslations.FindOne(context.Background(), bson.M{"articleId": created.ID}).Decode(&translation); err != nil {
		t.Fatalf("load translation: %v", err)
	}
	if translation.Owner != "a@example.com" || translation.Markdown != markdown {
		t.Fatalf("translation = %#v", translation)
	}

	ownerView := decodeTool[mcpArticleDetail](t, mcpToolsCall(t, endpoint, tokenA, "get_article", `{"id":"`+created.ID+`"}`))
	if ownerView.Markdown != markdown {
		t.Fatalf("creator markdown = %q", ownerView.Markdown)
	}
	denied := mcpToolsCall(t, endpoint, tokenB, "get_article", `{"id":"`+created.ID+`"}`)
	assertToolError(t, denied, "article not found", markdown)
	if ids := articleIDs(t, mcpToolsCall(t, endpoint, tokenB, "search_articles", `{}`)); ids[created.ID] {
		t.Fatalf("other user search returned the private draft: %#v", ids)
	}
}

func newMCPIsolation(t *testing.T) (*OIDCAuth, *Handler, http.Handler) {
	t.Helper()
	database := isolationDatabase(t)
	auth := &OIDCAuth{enabled: true, mcpTokens: database.Collection("mcp_tokens")}
	handler := NewHandler(database, config.Config{}, "test")
	return auth, handler, handler.MCPEndpoint(auth)
}

func isolationDatabase(t *testing.T) *mongo.Database {
	t.Helper()
	uri := os.Getenv("MONGO_URI")
	required := uri != ""
	if uri == "" {
		uri = "mongodb://127.0.0.1:27017"
	}

	var client *mongo.Client
	var err error
	deadline := time.Now().Add(10 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		client, err = mongo.Connect(options.Client().ApplyURI(uri).SetServerSelectionTimeout(2 * time.Second))
		if err == nil {
			err = client.Ping(ctx, nil)
		}
		if err == nil {
			err = probeMongoWrite(ctx, client)
		}
		cancel()
		if err == nil {
			break
		}
		if client != nil {
			_ = client.Disconnect(context.Background())
			client = nil
		}
		var commandErr mongo.CommandError
		unauthorized := errors.As(err, &commandErr) && commandErr.HasErrorCode(13)
		if unauthorized || time.Now().After(deadline) {
			if required {
				t.Fatalf("MONGO_URI is set but MongoDB is not writable: %v", err)
			}
			t.Skipf("MongoDB is not writable at %s: %v", uri, err)
		}
		time.Sleep(300 * time.Millisecond)
	}

	database := client.Database("newsletter_mcp_isolation_" + bson.NewObjectID().Hex())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = database.Drop(ctx)
		_ = client.Disconnect(ctx)
	})
	return database
}

func probeMongoWrite(ctx context.Context, client *mongo.Client) error {
	database := client.Database("newsletter_mcp_isolation_probe_" + bson.NewObjectID().Hex())
	defer func() {
		dropCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = database.Drop(dropCtx)
	}()
	_, err := database.Collection("probe").InsertOne(ctx, bson.M{"_id": "ok"})
	return err
}

func issueMCPToken(t *testing.T, auth *OIDCAuth, user *User, label string) (id, raw string) {
	t.Helper()
	payload, err := json.Marshal(map[string]string{"label": label})
	if err != nil {
		t.Fatalf("encode token request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/mcp-tokens", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(contextWithUser(req.Context(), user))
	rec := httptest.NewRecorder()
	auth.CreateMCPToken(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create token status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create token: %v body=%s", err, rec.Body.String())
	}
	if created.ID == "" || !strings.HasPrefix(created.Token, mcpTokenPrefix) {
		t.Fatalf("created token = %#v", created)
	}
	return created.ID, created.Token
}

func listMCPTokens(t *testing.T, auth *OIDCAuth, user *User) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/mcp-tokens", nil)
	req = req.WithContext(contextWithUser(req.Context(), user))
	rec := httptest.NewRecorder()
	auth.ListMCPTokens(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list tokens status = %d, body = %s", rec.Code, rec.Body.String())
	}
	return rec.Body.String()
}

func revokeMCPToken(t *testing.T, auth *OIDCAuth, user *User, id string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, "/api/mcp-tokens/"+id, nil)
	req = req.WithContext(contextWithUser(req.Context(), user))
	rec := httptest.NewRecorder()
	auth.RevokeMCPToken(rec, req, id)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke token status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func insertMCPToken(t *testing.T, coll *mongo.Collection, user *User, revokedAt, expiresAt *time.Time) string {
	t.Helper()
	raw, hash, err := newMCPToken()
	if err != nil {
		t.Fatalf("newMCPToken() error = %v", err)
	}
	_, err = coll.InsertOne(context.Background(), mcpTokenDoc{
		ID:        bson.NewObjectID().Hex(),
		TokenHash: hash,
		UserID:    user.ID,
		Email:     strings.ToLower(strings.TrimSpace(user.Email)),
		Name:      user.Name,
		Label:     "inserted",
		TokenHint: raw[:len(mcpTokenPrefix)+8],
		CreatedAt: time.Now().UTC(),
		RevokedAt: revokedAt,
		ExpiresAt: expiresAt,
	})
	if err != nil {
		t.Fatalf("insert token: %v", err)
	}
	return raw
}

func insertArticle(t *testing.T, coll *mongo.Collection, article model.Article) {
	t.Helper()
	if _, err := coll.InsertOne(context.Background(), article); err != nil {
		t.Fatalf("insert article %s: %v", article.ID, err)
	}
}

func storedArticle(t *testing.T, coll *mongo.Collection, id string) bson.M {
	t.Helper()
	var doc bson.M
	if err := coll.FindOne(context.Background(), bson.M{"_id": id}).Decode(&doc); err != nil {
		t.Fatalf("load article %s: %v", id, err)
	}
	return doc
}

func mcpToolsCall(t *testing.T, handler http.Handler, token, name, args string) *httptest.ResponseRecorder {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `}}`
	return postWithBearer(t, handler, token, body)
}

func assertMCPUnauthorized(t *testing.T, rec *httptest.ResponseRecorder, secret string) {
	t.Helper()
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401, body = %s", rec.Code, rec.Body.String())
	}
	if secret != "" && strings.Contains(rec.Body.String(), secret) {
		t.Fatal("unauthorized response contains the bearer token")
	}
}

func assertToolsList(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "search_articles") {
		t.Fatalf("tools/list status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func assertToolError(t *testing.T, rec *httptest.ResponseRecorder, want string, forbidden ...string) {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode mcp response: %v body=%s", err, rec.Body.String())
	}
	text := ""
	if payload.Error != nil {
		text = payload.Error.Message
	}
	for _, item := range payload.Result.Content {
		text += item.Text
	}
	if payload.Error == nil && !payload.Result.IsError {
		t.Fatalf("tool succeeded, body = %s", rec.Body.String())
	}
	if !strings.Contains(text, want) && !strings.Contains(rec.Body.String(), want) {
		t.Fatalf("tool error = %q, want %q, body = %s", text, want, rec.Body.String())
	}
	for _, secret := range forbidden {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatalf("tool error contains %q: %s", secret, rec.Body.String())
		}
	}
}

func decodeTool[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			StructuredContent T `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode mcp response: %v body=%s", err, rec.Body.String())
	}
	if payload.Result.IsError {
		text := ""
		if len(payload.Result.Content) > 0 {
			text = payload.Result.Content[0].Text
		}
		t.Fatalf("tool error: %s body=%s", text, rec.Body.String())
	}
	return payload.Result.StructuredContent
}

func articleIDs(t *testing.T, rec *httptest.ResponseRecorder) map[string]bool {
	t.Helper()
	out := decodeTool[mcpSearchArticlesOutput](t, rec)
	ids := make(map[string]bool, len(out.Articles))
	for _, article := range out.Articles {
		ids[article.ID] = true
	}
	return ids
}
