package httpapi

import (
	"bytes"
	"context"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	htmltemplate "html/template"
	"image"
	"image/png"
	"io/fs"
	"log"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"newsletter/api/internal/config"
	"newsletter/api/internal/model"

	"github.com/microcosm-cc/bluemonday"
	"github.com/srwiley/oksvg"
	"github.com/srwiley/rasterx"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	gmhtml "github.com/yuin/goldmark/renderer/html"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type Handler struct {
	articles            *mongo.Collection
	articleTranslations *mongo.Collection
	headers             *mongo.Collection
	newsletters         *mongo.Collection
	contacts            *mongo.Collection
	userPrefs           *mongo.Collection
	cfg                 config.Config
	appVersion          string
}

var errNewsletterAlreadySending = errors.New("newsletter is already sending")
var errTokenExpired = errors.New("access token expired")

const maxNewsletterRecipients = 3

const defaultNewsletterTemplateName = "default"

func NewHandler(db *mongo.Database, cfg config.Config, appVersion string) *Handler {
	return &Handler{
		articles:            db.Collection("articles"),
		articleTranslations: db.Collection("article_translations"),
		headers:             db.Collection("headers"),
		newsletters:         db.Collection("newsletters"),
		contacts:            db.Collection("contacts"),
		userPrefs:           db.Collection("user_preferences"),
		cfg:                 cfg,
		appVersion:          strings.TrimSpace(appVersion),
	}
}

type createArticleRequest struct {
	AuthorID        string   `json:"authorId"`
	Public          *bool    `json:"public"`
	Language        string   `json:"language"`
	Title           string   `json:"title"`
	Markdown        string   `json:"markdown"`
	ContentHTML     string   `json:"contentHTML"`
	Tags            []string `json:"tags"`
	TopicIcon       string   `json:"topicIcon"`
	Illustration    string   `json:"illustration"`
	IconSource      string   `json:"iconSource"`
	IconZoom        int      `json:"iconZoom"`
	IconBgColor     string   `json:"iconBgColor"`
	IconStrokeColor string   `json:"iconStrokeColor"`
}

type articleSummary struct {
	ID                 string               `json:"id"`
	Owner              string               `json:"owner,omitempty"`
	Public             bool                 `json:"public"`
	AvailableLanguages []model.LanguageCode `json:"availableLanguages,omitempty"`
	Title              string               `json:"title"`
	Tags               []string             `json:"tags,omitempty"`
	TopicIcon          string               `json:"topicIcon,omitempty"`
	Illustration       string               `json:"illustration,omitempty"`
	SentCount          int64                `json:"sentCount"`
	LastUsed           *time.Time           `json:"lastUsed,omitempty"`
	Status             model.ArticleStatus  `json:"status"`
	CreatedAt          time.Time            `json:"createdAt"`
	UpdatedAt          time.Time            `json:"updatedAt"`
	Preview            string               `json:"preview"`
}

type articleSummarySource struct {
	ID           string              `bson:"_id"`
	Owner        string              `bson:"owner,omitempty"`
	Public       *bool               `bson:"public,omitempty"`
	Title        string              `bson:"title"`
	Tags         []string            `bson:"tags,omitempty"`
	TopicIcon    string              `bson:"topicIcon,omitempty"`
	Illustration string              `bson:"illustration,omitempty"`
	SentCount    int64               `bson:"sentCount"`
	LastUsed     *time.Time          `bson:"last_used,omitempty"`
	Preview      string              `bson:"preview,omitempty"`
	Status       model.ArticleStatus `bson:"status"`
	CreatedAt    time.Time           `bson:"createdAt"`
	UpdatedAt    time.Time           `bson:"updatedAt"`
}

func (h *Handler) CreateArticle(w http.ResponseWriter, r *http.Request) {
	var req createArticleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	if u := UserFromContext(r.Context()); u != nil {
		req.AuthorID = u.ID
	}
	owner := resolveOwnerEmail(UserFromContext(r.Context()), req.AuthorID)
	if req.AuthorID == "" || req.Title == "" {
		h.writeError(w, http.StatusBadRequest, "authorId and title are required")
		return
	}
	language := normalizeArticleLanguage(req.Language, model.LanguageFrench)

	isPublic := true
	if req.Public != nil {
		isPublic = *req.Public
	}

	now := time.Now().UTC()
	article := model.Article{
		ID:              bson.NewObjectID().Hex(),
		AuthorID:        req.AuthorID,
		Owner:           owner,
		Public:          isPublic,
		Tags:            normalizeArticleTags(req.Tags),
		TopicIcon:       req.TopicIcon,
		Illustration:    req.Illustration,
		IconSource:      strings.TrimSpace(req.IconSource),
		IconZoom:        normalizeIconZoom(req.IconZoom),
		IconBgColor:     strings.TrimSpace(req.IconBgColor),
		IconStrokeColor: strings.TrimSpace(req.IconStrokeColor),
		SentCount:       0,
		Preview:         contentPreview(req.Markdown, req.ContentHTML, 3, 180),
		Status:          model.ArticleStatusDraft,
		Version:         1,
		CreatedAt:       now,
		UpdatedAt:       now,
	}

	if _, err := h.articles.InsertOne(r.Context(), article); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to create article")
		return
	}
	if err := h.upsertArticleTranslation(r.Context(), article.ID, language, req.Title, req.Markdown, req.ContentHTML, now); err != nil {
		_, _ = h.articles.DeleteOne(r.Context(), bson.M{"_id": article.ID})
		h.writeError(w, http.StatusInternalServerError, "failed to create article translation")
		return
	}
	article.Title = strings.TrimSpace(req.Title)
	article.Markdown = req.Markdown
	article.ContentHTML = req.ContentHTML
	article.AvailableLangs = []model.LanguageCode{language}

	h.writeJSON(w, http.StatusCreated, article)
}

func (h *Handler) ListArticles(w http.ResponseWriter, r *http.Request) {
	findOptions := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})
	view := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("view")))
	preferredLanguage := normalizeArticleLanguage(r.URL.Query().Get("language"), "")
	visibilityFilter := articleVisibilityFilter(UserFromContext(r.Context()))

	cursor, err := h.articles.Find(r.Context(), visibilityFilter, findOptions)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to list articles")
		return
	}
	defer cursor.Close(r.Context())

	var articles []model.Article
	if err := cursor.All(r.Context(), &articles); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to decode articles")
		return
	}
	if articles == nil {
		articles = []model.Article{}
	}
	for i := range articles {
		if strings.TrimSpace(articles[i].Owner) == "" {
			// Legacy records may not have an explicit visibility flag; treat as public until claimed.
			articles[i].Public = true
		}
	}
	if err := h.applyArticleTranslations(r.Context(), articles, preferredLanguage, false); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to hydrate article translations")
		return
	}

	if view != "full" {
		items := make([]articleSummary, 0, len(articles))
		for _, article := range articles {
			items = append(items, articleSummary{
				ID:                 article.ID,
				Owner:              article.Owner,
				Public:             article.Public,
				AvailableLanguages: article.AvailableLangs,
				Title:              article.Title,
				Tags:               article.Tags,
				TopicIcon:          article.TopicIcon,
				Illustration:       article.Illustration,
				SentCount:          article.SentCount,
				LastUsed:           article.LastUsed,
				Status:             article.Status,
				CreatedAt:          article.CreatedAt,
				UpdatedAt:          article.UpdatedAt,
				Preview:            contentPreview(article.Markdown, article.ContentHTML, 3, 180),
			})
		}
		h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
		return
	}

	h.writeJSON(w, http.StatusOK, map[string]any{"items": articles})
}

func (h *Handler) GetArticle(w http.ResponseWriter, r *http.Request, id string) {
	var article model.Article
	filter := bson.M{"_id": id, "$and": []bson.M{articleVisibilityFilter(UserFromContext(r.Context()))}}
	if err := h.articles.FindOne(r.Context(), filter).Decode(&article); err != nil {
		if err == mongo.ErrNoDocuments {
			h.writeError(w, http.StatusNotFound, "article not found")
			return
		}
		h.writeError(w, http.StatusInternalServerError, "failed to fetch article")
		return
	}
	if strings.TrimSpace(article.Owner) == "" {
		// Legacy records may not have an explicit visibility flag; treat as public until claimed.
		article.Public = true
	}
	preferredLanguage := normalizeArticleLanguage(r.URL.Query().Get("language"), "")
	items := []model.Article{article}
	if err := h.applyArticleTranslations(r.Context(), items, preferredLanguage, true); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to hydrate article translation")
		return
	}
	article = items[0]

	h.writeJSON(w, http.StatusOK, article)
}

func (h *Handler) ClaimArticle(w http.ResponseWriter, r *http.Request, id string) {
	owner := resolveOwnerEmail(UserFromContext(r.Context()), "")
	if owner == "" {
		h.writeError(w, http.StatusBadRequest, "missing user email")
		return
	}

	now := time.Now().UTC()
	claimFilter := bson.M{
		"_id": id,
		"$or": []bson.M{
			{"owner": bson.M{"$exists": false}},
			{"owner": ""},
		},
	}

	result, err := h.articles.UpdateOne(r.Context(), claimFilter, bson.M{
		"$set": bson.M{
			"owner":     owner,
			"public":    true,
			"updatedAt": now,
		},
	})
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to claim article")
		return
	}

	var article model.Article
	if err := h.articles.FindOne(r.Context(), bson.M{"_id": id}).Decode(&article); err != nil {
		if err == mongo.ErrNoDocuments {
			h.writeError(w, http.StatusNotFound, "article not found")
			return
		}
		h.writeError(w, http.StatusInternalServerError, "failed to fetch article")
		return
	}

	if result.MatchedCount == 0 && strings.TrimSpace(strings.ToLower(article.Owner)) != owner {
		h.writeError(w, http.StatusConflict, "article already claimed")
		return
	}
	items := []model.Article{article}
	if err := h.applyArticleTranslations(r.Context(), items, "", false); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to hydrate article translation")
		return
	}
	article = items[0]

	h.writeJSON(w, http.StatusOK, article)
}

type updateArticleRequest struct {
	Public          *bool    `json:"public"`
	Language        string   `json:"language"`
	Title           string   `json:"title"`
	Markdown        string   `json:"markdown"`
	ContentHTML     string   `json:"contentHTML"`
	Tags            []string `json:"tags"`
	TopicIcon       string   `json:"topicIcon"`
	Illustration    string   `json:"illustration"`
	IconSource      string   `json:"iconSource"`
	IconZoom        int      `json:"iconZoom"`
	IconBgColor     string   `json:"iconBgColor"`
	IconStrokeColor string   `json:"iconStrokeColor"`
}

func (h *Handler) UpdateArticle(w http.ResponseWriter, r *http.Request, id string) {
	var req updateArticleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	var existing model.Article
	if err := h.articles.FindOne(r.Context(), bson.M{"_id": id}).Decode(&existing); err != nil {
		if err == mongo.ErrNoDocuments {
			h.writeError(w, http.StatusNotFound, "article not found")
			return
		}
		h.writeError(w, http.StatusInternalServerError, "failed to load article")
		return
	}

	if req.Title == "" {
		h.writeError(w, http.StatusBadRequest, "title is required")
		return
	}

	currentOwner := strings.TrimSpace(strings.ToLower(existing.Owner))
	requester := resolveOwnerEmail(UserFromContext(r.Context()), existing.AuthorID)
	if currentOwner != "" && currentOwner != requester {
		h.writeError(w, http.StatusForbidden, "only the owner can update this article")
		return
	}
	if currentOwner == "" && UserFromContext(r.Context()) != nil {
		h.writeError(w, http.StatusForbidden, "claim the article before saving changes")
		return
	}

	if req.Public != nil {
		if currentOwner != "" && currentOwner != requester {
			h.writeError(w, http.StatusForbidden, "only the owner can change article visibility")
			return
		}
	}
	language := normalizeArticleLanguage(req.Language, model.LanguageFrench)
	now := time.Now().UTC()

	setFields := bson.M{
		"preview":         contentPreview(req.Markdown, req.ContentHTML, 3, 180),
		"tags":            normalizeArticleTags(req.Tags),
		"topicIcon":       strings.TrimSpace(req.TopicIcon),
		"illustration":    strings.TrimSpace(req.Illustration),
		"iconSource":      strings.TrimSpace(req.IconSource),
		"iconZoom":        normalizeIconZoom(req.IconZoom),
		"iconBgColor":     strings.TrimSpace(req.IconBgColor),
		"iconStrokeColor": strings.TrimSpace(req.IconStrokeColor),
		"updatedAt":       now,
	}
	if req.Public != nil {
		currentVisibility := existing.Public
		if currentOwner == "" {
			// Legacy unowned articles are effectively public even when the field is absent.
			currentVisibility = true
		}
		setFields["public"] = *req.Public
		if currentOwner == "" && requester != "" && currentVisibility != *req.Public {
			setFields["owner"] = requester
		}
	}

	update := bson.M{
		"$set": setFields,
		"$inc": bson.M{"version": 1},
	}

	result, err := h.articles.UpdateByID(r.Context(), id, update)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to update article")
		return
	}
	if result.MatchedCount == 0 {
		h.writeError(w, http.StatusNotFound, "article not found")
		return
	}
	if err := h.upsertArticleTranslation(r.Context(), id, language, req.Title, req.Markdown, req.ContentHTML, now); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to update article translation")
		return
	}

	var article model.Article
	if err := h.articles.FindOne(r.Context(), bson.M{"_id": id}).Decode(&article); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to fetch updated article")
		return
	}
	items := []model.Article{article}
	if err := h.applyArticleTranslations(r.Context(), items, language, true); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to hydrate updated article translation")
		return
	}

	h.writeJSON(w, http.StatusOK, items[0])
}

func normalizeArticleTags(tags []string) []string {
	if len(tags) == 0 {
		return []string{}
	}

	normalized := make([]string, 0, len(tags))
	seen := make(map[string]struct{}, len(tags))
	for _, raw := range tags {
		tag := strings.TrimSpace(raw)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		normalized = append(normalized, tag)
	}

	return normalized
}

func normalizeIconZoom(value int) int {
	if value < -100 {
		return -100
	}
	if value > 100 {
		return 100
	}
	return value
}

func normalizeContactTags(tags []string) []string {
	if len(tags) == 0 {
		return nil
	}
	normalized := make([]string, 0, len(tags))
	seen := make(map[string]struct{}, len(tags))
	for _, raw := range tags {
		tag := strings.ToLower(strings.TrimSpace(raw))
		if tag == "" {
			continue
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		normalized = append(normalized, tag)
	}
	if len(normalized) == 0 {
		return nil
	}
	return normalized
}

func normalizeContactTagsMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "all":
		return "all"
	default:
		return "any"
	}
}

// resolveContactRecipients returns deduplicated email addresses for contacts
// matching the given tags. mode "all" requires every tag; "any" requires at least one.
// resolveContactRecipients returns contacts scoped to the given owner whose
// tags match. mode "all" requires every tag; "any" requires at least one.
func (h *Handler) resolveContactRecipients(ctx context.Context, owner string, tags []string, mode string) ([]model.Contact, error) {
	normalized := normalizeContactTags(tags)
	if len(normalized) == 0 {
		return nil, nil
	}

	// normalizeContactTags already lowercases tags at write time, so this
	// query uses the same casing that is stored in the database.
	var tagFilter bson.M
	if mode == "all" {
		tagFilter = bson.M{"tags": bson.M{"$all": normalized}}
	} else {
		tagFilter = bson.M{"tags": bson.M{"$in": normalized}}
	}

	filter := tagFilter
	if owner != "" {
		filter = bson.M{"$and": []bson.M{tagFilter, {"owner": owner}}}
	}

	cursor, err := h.contacts.Find(ctx, filter)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var contacts []model.Contact
	if err := cursor.All(ctx, &contacts); err != nil {
		return nil, err
	}

	// Deduplicate by email (keep first occurrence).
	seen := make(map[string]struct{}, len(contacts))
	deduped := contacts[:0]
	for _, c := range contacts {
		key := strings.ToLower(strings.TrimSpace(c.Email))
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		deduped = append(deduped, c)
	}
	return deduped, nil
}

// applyRenderedSubstitutions replaces #FIRST_NAME and #LAST_NAME in already-rendered
// content. htmlEscape must be true for HTML output to avoid injecting markup.
func applyRenderedSubstitutions(content string, contact model.Contact, htmlEscape bool) string {
	firstName, lastName := contact.FirstName, contact.LastName
	if htmlEscape {
		firstName = html.EscapeString(firstName)
		lastName = html.EscapeString(lastName)
	}
	content = strings.ReplaceAll(content, "#FIRST_NAME", firstName)
	content = strings.ReplaceAll(content, "#LAST_NAME", lastName)
	return content
}

// ---- Contacts handlers ----

type contactRequest struct {
	FirstName string   `json:"firstName"`
	LastName  string   `json:"lastName"`
	Email     string   `json:"email"`
	Tags      []string `json:"tags"`
}

type bulkImportContactsRequest struct {
	Contacts []contactRequest `json:"contacts"`
}

func (h *Handler) CreateContact(w http.ResponseWriter, r *http.Request) {
	var req contactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	email := strings.TrimSpace(strings.ToLower(req.Email))
	if email == "" {
		h.writeError(w, http.StatusBadRequest, "email is required")
		return
	}
	if _, err := mail.ParseAddress(email); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid email address")
		return
	}

	owner := resolveOwnerEmail(UserFromContext(r.Context()), "")
	now := time.Now().UTC()
	contact := model.Contact{
		ID:        bson.NewObjectID().Hex(),
		Owner:     owner,
		FirstName: strings.TrimSpace(req.FirstName),
		LastName:  strings.TrimSpace(req.LastName),
		Email:     email,
		Tags:      normalizeContactTags(req.Tags),
		CreatedAt: now,
		UpdatedAt: now,
	}

	if _, err := h.contacts.InsertOne(r.Context(), contact); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			h.writeError(w, http.StatusConflict, "a contact with this email already exists")
			return
		}
		h.writeError(w, http.StatusInternalServerError, "failed to create contact")
		return
	}

	h.writeJSON(w, http.StatusCreated, contact)
}

func (h *Handler) ListContacts(w http.ResponseWriter, r *http.Request) {
	owner := resolveOwnerEmail(UserFromContext(r.Context()), "")
	filter := contactOwnerFilter(owner)
	cursor, err := h.contacts.Find(r.Context(), filter, options.Find().SetSort(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}}))
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to list contacts")
		return
	}
	defer cursor.Close(r.Context())

	var contacts []model.Contact
	if err := cursor.All(r.Context(), &contacts); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to decode contacts")
		return
	}
	if contacts == nil {
		contacts = []model.Contact{}
	}

	h.writeJSON(w, http.StatusOK, map[string]any{"items": contacts})
}

func (h *Handler) UpdateContact(w http.ResponseWriter, r *http.Request, id string) {
	var req contactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	email := strings.TrimSpace(strings.ToLower(req.Email))
	if email == "" {
		h.writeError(w, http.StatusBadRequest, "email is required")
		return
	}
	if _, err := mail.ParseAddress(email); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid email address")
		return
	}

	owner := resolveOwnerEmail(UserFromContext(r.Context()), "")
	filter := bson.M{"_id": id}
	if owner != "" {
		filter["owner"] = owner
	}

	result, err := h.contacts.UpdateOne(r.Context(), filter, bson.M{
		"$set": bson.M{
			"firstName": strings.TrimSpace(req.FirstName),
			"lastName":  strings.TrimSpace(req.LastName),
			"email":     email,
			"tags":      normalizeContactTags(req.Tags),
			"updatedAt": time.Now().UTC(),
		},
	})
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to update contact")
		return
	}
	if result.MatchedCount == 0 {
		h.writeError(w, http.StatusNotFound, "contact not found")
		return
	}

	var contact model.Contact
	if err := h.contacts.FindOne(r.Context(), bson.M{"_id": id}).Decode(&contact); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to fetch updated contact")
		return
	}

	h.writeJSON(w, http.StatusOK, contact)
}

func (h *Handler) DeleteContact(w http.ResponseWriter, r *http.Request, id string) {
	owner := resolveOwnerEmail(UserFromContext(r.Context()), "")
	filter := bson.M{"_id": id}
	if owner != "" {
		filter["owner"] = owner
	}

	result, err := h.contacts.DeleteOne(r.Context(), filter)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to delete contact")
		return
	}
	if result.DeletedCount == 0 {
		h.writeError(w, http.StatusNotFound, "contact not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// BulkImportContacts upserts contacts by email. New contacts are inserted;
// existing ones (matched by email) are updated with the provided fields.
func (h *Handler) BulkImportContacts(w http.ResponseWriter, r *http.Request) {
	var req bulkImportContactsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	if len(req.Contacts) == 0 {
		h.writeJSON(w, http.StatusOK, map[string]any{"imported": 0, "skipped": 0})
		return
	}

	owner := resolveOwnerEmail(UserFromContext(r.Context()), "")
	now := time.Now().UTC()
	imported := 0
	skipped := 0

	for _, c := range req.Contacts {
		email := strings.TrimSpace(strings.ToLower(c.Email))
		if email == "" {
			skipped++
			continue
		}
		if _, err := mail.ParseAddress(email); err != nil {
			skipped++
			continue
		}

		// Upsert scoped to this owner so different users can have the same contact email.
		filter := bson.M{"email": email, "owner": owner}
		setOnInsert := bson.M{
			"_id":       bson.NewObjectID().Hex(),
			"owner":     owner,
			"createdAt": now,
		}
		update := bson.M{
			"$set": bson.M{
				"firstName": strings.TrimSpace(c.FirstName),
				"lastName":  strings.TrimSpace(c.LastName),
				"email":     email,
				"tags":      normalizeContactTags(c.Tags),
				"updatedAt": now,
			},
			"$setOnInsert": setOnInsert,
		}

		opts := options.UpdateOne().SetUpsert(true)
		if _, err := h.contacts.UpdateOne(r.Context(), filter, update, opts); err != nil {
			skipped++
			continue
		}
		imported++
	}

	h.writeJSON(w, http.StatusOK, map[string]any{"imported": imported, "skipped": skipped})
}

func normalizeRecipientIDs(recipientIDs []string) ([]string, error) {
	if len(recipientIDs) == 0 {
		return []string{}, nil
	}

	normalized := make([]string, 0, len(recipientIDs))
	seen := make(map[string]struct{}, len(recipientIDs))
	for _, raw := range recipientIDs {
		recipient := strings.TrimSpace(raw)
		if recipient == "" {
			continue
		}

		// Validate as a plain email address or "First Last <email>" format.
		parsed, err := mail.ParseAddress(recipient)
		if err != nil {
			return nil, fmt.Errorf("invalid recipient address %q", recipient)
		}

		// Deduplicate by parsed email address (case-insensitive).
		key := strings.ToLower(parsed.Address)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		normalized = append(normalized, recipient)
	}

	if len(normalized) > maxNewsletterRecipients {
		return nil, fmt.Errorf("a maximum of %d recipients is allowed", maxNewsletterRecipients)
	}

	return normalized, nil
}

func markdownPreviewText(input string, maxLines int, maxChars int) string {
	plain := input
	plain = regexp.MustCompile("```[\\s\\S]*?```").ReplaceAllString(plain, " ")
	plain = regexp.MustCompile("`[^`]*`").ReplaceAllString(plain, " ")
	plain = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`).ReplaceAllString(plain, " ")
	plain = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`).ReplaceAllString(plain, "$1")
	plain = regexp.MustCompile(`<[^>]+>`).ReplaceAllString(plain, " ")
	plain = regexp.MustCompile(`(?m)^[\t ]{0,3}#{1,6}[\t ]+`).ReplaceAllString(plain, "")
	plain = regexp.MustCompile(`(?m)^[\t ]{0,3}>[\t ]?`).ReplaceAllString(plain, "")
	plain = regexp.MustCompile(`(?m)^[\t ]*[-*+][\t ]+`).ReplaceAllString(plain, "")
	plain = regexp.MustCompile(`(?m)^[\t ]*\d+\.[\t ]+`).ReplaceAllString(plain, "")
	plain = regexp.MustCompile(`[\*_~]`).ReplaceAllString(plain, "")
	plain = strings.ReplaceAll(plain, "\r", "")

	lines := strings.Split(plain, "\n")
	normalized := make([]string, 0, maxLines)
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		trimmed = strings.Join(strings.Fields(trimmed), " ")
		normalized = append(normalized, trimmed)
		if len(normalized) >= maxLines {
			break
		}
	}

	joined := strings.Join(normalized, " ")
	if len(joined) <= maxChars {
		return joined
	}
	return strings.TrimSpace(joined[:maxChars]) + "..."
}

func (h *Handler) DeleteArticle(w http.ResponseWriter, r *http.Request, id string) {
	filter := bson.M{"_id": id, "$and": []bson.M{articleVisibilityFilter(UserFromContext(r.Context()))}}
	result, err := h.articles.DeleteOne(r.Context(), filter)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to delete article")
		return
	}
	if result.DeletedCount == 0 {
		h.writeError(w, http.StatusNotFound, "article not found")
		return
	}
	if _, err := h.articleTranslations.DeleteMany(r.Context(), bson.M{"articleId": id}); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to delete article translations")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

type createHeaderRequest struct {
	CreatorID string `json:"creatorId"`
	Title     string `json:"title"`
	Markdown  string `json:"markdown"`
}

type updateHeaderRequest struct {
	Title    string `json:"title"`
	Markdown string `json:"markdown"`
}

func (h *Handler) CreateHeader(w http.ResponseWriter, r *http.Request) {
	var req createHeaderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	if u := UserFromContext(r.Context()); u != nil {
		req.CreatorID = u.ID
	}
	if strings.TrimSpace(req.CreatorID) == "" || strings.TrimSpace(req.Title) == "" {
		h.writeError(w, http.StatusBadRequest, "creatorId and title are required")
		return
	}

	owner := resolveOwnerEmail(UserFromContext(r.Context()), req.CreatorID)
	now := time.Now().UTC()
	header := model.Header{
		ID:        bson.NewObjectID().Hex(),
		CreatorID: strings.TrimSpace(req.CreatorID),
		Owner:     owner,
		Title:     strings.TrimSpace(req.Title),
		Markdown:  req.Markdown,
		Status:    model.HeaderStatusDraft,
		Version:   1,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if _, err := h.headers.InsertOne(r.Context(), header); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to create header")
		return
	}

	h.writeJSON(w, http.StatusCreated, header)
}

func (h *Handler) ListHeaders(w http.ResponseWriter, r *http.Request) {
	cursor, err := h.headers.Find(r.Context(), headerOwnerFilter(UserFromContext(r.Context())))
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to list headers")
		return
	}
	defer cursor.Close(r.Context())

	var headers []model.Header
	if err := cursor.All(r.Context(), &headers); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to decode headers")
		return
	}
	if headers == nil {
		headers = []model.Header{}
	}

	sort.Slice(headers, func(i, j int) bool {
		return headers[i].CreatedAt.After(headers[j].CreatedAt)
	})

	h.writeJSON(w, http.StatusOK, map[string]any{"items": headers})
}

func (h *Handler) UpdateHeader(w http.ResponseWriter, r *http.Request, id string) {
	var req updateHeaderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	if strings.TrimSpace(req.Title) == "" {
		h.writeError(w, http.StatusBadRequest, "title is required")
		return
	}

	update := bson.M{
		"$set": bson.M{
			"title":     strings.TrimSpace(req.Title),
			"markdown":  req.Markdown,
			"updatedAt": time.Now().UTC(),
		},
		"$inc": bson.M{"version": 1},
	}

	ownerFilter := headerOwnerFilter(UserFromContext(r.Context()))
	ownerFilter["_id"] = id
	result, err := h.headers.UpdateOne(r.Context(), ownerFilter, update)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to update header")
		return
	}
	if result.MatchedCount == 0 {
		h.writeError(w, http.StatusNotFound, "header not found")
		return
	}

	var header model.Header
	if err := h.headers.FindOne(r.Context(), bson.M{"_id": id}).Decode(&header); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to fetch updated header")
		return
	}

	h.writeJSON(w, http.StatusOK, header)
}

func (h *Handler) DeleteHeader(w http.ResponseWriter, r *http.Request, id string) {
	delFilter := headerOwnerFilter(UserFromContext(r.Context()))
	delFilter["_id"] = id
	result, err := h.headers.DeleteOne(r.Context(), delFilter)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to delete header")
		return
	}
	if result.DeletedCount == 0 {
		h.writeError(w, http.StatusNotFound, "header not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

type createNewsletterRequest struct {
	CreatorID       string   `json:"creatorId"`
	Title           string   `json:"title"`
	Template        string   `json:"template"`
	HeaderID        string   `json:"headerId"`
	IntroMarkdown   string   `json:"introMarkdown"`
	IntroHTML       string   `json:"introHTML"`
	FooterMarkdown  string   `json:"footerMarkdown"`
	FooterHTML      string   `json:"footerHTML"`
	IncludeIndex    bool     `json:"includeIndex"`
	ArticleIDs      []string `json:"articleIds"`
	RecipientIDs    []string `json:"recipientIds"`
	ContactTags     []string `json:"contactTags"`
	ContactTagsMode string   `json:"contactTagsMode"`
}

type updateNewsletterRequest struct {
	Title           string   `json:"title"`
	Template        string   `json:"template"`
	HeaderID        string   `json:"headerId"`
	IntroMarkdown   string   `json:"introMarkdown"`
	IntroHTML       string   `json:"introHTML"`
	FooterMarkdown  string   `json:"footerMarkdown"`
	FooterHTML      string   `json:"footerHTML"`
	IncludeIndex    bool     `json:"includeIndex"`
	ContentWidth    int      `json:"contentWidth"`
	Archived        bool     `json:"archived"`
	ArticleIDs      []string `json:"articleIds"`
	RecipientIDs    []string `json:"recipientIds"`
	ContactTags     []string `json:"contactTags"`
	ContactTagsMode string   `json:"contactTagsMode"`
}

func (h *Handler) CreateNewsletter(w http.ResponseWriter, r *http.Request) {
	var req createNewsletterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	if u := UserFromContext(r.Context()); u != nil {
		req.CreatorID = u.ID
	}
	owner := resolveOwnerEmail(UserFromContext(r.Context()), req.CreatorID)
	if req.CreatorID == "" || req.Title == "" {
		h.writeError(w, http.StatusBadRequest, "creatorId and title are required")
		return
	}

	recipientIDs, err := normalizeRecipientIDs(req.RecipientIDs)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	templateName, err := validateNewsletterTemplateName(req.Template)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	now := time.Now().UTC()
	newsletter := model.Newsletter{
		ID:              bson.NewObjectID().Hex(),
		CreatorID:       req.CreatorID,
		Owner:           owner,
		Title:           req.Title,
		Template:        templateName,
		HeaderID:        strings.TrimSpace(req.HeaderID),
		IntroMarkdown:   req.IntroMarkdown,
		IntroHTML:       req.IntroHTML,
		FooterMarkdown:  req.FooterMarkdown,
		FooterHTML:      req.FooterHTML,
		IncludeIndex:    req.IncludeIndex,
		ArticleIDs:      req.ArticleIDs,
		RecipientIDs:    recipientIDs,
		ContactTags:     normalizeContactTags(req.ContactTags),
		ContactTagsMode: normalizeContactTagsMode(req.ContactTagsMode),
		IsFavorite:      false,
		Status:          model.NewsletterStatusDraft,
		CreatedAt:       now,
		UpdatedAt:       now,
	}

	if _, err := h.newsletters.InsertOne(r.Context(), newsletter); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to create newsletter")
		return
	}

	newsletter.Template = normalizeNewsletterTemplateName(newsletter.Template)
	h.writeJSON(w, http.StatusCreated, newsletter)
}

func (h *Handler) ListNewsletterTemplates(w http.ResponseWriter, r *http.Request) {
	h.writeJSON(w, http.StatusOK, map[string]any{"items": listNewsletterTemplateNames()})
}

func (h *Handler) ListNewsletters(w http.ResponseWriter, r *http.Request) {
	findOptions := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})
	visibilityFilter := newsletterVisibilityFilter(UserFromContext(r.Context()))

	if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("view")), "summary") {
		findOptions.SetProjection(bson.M{
			"owner":          1,
			"title":          1,
			"template":       1,
			"headerId":       1,
			"introMarkdown":  1,
			"introHTML":      1,
			"footerMarkdown": 1,
			"footerHTML":     1,
			"includeIndex":   1,
			"articleIds":     1,
			"recipientIds":   1,
			"isFavorite":     1,
			"archived":       1,
			"status":         1,
			"deliveryError":  1,
			"scheduledAt":    1,
			"sentAt":         1,
			"createdAt":      1,
			"updatedAt":      1,
		})

		type newsletterSummarySource struct {
			ID             string                 `bson:"_id"`
			Owner          string                 `bson:"owner,omitempty"`
			Title          string                 `bson:"title"`
			Template       string                 `bson:"template,omitempty"`
			HeaderID       string                 `bson:"headerId,omitempty"`
			IntroMarkdown  string                 `bson:"introMarkdown"`
			IntroHTML      string                 `bson:"introHTML,omitempty"`
			FooterMarkdown string                 `bson:"footerMarkdown"`
			FooterHTML     string                 `bson:"footerHTML,omitempty"`
			IncludeIndex   bool                   `bson:"includeIndex"`
			ArticleIDs     []string               `bson:"articleIds"`
			RecipientIDs   []string               `bson:"recipientIds"`
			IsFavorite     bool                   `bson:"isFavorite"`
			Archived       bool                   `bson:"archived"`
			Status         model.NewsletterStatus `bson:"status"`
			DeliveryError  string                 `bson:"deliveryError,omitempty"`
			ScheduledAt    *time.Time             `bson:"scheduledAt,omitempty"`
			SentAt         *time.Time             `bson:"sentAt,omitempty"`
			CreatedAt      time.Time              `bson:"createdAt"`
			UpdatedAt      time.Time              `bson:"updatedAt"`
		}

		type newsletterSummary struct {
			ID            string                 `json:"id"`
			Owner         string                 `json:"owner,omitempty"`
			Title         string                 `json:"title"`
			Template      string                 `json:"template,omitempty"`
			HeaderID      string                 `json:"headerId,omitempty"`
			IncludeIndex  bool                   `json:"includeIndex"`
			ArticleIDs    []string               `json:"articleIds"`
			RecipientIDs  []string               `json:"recipientIds"`
			IsFavorite    bool                   `json:"isFavorite"`
			Archived      bool                   `json:"archived"`
			Status        model.NewsletterStatus `json:"status"`
			DeliveryError string                 `json:"deliveryError,omitempty"`
			ScheduledAt   *time.Time             `json:"scheduledAt,omitempty"`
			SentAt        *time.Time             `json:"sentAt,omitempty"`
			CreatedAt     time.Time              `json:"createdAt"`
			UpdatedAt     time.Time              `json:"updatedAt"`
			Preview       string                 `json:"preview"`
		}

		cursor, err := h.newsletters.Find(r.Context(), visibilityFilter, findOptions)
		if err != nil {
			h.writeError(w, http.StatusInternalServerError, "failed to list newsletters")
			return
		}
		defer cursor.Close(r.Context())

		var rawItems []newsletterSummarySource
		if err := cursor.All(r.Context(), &rawItems); err != nil {
			h.writeError(w, http.StatusInternalServerError, "failed to decode newsletters")
			return
		}

		items := make([]newsletterSummary, 0, len(rawItems))
		for _, raw := range rawItems {
			items = append(items, newsletterSummary{
				ID:            raw.ID,
				Owner:         raw.Owner,
				Title:         raw.Title,
				Template:      normalizeNewsletterTemplateName(raw.Template),
				HeaderID:      raw.HeaderID,
				IncludeIndex:  raw.IncludeIndex,
				ArticleIDs:    raw.ArticleIDs,
				RecipientIDs:  raw.RecipientIDs,
				IsFavorite:    raw.IsFavorite,
				Archived:      raw.Archived,
				Status:        raw.Status,
				DeliveryError: raw.DeliveryError,
				ScheduledAt:   raw.ScheduledAt,
				SentAt:        raw.SentAt,
				CreatedAt:     raw.CreatedAt,
				UpdatedAt:     raw.UpdatedAt,
				Preview:       contentPreview(raw.IntroMarkdown, raw.IntroHTML, 3, 180),
			})
		}

		h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
		return
	}

	cursor, err := h.newsletters.Find(r.Context(), visibilityFilter, findOptions)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to list newsletters")
		return
	}
	defer cursor.Close(r.Context())

	var newsletters []model.Newsletter
	if err := cursor.All(r.Context(), &newsletters); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to decode newsletters")
		return
	}
	if newsletters == nil {
		newsletters = []model.Newsletter{}
	}
	for i := range newsletters {
		newsletters[i].Template = normalizeNewsletterTemplateName(newsletters[i].Template)
	}

	h.writeJSON(w, http.StatusOK, map[string]any{"items": newsletters})
}

func (h *Handler) GetNewsletter(w http.ResponseWriter, r *http.Request, id string) {
	var newsletter model.Newsletter
	if err := h.newsletters.FindOne(r.Context(), bson.M{"_id": id, "$and": []bson.M{newsletterVisibilityFilter(UserFromContext(r.Context()))}}).Decode(&newsletter); err != nil {
		if err == mongo.ErrNoDocuments {
			h.writeError(w, http.StatusNotFound, "newsletter not found")
			return
		}
		h.writeError(w, http.StatusInternalServerError, "failed to fetch newsletter")
		return
	}
	newsletter.Template = normalizeNewsletterTemplateName(newsletter.Template)
	h.writeJSON(w, http.StatusOK, newsletter)
}

func (h *Handler) ClaimNewsletter(w http.ResponseWriter, r *http.Request, id string) {
	owner := resolveOwnerEmail(UserFromContext(r.Context()), "")
	if owner == "" {
		h.writeError(w, http.StatusBadRequest, "missing user email")
		return
	}

	now := time.Now().UTC()
	claimFilter := bson.M{
		"_id": id,
		"$or": []bson.M{
			{"owner": bson.M{"$exists": false}},
			{"owner": ""},
		},
	}

	result, err := h.newsletters.UpdateOne(r.Context(), claimFilter, bson.M{
		"$set": bson.M{
			"owner":     owner,
			"updatedAt": now,
		},
	})
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to claim newsletter")
		return
	}

	var newsletter model.Newsletter
	if err := h.newsletters.FindOne(r.Context(), bson.M{"_id": id}).Decode(&newsletter); err != nil {
		if err == mongo.ErrNoDocuments {
			h.writeError(w, http.StatusNotFound, "newsletter not found")
			return
		}
		h.writeError(w, http.StatusInternalServerError, "failed to fetch newsletter")
		return
	}

	if result.MatchedCount == 0 && strings.TrimSpace(strings.ToLower(newsletter.Owner)) != owner {
		h.writeError(w, http.StatusConflict, "newsletter already claimed")
		return
	}

	newsletter.Template = normalizeNewsletterTemplateName(newsletter.Template)
	h.writeJSON(w, http.StatusOK, newsletter)
}

type setFavoriteRequest struct {
	IsFavorite bool `json:"isFavorite"`
}

func (h *Handler) SetNewsletterFavorite(w http.ResponseWriter, r *http.Request, id string) {
	var req setFavoriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	now := time.Now().UTC()

	if req.IsFavorite {
		if _, err := h.newsletters.UpdateMany(r.Context(), bson.M{"isFavorite": true}, bson.M{
			"$set": bson.M{
				"isFavorite": false,
				"updatedAt":  now,
			},
		}); err != nil {
			h.writeError(w, http.StatusInternalServerError, "failed to update favorite newsletters")
			return
		}
	}

	result, err := h.newsletters.UpdateByID(r.Context(), id, bson.M{
		"$set": bson.M{
			"isFavorite": req.IsFavorite,
			"updatedAt":  now,
		},
	})
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to set newsletter favorite")
		return
	}
	if result.MatchedCount == 0 {
		h.writeError(w, http.StatusNotFound, "newsletter not found")
		return
	}

	var newsletter model.Newsletter
	if err := h.newsletters.FindOne(r.Context(), bson.M{"_id": id}).Decode(&newsletter); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to fetch updated newsletter")
		return
	}

	newsletter.Template = normalizeNewsletterTemplateName(newsletter.Template)
	h.writeJSON(w, http.StatusOK, newsletter)
}

func (h *Handler) UpdateNewsletter(w http.ResponseWriter, r *http.Request, id string) {
	var req updateNewsletterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	if strings.TrimSpace(req.Title) == "" {
		h.writeError(w, http.StatusBadRequest, "title is required")
		return
	}

	recipientIDs, err := normalizeRecipientIDs(req.RecipientIDs)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	templateName, err := validateNewsletterTemplateName(req.Template)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	update := bson.M{
		"$set": bson.M{
			"title":           strings.TrimSpace(req.Title),
			"template":        templateName,
			"headerId":        strings.TrimSpace(req.HeaderID),
			"introMarkdown":   req.IntroMarkdown,
			"introHTML":       req.IntroHTML,
			"footerMarkdown":  req.FooterMarkdown,
			"footerHTML":      req.FooterHTML,
			"includeIndex":    req.IncludeIndex,
			"contentWidth":    req.ContentWidth,
			"archived":        req.Archived,
			"articleIds":      req.ArticleIDs,
			"recipientIds":    recipientIDs,
			"contactTags":     normalizeContactTags(req.ContactTags),
			"contactTagsMode": normalizeContactTagsMode(req.ContactTagsMode),
			"updatedAt":       time.Now().UTC(),
		},
	}

	result, err := h.newsletters.UpdateByID(r.Context(), id, update)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to update newsletter")
		return
	}
	if result.MatchedCount == 0 {
		h.writeError(w, http.StatusNotFound, "newsletter not found")
		return
	}

	var newsletter model.Newsletter
	if err := h.newsletters.FindOne(r.Context(), bson.M{"_id": id}).Decode(&newsletter); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to fetch updated newsletter")
		return
	}

	h.writeJSON(w, http.StatusOK, newsletter)
}

func (h *Handler) GetNewsletterPreview(w http.ResponseWriter, r *http.Request, id string) {
	newsletter, articles, err := h.loadNewsletterWithArticles(r.Context(), id)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			h.writeError(w, http.StatusNotFound, "newsletter not found")
			return
		}
		h.writeError(w, http.StatusInternalServerError, "failed to load newsletter")
		return
	}

	htmlBody, textBody, err := h.renderNewsletter(r.Context(), *newsletter, articles)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to render newsletter")
		return
	}

	h.writeJSON(w, http.StatusOK, map[string]any{
		"newsletter": newsletter,
		"articles":   articles,
		"html":       htmlBody,
		"text":       textBody,
	})
}

type renderMarkdownRequest struct {
	Markdown string `json:"markdown"`
}

func (h *Handler) RenderMarkdown(w http.ResponseWriter, r *http.Request) {
	var req renderMarkdownRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	htmlBody, err := renderMarkdownToSafeHTML(req.Markdown)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, "failed to render markdown")
		return
	}

	h.writeJSON(w, http.StatusOK, map[string]string{"html": htmlBody})
}

func (h *Handler) GetRuntimeConfig(w http.ResponseWriter, r *http.Request) {
	h.writeJSON(w, http.StatusOK, map[string]any{
		"smtpConfigured":   h.cfg.UseGraphAPI || (h.cfg.SMTPHost != "" && h.cfg.SMTPFrom != ""),
		"oidcEnabled":      h.cfg.OIDCEnabled(),
		"contactsDisabled": h.cfg.ContactsDisabled,
		"scheduleDisabled": h.cfg.OIDCEnabled(),
		"appVersion":       h.appVersion,
	})
}

type scheduleRequest struct {
	ScheduledAt string `json:"scheduledAt"`
}

func (h *Handler) ScheduleNewsletter(w http.ResponseWriter, r *http.Request, id string) {
	var req scheduleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	scheduledAt, err := time.Parse(time.RFC3339, req.ScheduledAt)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, "scheduledAt must be RFC3339")
		return
	}

	update := bson.M{
		"$set": bson.M{
			"status":      model.NewsletterStatusScheduled,
			"scheduledAt": scheduledAt.UTC(),
			"updatedAt":   time.Now().UTC(),
		},
	}

	result, err := h.newsletters.UpdateByID(r.Context(), id, update)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to schedule newsletter")
		return
	}
	if result.MatchedCount == 0 {
		h.writeError(w, http.StatusNotFound, "newsletter not found")
		return
	}

	h.writeJSON(w, http.StatusOK, map[string]any{
		"id":          id,
		"status":      model.NewsletterStatusScheduled,
		"scheduledAt": scheduledAt.UTC(),
	})
}

func (h *Handler) SendNewsletterNow(w http.ResponseWriter, r *http.Request, id string) {
	var newsletter model.Newsletter
	if err := h.newsletters.FindOne(r.Context(), bson.M{"_id": id}).Decode(&newsletter); err != nil {
		if err == mongo.ErrNoDocuments {
			h.writeError(w, http.StatusNotFound, "newsletter not found")
			return
		}
		h.writeError(w, http.StatusInternalServerError, "failed to load newsletter")
		return
	}

	if newsletter.Status == model.NewsletterStatusSending {
		// Manual send-now should be able to recover a stuck state from a prior failed run.
		log.Printf("recovering sending state for manual send newsletter_id=%s updated_at=%s", newsletter.ID, newsletter.UpdatedAt.UTC().Format(time.RFC3339))
		_, _ = h.newsletters.UpdateByID(r.Context(), newsletter.ID, bson.M{
			"$set": bson.M{
				"status":    model.NewsletterStatusDraft,
				"updatedAt": time.Now().UTC(),
			},
			"$unset": bson.M{"deliveryError": ""},
		})
	}

	if err := h.processScheduledNewsletter(r.Context(), newsletter); err != nil {
		if errors.Is(err, errNewsletterAlreadySending) {
			h.writeError(w, http.StatusConflict, "newsletter is already sending")
			return
		}

		log.Printf("send-now failed newsletter_id=%s error=%v", newsletter.ID, err)

		if errors.Is(err, errTokenExpired) {
			h.writeJSON(w, http.StatusUnauthorized, map[string]any{
				"error":   "token_expired",
				"message": "Your session token has expired. Please re-authenticate to send.",
			})
			return
		}

		_, _ = h.newsletters.UpdateByID(r.Context(), newsletter.ID, bson.M{
			"$set": bson.M{
				"status":        model.NewsletterStatusFailed,
				"deliveryError": err.Error(),
				"updatedAt":     time.Now().UTC(),
			},
		})
		h.writeError(w, http.StatusBadGateway, "failed to send newsletter now: "+err.Error())
		return
	}

	log.Printf("send-now succeeded newsletter_id=%s", newsletter.ID)

	var sent model.Newsletter
	if err := h.newsletters.FindOne(r.Context(), bson.M{"_id": id}).Decode(&sent); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to load updated newsletter")
		return
	}

	h.writeJSON(w, http.StatusOK, map[string]any{
		"id":     sent.ID,
		"status": sent.Status,
		"sentAt": sent.SentAt,
	})
}

func (h *Handler) DeleteNewsletter(w http.ResponseWriter, r *http.Request, id string) {
	filter := bson.M{"_id": id, "$and": []bson.M{newsletterVisibilityFilter(UserFromContext(r.Context()))}}
	result, err := h.newsletters.DeleteOne(r.Context(), filter)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to delete newsletter")
		return
	}
	if result.DeletedCount == 0 {
		h.writeError(w, http.StatusNotFound, "newsletter not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) RunSchedulerOnce(ctx context.Context) error {
	now := time.Now().UTC()
	filter := bson.M{
		"status":      model.NewsletterStatusScheduled,
		"scheduledAt": bson.M{"$lte": now},
	}

	cursor, err := h.newsletters.Find(ctx, filter)
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)

	var dueNewsletters []model.Newsletter
	if err := cursor.All(ctx, &dueNewsletters); err != nil {
		return err
	}

	for _, newsletter := range dueNewsletters {
		log.Printf("scheduler picked newsletter_id=%s status=%s recipients=%d", newsletter.ID, newsletter.Status, len(newsletter.RecipientIDs))
		if err := h.processScheduledNewsletter(ctx, newsletter); err != nil {
			log.Printf("scheduler send failed newsletter_id=%s error=%v", newsletter.ID, err)
			_, _ = h.newsletters.UpdateByID(ctx, newsletter.ID, bson.M{
				"$set": bson.M{
					"status":        model.NewsletterStatusFailed,
					"deliveryError": err.Error(),
					"updatedAt":     time.Now().UTC(),
				},
			})
			continue
		}
		log.Printf("scheduler send succeeded newsletter_id=%s", newsletter.ID)
	}

	return nil
}

func (h *Handler) processScheduledNewsletter(ctx context.Context, newsletter model.Newsletter) error {
	if !h.cfg.UseGraphAPI && (h.cfg.SMTPHost == "" || h.cfg.SMTPFrom == "") {
		return fmt.Errorf("smtp is not configured")
	}

	lockResult, err := h.newsletters.UpdateOne(ctx, bson.M{
		"_id":    newsletter.ID,
		"status": bson.M{"$ne": model.NewsletterStatusSending},
	}, bson.M{
		"$set": bson.M{
			"status":    model.NewsletterStatusSending,
			"updatedAt": time.Now().UTC(),
		},
	})
	if err != nil {
		return err
	}
	if lockResult.MatchedCount == 0 {
		return errNewsletterAlreadySending
	}

	loadedNewsletter, articles, err := h.loadNewsletterWithArticles(ctx, newsletter.ID)
	if err != nil {
		return err
	}

	// Render the newsletter template once. #FIRST_NAME / #LAST_NAME placeholders are
	// left as literal strings in the output and substituted per-recipient below,
	// avoiding re-running the full markdown pipeline for every contact.
	htmlBody, textBody, err := h.renderNewsletter(ctx, *loadedNewsletter, articles)
	if err != nil {
		return err
	}

	accessToken := AccessTokenFromContext(ctx)
	var senderEmail string
	if u := UserFromContext(ctx); u != nil {
		senderEmail = u.Email
	}

	// Collect all recipients for BCC delivery.
	var recipients []string

	if len(loadedNewsletter.ContactTags) > 0 {
		contacts, err := h.resolveContactRecipients(ctx, loadedNewsletter.Owner, loadedNewsletter.ContactTags, loadedNewsletter.ContactTagsMode)
		if err != nil {
			return fmt.Errorf("failed to resolve contact recipients: %w", err)
		}
		for _, contact := range contacts {
			email := strings.TrimSpace(contact.Email)
			if email != "" {
				recipients = append(recipients, email)
			}
		}
	} else {
		for _, r := range loadedNewsletter.RecipientIDs {
			// Extract the plain email address from "First Last <email>" or plain "email" format.
			if parsed, err := mail.ParseAddress(strings.TrimSpace(r)); err == nil {
				if parsed.Address != "" {
					recipients = append(recipients, parsed.Address)
				}
			} else {
				// Fallback: use the raw value for backward compatibility with legacy entries.
				email := strings.TrimSpace(r)
				if email != "" {
					recipients = append(recipients, email)
				}
			}
		}
	}

	if len(recipients) == 0 {
		return fmt.Errorf("no recipients for newsletter %s", loadedNewsletter.ID)
	}

	log.Printf("smtp send start newsletter_id=%s recipients=%d smtp_host=%s smtp_port=%s", loadedNewsletter.ID, len(recipients), h.cfg.SMTPHost, h.cfg.SMTPPort)
	if err := h.sendEmailBcc(recipients, loadedNewsletter.Title, htmlBody, textBody, accessToken, senderEmail); err != nil {
		log.Printf("smtp send failed newsletter_id=%s error=%v", loadedNewsletter.ID, err)
		return err
	}
	log.Printf("smtp send success newsletter_id=%s recipients=%d", loadedNewsletter.ID, len(recipients))

	now := time.Now().UTC()
	if err := h.updateArticleUsageStats(ctx, loadedNewsletter.ArticleIDs, now); err != nil {
		log.Printf("failed to update article usage stats newsletter_id=%s error=%v", loadedNewsletter.ID, err)
	}
	_, err = h.newsletters.UpdateByID(ctx, loadedNewsletter.ID, bson.M{
		"$set": bson.M{
			"status":    model.NewsletterStatusSent,
			"sentAt":    now,
			"updatedAt": now,
		},
		"$unset": bson.M{"deliveryError": ""},
	})
	return err
}

func (h *Handler) loadNewsletterWithArticles(ctx context.Context, id string) (*model.Newsletter, []model.Article, error) {
	var newsletter model.Newsletter
	if err := h.newsletters.FindOne(ctx, bson.M{"_id": id}).Decode(&newsletter); err != nil {
		return nil, nil, err
	}

	if len(newsletter.ArticleIDs) == 0 {
		return &newsletter, []model.Article{}, nil
	}

	cursor, err := h.articles.Find(ctx, bson.M{"_id": bson.M{"$in": newsletter.ArticleIDs}})
	if err != nil {
		return nil, nil, err
	}
	defer cursor.Close(ctx)

	var items []model.Article
	if err := cursor.All(ctx, &items); err != nil {
		return nil, nil, err
	}

	byID := make(map[string]model.Article, len(items))
	for _, article := range items {
		byID[article.ID] = article
	}

	ordered := make([]model.Article, 0, len(newsletter.ArticleIDs))
	for _, articleID := range newsletter.ArticleIDs {
		if article, ok := byID[articleID]; ok {
			ordered = append(ordered, article)
		}
	}
	if err := h.applyArticleTranslations(ctx, ordered, "", false); err != nil {
		return nil, nil, err
	}

	return &newsletter, ordered, nil
}

func (h *Handler) updateArticleUsageStats(ctx context.Context, articleIDs []string, usedAt time.Time) error {
	if len(articleIDs) == 0 {
		return nil
	}

	uniqueIDs := make([]string, 0, len(articleIDs))
	seen := make(map[string]struct{}, len(articleIDs))
	for _, rawID := range articleIDs {
		articleID := strings.TrimSpace(rawID)
		if articleID == "" {
			continue
		}
		if _, ok := seen[articleID]; ok {
			continue
		}
		seen[articleID] = struct{}{}
		uniqueIDs = append(uniqueIDs, articleID)
	}

	if len(uniqueIDs) == 0 {
		return nil
	}

	_, err := h.articles.UpdateMany(ctx, bson.M{"_id": bson.M{"$in": uniqueIDs}}, bson.M{
		"$inc": bson.M{"sentCount": 1},
		"$set": bson.M{
			"last_used": usedAt,
			"updatedAt": usedAt,
		},
	})
	return err
}

func resolveOwnerEmail(user *User, fallback string) string {
	if user != nil {
		email := strings.TrimSpace(strings.ToLower(user.Email))
		if email != "" {
			return email
		}
	}

	return strings.TrimSpace(strings.ToLower(fallback))
}

func articleVisibilityFilter(user *User) bson.M {
	base := bson.M{"public": bson.M{"$ne": false}}
	unowned := bson.M{
		"$or": []bson.M{
			{"owner": bson.M{"$exists": false}},
			{"owner": ""},
		},
	}
	owner := resolveOwnerEmail(user, "")
	if owner == "" {
		return bson.M{
			"$or": []bson.M{base, unowned},
		}
	}

	return bson.M{
		"$or": []bson.M{
			base,
			unowned,
			{"owner": owner},
		},
	}
}

func newsletterVisibilityFilter(user *User) bson.M {
	owner := resolveOwnerEmail(user, "")
	if owner == "" {
		return bson.M{
			"$or": []bson.M{
				{"owner": bson.M{"$exists": false}},
				{"owner": ""},
			},
		}
	}

	return bson.M{
		"$or": []bson.M{
			{"owner": bson.M{"$exists": false}},
			{"owner": ""},
			{"owner": owner},
		},
	}
}

func headerOwnerFilter(user *User) bson.M {
	owner := resolveOwnerEmail(user, "")
	if owner == "" {
		return bson.M{
			"$or": []bson.M{
				{"owner": bson.M{"$exists": false}},
				{"owner": ""},
			},
		}
	}

	return bson.M{
		"$or": []bson.M{
			{"owner": bson.M{"$exists": false}},
			{"owner": ""},
			{"owner": owner},
		},
	}
}

// contactOwnerFilter returns a MongoDB filter that restricts contacts to
// those owned by the given user. When OIDC is disabled (owner is empty)
// we return an empty filter so all contacts are visible — this mirrors the
// behaviour of articles/newsletters for single-user (non-OIDC) deployments.
func contactOwnerFilter(owner string) bson.M {
	if owner == "" {
		return bson.M{}
	}
	return bson.M{"owner": owner}
}

func resolveContentWidth(n model.Newsletter) int {
	if n.ContentWidth >= 500 && n.ContentWidth <= 800 {
		return n.ContentWidth
	}
	return 680
}

type newsletterTemplateArticle struct {
	Title               string
	BodyHTML            string
	Illustration        string
	HasIconIllustration bool
	IconIllustration    string
}

type newsletterTemplatePayload struct {
	ContentWidth string
	HeaderHTML   string
	IntroHTML    string
	FooterHTML   string
	IncludeIndex bool
	Articles     []newsletterTemplateArticle
}

//go:embed templates/**/*.tmpl
var newsletterTemplateFiles embed.FS

var newsletterTemplateFuncMap = htmltemplate.FuncMap{
	"safeHTML": func(s string) htmltemplate.HTML { return htmltemplate.HTML(s) },
	"safeImageURL": func(s string) htmltemplate.URL {
		trimmed := strings.TrimSpace(s)
		if trimmed == "" {
			return htmltemplate.URL("")
		}
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "cid:") || strings.HasPrefix(lower, "data:image/") {
			return htmltemplate.URL(trimmed)
		}
		return htmltemplate.URL("")
	},
}

var newsletterTemplateNames = mustListNewsletterTemplateNames()
var newsletterTemplateByName = mustParseNewsletterTemplates(newsletterTemplateNames)

func mustListNewsletterTemplateNames() []string {
	entries, err := fs.ReadDir(newsletterTemplateFiles, "templates/newsletter")
	if err != nil {
		panic(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(strings.ToLower(name), ".tmpl") {
			continue
		}
		templateName := strings.TrimSuffix(name, ".tmpl")
		if strings.TrimSpace(templateName) == "" {
			continue
		}
		names = append(names, templateName)
	}
	sort.Strings(names)
	if len(names) == 0 {
		panic("no newsletter templates found")
	}
	return names
}

func mustParseNewsletterTemplates(names []string) map[string]*htmltemplate.Template {
	templates := make(map[string]*htmltemplate.Template, len(names))
	for _, name := range names {
		newsletterPath := "templates/newsletter/" + name + ".tmpl"
		articlePath := "templates/articles/" + name + ".tmpl"
		indexPath := "templates/index/" + name + ".tmpl"
		if _, err := fs.Stat(newsletterTemplateFiles, articlePath); err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				panic(err)
			}
			articlePath = "templates/articles/default.tmpl"
		}
		if _, err := fs.Stat(newsletterTemplateFiles, indexPath); err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				panic(err)
			}
			indexPath = "templates/index/default.tmpl"
		}
		tpl, err := htmltemplate.New("newsletter").Funcs(newsletterTemplateFuncMap).ParseFS(
			newsletterTemplateFiles,
			newsletterPath,
			articlePath,
			indexPath,
		)
		if err != nil {
			panic(err)
		}
		templates[name] = tpl
	}
	return templates
}

func listNewsletterTemplateNames() []string {
	out := make([]string, len(newsletterTemplateNames))
	copy(out, newsletterTemplateNames)
	return out
}

func normalizeNewsletterTemplateName(raw string) string {
	name := strings.TrimSpace(raw)
	if name == "" {
		return defaultNewsletterTemplateName
	}
	return name
}

func resolveNewsletterTemplateName(raw string) (string, bool) {
	name := normalizeNewsletterTemplateName(raw)
	_, ok := newsletterTemplateByName[name]
	return name, ok
}

func validateNewsletterTemplateName(raw string) (string, error) {
	name, ok := resolveNewsletterTemplateName(raw)
	if !ok {
		return "", fmt.Errorf("template %q is not available", name)
	}
	return name, nil
}

func renderNewsletterHTMLFromTemplate(templateName string, payload newsletterTemplatePayload) (string, error) {
	resolvedTemplate := normalizeNewsletterTemplateName(templateName)
	tpl, ok := newsletterTemplateByName[resolvedTemplate]
	if !ok {
		return "", fmt.Errorf("template %q is not available", resolvedTemplate)
	}
	var buf strings.Builder
	if err := tpl.ExecuteTemplate(&buf, "newsletter", payload); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func (h *Handler) renderNewsletter(ctx context.Context, newsletter model.Newsletter, articles []model.Article) (string, string, error) {
	contentWidth := resolveContentWidth(newsletter)
	widthStr := strconv.Itoa(contentWidth)

	headerHTML := ""
	headerText := ""
	if strings.TrimSpace(newsletter.HeaderID) != "" {
		var header model.Header
		err := h.headers.FindOne(ctx, bson.M{"_id": strings.TrimSpace(newsletter.HeaderID)}).Decode(&header)
		if err == nil {
			renderedHeader, renderErr := renderMarkdownToSafeHTML(header.Markdown)
			if renderErr != nil {
				return "", "", renderErr
			}
			titleForHTML := html.EscapeString(newsletter.Title)
			headerHTML = enforceTableFullWidth(enforceTableCellAlignment(enforceImageNaturalWidth(renderedHeader)))
			headerHTML = strings.ReplaceAll(headerHTML, "#TITLE", titleForHTML)
			headerText = strings.ReplaceAll(strings.TrimSpace(header.Markdown), "#TITLE", newsletter.Title)
		} else if err != mongo.ErrNoDocuments {
			return "", "", err
		}
	}

	var introHTML string
	if strings.TrimSpace(newsletter.IntroHTML) != "" {
		introHTML = sanitizeHTML(newsletter.IntroHTML)
	} else {
		var err error
		introHTML, err = renderMarkdownToSafeHTML(newsletter.IntroMarkdown)
		if err != nil {
			return "", "", err
		}
	}
	introHTML = enforceImageFullWidth(introHTML)
	introHTML = enforceContentTableStyles(introHTML)

	var footerHTML string
	if strings.TrimSpace(newsletter.FooterHTML) != "" {
		footerHTML = sanitizeHTML(newsletter.FooterHTML)
	} else {
		var err error
		footerHTML, err = renderMarkdownToSafeHTML(newsletter.FooterMarkdown)
		if err != nil {
			return "", "", err
		}
	}
	footerHTML = enforceImageFullWidth(footerHTML)
	footerHTML = enforceContentTableStyles(footerHTML)

	articlesForTemplate := make([]newsletterTemplateArticle, 0, len(articles))
	var text strings.Builder
	if headerText != "" {
		text.WriteString(headerText + "\n\n")
	}
	if strings.TrimSpace(newsletter.IntroHTML) != "" {
		text.WriteString(stripHTMLTags(newsletter.IntroHTML) + "\n\n")
	} else {
		text.WriteString(newsletter.IntroMarkdown + "\n\n")
	}

	if newsletter.IncludeIndex && len(articles) > 0 {
		text.WriteString("In this issue\n")
		for _, article := range articles {
			text.WriteString("- " + article.Title + "\n")
		}
		text.WriteString("\n")
	}

	for _, article := range articles {
		var articleHTML string
		if strings.TrimSpace(article.ContentHTML) != "" {
			articleHTML = sanitizeHTML(article.ContentHTML)
		} else {
			var err error
			articleHTML, err = renderMarkdownToSafeHTML(article.Markdown)
			if err != nil {
				return "", "", err
			}
		}
		articleHTML = enforceImageFullWidth(articleHTML)
		articleHTML = enforceContentTableStyles(articleHTML)
		illustration := strings.TrimSpace(article.Illustration)
		normalizedIllustration := normalizeDataURIForParsing(illustration)
		hasIconIllustration := strings.TrimSpace(article.IconSource) != "" ||
			regexp.MustCompile(`(?i)^data:image/(svg(?:\+|%2b)xml|png|jpeg|gif)(?:;[^,]*)?,`).MatchString(normalizedIllustration)
		iconIllustration := normalizedIllustration
		if regexp.MustCompile(`(?i)^data:image/svg(?:\+|%2b)xml(?:;[^,]*)?,`).MatchString(normalizedIllustration) {
			convertedPNG, convErr := convertSVGDataURLToPNGDataURL(normalizedIllustration)
			if convErr != nil {
				log.Printf("icon svg->png conversion failed article_id=%s error=%v", article.ID, convErr)
			} else {
				iconIllustration = convertedPNG
			}
		}

		articlesForTemplate = append(articlesForTemplate, newsletterTemplateArticle{
			Title:               article.Title,
			BodyHTML:            articleHTML,
			Illustration:        illustration,
			HasIconIllustration: hasIconIllustration,
			IconIllustration:    iconIllustration,
		})

		text.WriteString(article.Title + "\n")
		if strings.TrimSpace(article.ContentHTML) != "" {
			text.WriteString(stripHTMLTags(article.ContentHTML) + "\n\n")
		} else {
			text.WriteString(article.Markdown + "\n\n")
		}
	}

	if strings.TrimSpace(footerHTML) != "" {
		if strings.TrimSpace(newsletter.FooterHTML) != "" {
			text.WriteString(stripHTMLTags(newsletter.FooterHTML) + "\n\n")
		} else {
			text.WriteString(newsletter.FooterMarkdown + "\n\n")
		}
	}

	templateName, ok := resolveNewsletterTemplateName(newsletter.Template)
	if !ok {
		log.Printf("unknown newsletter template %q for newsletter_id=%s, falling back to %q", newsletter.Template, newsletter.ID, defaultNewsletterTemplateName)
		templateName = defaultNewsletterTemplateName
	}

	htmlBody, err := renderNewsletterHTMLFromTemplate(templateName, newsletterTemplatePayload{
		ContentWidth: widthStr,
		HeaderHTML:   headerHTML,
		IntroHTML:    introHTML,
		FooterHTML:   footerHTML,
		IncludeIndex: newsletter.IncludeIndex,
		Articles:     articlesForTemplate,
	})
	if err != nil {
		return "", "", err
	}
	htmlBody = convertSVGDataURLsInHTMLToPNG(htmlBody)
	return htmlBody, strings.TrimSpace(text.String()), nil
}

func convertSVGDataURLsInHTMLToPNG(input string) string {
	svgDataURIRe := regexp.MustCompile(`(?i)data:image/svg(?:\+|&#43;|%2b)xml(?:;[^,]*)?,[^"'\s>)]+`)
	const transparentPNGDataURI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z2NQAAAAASUVORK5CYII="

	return svgDataURIRe.ReplaceAllStringFunc(input, func(svgURI string) string {
		converted, err := convertSVGDataURLToPNGDataURL(svgURI)
		if err != nil {
			log.Printf("html svg->png replacement failed: %v", err)
			return transparentPNGDataURI
		}
		return converted
	})
}

func normalizeDataURIForParsing(input string) string {
	return strings.TrimSpace(html.UnescapeString(input))
}

func convertSVGDataURLToPNGDataURL(input string) (string, error) {
	trimmed := normalizeDataURIForParsing(input)
	if trimmed == "" {
		return "", fmt.Errorf("empty svg data url")
	}

	commaIndex := strings.Index(trimmed, ",")
	if commaIndex < 0 {
		return "", fmt.Errorf("invalid svg data url")
	}

	header := strings.ToLower(trimmed[:commaIndex])
	if !strings.HasPrefix(header, "data:image/svg+xml") {
		return "", fmt.Errorf("not an svg data url")
	}

	payload := trimmed[commaIndex+1:]
	var svgBytes []byte
	var err error
	if strings.Contains(header, ";base64") {
		svgBytes, err = base64.StdEncoding.DecodeString(payload)
	} else {
		var decoded string
		decoded, err = url.PathUnescape(payload)
		svgBytes = []byte(decoded)
	}
	if err != nil {
		return "", err
	}

	icon, err := oksvg.ReadIconStream(bytes.NewReader(svgBytes), oksvg.IgnoreErrorMode)
	if err != nil {
		return "", err
	}

	const targetSize = 80
	canvas := image.NewRGBA(image.Rect(0, 0, targetSize, targetSize))
	scanner := rasterx.NewScannerGV(targetSize, targetSize, canvas, canvas.Bounds())
	dasher := rasterx.NewDasher(targetSize, targetSize, scanner)
	icon.SetTarget(0, 0, float64(targetSize), float64(targetSize))
	icon.Draw(dasher, 1)

	var out bytes.Buffer
	if err := png.Encode(&out, canvas); err != nil {
		return "", err
	}

	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(out.Bytes()), nil
}

func enforceImageFullWidth(input string) string {
	re := regexp.MustCompile(`(?i)<img\b([^>]*)>`)
	widthAttrRe := regexp.MustCompile(`(?i)\swidth\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
	heightAttrRe := regexp.MustCompile(`(?i)\sheight\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)

	result := re.ReplaceAllStringFunc(input, func(tag string) string {
		tag = widthAttrRe.ReplaceAllString(tag, "")
		tag = heightAttrRe.ReplaceAllString(tag, "")
		styleRe := regexp.MustCompile(`(?i)style\s*=\s*"([^"]*)"`)
		if matches := styleRe.FindStringSubmatch(tag); len(matches) == 2 {
			styleValue := strings.TrimSpace(matches[1])
			if styleValue != "" && !strings.HasSuffix(styleValue, ";") {
				styleValue += ";"
			}
			styleValue += "max-width:100%;width:auto;height:auto;display:block;margin:4px auto;float:none;border:0;border-radius:0;"
			return styleRe.ReplaceAllString(tag, `style="`+styleValue+`"`)
		}

		return strings.Replace(tag, "<img", `<img style="max-width:100%;width:auto;height:auto;display:block;margin:4px auto;float:none;border:0;border-radius:0;"`, 1)
	})

	// Wrap paragraph-images in centered table cells for Apple Mail compatibility.
	// Apple Mail ignores margin:auto on block images; align="center" + text-align is reliable.
	pImgRe := regexp.MustCompile(`(?is)<p\b[^>]*>\s*(<img\b[^>]*>)\s*</p>`)
	result = pImgRe.ReplaceAllString(result,
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td align="center" style="text-align:center;padding:4px 0;border:0;">$1</td></tr></table>`)

	// Wrap any remaining standalone <img> tags not already inside a <td> (e.g. TipTap block images).
	// Apple Mail ignores margin:auto so we need table-based centering for every image.
	standaloneImgRe := regexp.MustCompile(`(?i)<img\b[^>]*>`)
	wrapPrefix := `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td align="center" style="text-align:center;padding:4px 0;border:0;">`
	wrapSuffix := `</td></tr></table>`
	matches := standaloneImgRe.FindAllStringIndex(result, -1)
	if len(matches) > 0 {
		var buf strings.Builder
		prev := 0
		for _, loc := range matches {
			between := result[prev:loc[0]]
			imgTag := result[loc[0]:loc[1]]
			// Check whether this <img> is already inside a <td> (from table-wrapping above or user tables).
			fullBefore := result[:loc[0]]
			lastTdOpen := strings.LastIndex(fullBefore, "<td")
			lastTdClose := strings.LastIndex(fullBefore, "</td")
			alreadyWrapped := lastTdOpen >= 0 && lastTdOpen > lastTdClose

			buf.WriteString(between)
			if alreadyWrapped {
				buf.WriteString(imgTag)
			} else {
				buf.WriteString(wrapPrefix)
				buf.WriteString(imgTag)
				buf.WriteString(wrapSuffix)
			}
			prev = loc[1]
		}
		buf.WriteString(result[prev:])
		result = buf.String()
	}

	return result
}

func enforceImageNaturalWidth(input string) string {
	re := regexp.MustCompile(`(?i)<img\b([^>]*)>`)
	widthAttrRe := regexp.MustCompile(`(?i)\swidth\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
	heightAttrRe := regexp.MustCompile(`(?i)\sheight\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)

	return re.ReplaceAllStringFunc(input, func(tag string) string {
		tag = widthAttrRe.ReplaceAllString(tag, "")
		tag = heightAttrRe.ReplaceAllString(tag, "")
		styleRe := regexp.MustCompile(`(?i)style\s*=\s*"([^"]*)"`)
		if matches := styleRe.FindStringSubmatch(tag); len(matches) == 2 {
			styleValue := strings.TrimSpace(matches[1])
			if styleValue != "" && !strings.HasSuffix(styleValue, ";") {
				styleValue += ";"
			}
			styleValue += "max-width:100%;width:auto;height:auto;display:block;margin:4px;float:none;border:0;border-radius:0;"
			return styleRe.ReplaceAllString(tag, `style="`+styleValue+`"`)
		}

		return strings.Replace(tag, "<img", `<img style="max-width:100%;width:auto;height:auto;display:block;margin:4px;float:none;border:0;border-radius:0;"`, 1)
	})
}

func enforceTableCellAlignment(input string) string {
	styleRe := regexp.MustCompile(`(?i)\bstyle\s*=\s*"([^"]*)"`)
	alignStyleRe := regexp.MustCompile(`(?i)(?:^|;)\s*text-align\s*:\s*(left|center|right|justify)\s*(?:;|$)`)
	valignStyleRe := regexp.MustCompile(`(?i)(?:^|;)\s*vertical-align\s*:\s*(top|middle|bottom)\s*(?:;|$)`)
	alignAttrRe := regexp.MustCompile(`(?i)\salign\s*=\s*"([^"]*)"`)
	valignAttrRe := regexp.MustCompile(`(?i)\svalign\s*=\s*"([^"]*)"`)
	innerAlignRe := regexp.MustCompile(`(?is)<[^>]+\bstyle\s*=\s*"[^"]*text-align\s*:\s*(left|center|right|justify)[^"]*"`)
	innerValignRe := regexp.MustCompile(`(?is)<[^>]+\bstyle\s*=\s*"[^"]*vertical-align\s*:\s*(top|middle|bottom)[^"]*"`)
	innerAlignSingleQuoteRe := regexp.MustCompile(`(?is)<[^>]+\bstyle\s*=\s*'[^']*text-align\s*:\s*(left|center|right|justify)[^']*'`)
	innerValignSingleQuoteRe := regexp.MustCompile(`(?is)<[^>]+\bstyle\s*=\s*'[^']*vertical-align\s*:\s*(top|middle|bottom)[^']*'`)
	innerAlignAttrRe := regexp.MustCompile(`(?is)<[^>]+\balign\s*=\s*"\s*(left|center|right|justify)\s*"`)
	innerValignAttrRe := regexp.MustCompile(`(?is)<[^>]+\bvalign\s*=\s*"\s*(top|middle|bottom)\s*"`)
	innerAlignAttrSingleQuoteRe := regexp.MustCompile(`(?is)<[^>]+\balign\s*=\s*'\s*(left|center|right|justify)\s*'`)
	innerValignAttrSingleQuoteRe := regexp.MustCompile(`(?is)<[^>]+\bvalign\s*=\s*'\s*(top|middle|bottom)\s*'`)
	innerClassAttrRe := regexp.MustCompile(`(?is)<[^>]+\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')`)
	innerImageTagRe := regexp.MustCompile(`(?is)<img\b[^>]*>`)

	lastMatchValue := func(re *regexp.Regexp, src string) string {
		matches := re.FindAllStringSubmatch(src, -1)
		if len(matches) == 0 {
			return ""
		}
		last := matches[len(matches)-1]
		if len(last) < 2 {
			return ""
		}
		return strings.ToLower(strings.TrimSpace(last[1]))
	}

	inferAlignFromImageStyle := func(styleValue string) string {
		lower := strings.ToLower(styleValue)
		declarations := make(map[string]string)
		for _, chunk := range strings.Split(lower, ";") {
			part := strings.TrimSpace(chunk)
			if part == "" {
				continue
			}
			pair := strings.SplitN(part, ":", 2)
			if len(pair) != 2 {
				continue
			}
			key := strings.TrimSpace(pair[0])
			value := strings.TrimSpace(pair[1])
			if key == "" || value == "" {
				continue
			}
			declarations[key] = value
		}

		marginLeft := declarations["margin-left"]
		marginRight := declarations["margin-right"]
		marginInlineStart := declarations["margin-inline-start"]
		marginInlineEnd := declarations["margin-inline-end"]
		floatValue := strings.TrimSpace(declarations["float"])

		switch floatValue {
		case "right":
			return "right"
		case "left":
			return "left"
		}

		hasMarginLeftAuto := marginLeft == "auto"
		hasMarginRightAuto := marginRight == "auto"
		hasMarginInlineStartAuto := marginInlineStart == "auto"
		hasMarginInlineEndAuto := marginInlineEnd == "auto"

		switch {
		case hasMarginInlineStartAuto && hasMarginInlineEndAuto:
			return "center"
		case hasMarginInlineStartAuto:
			return "right"
		case hasMarginInlineEndAuto:
			return "left"
		case hasMarginLeftAuto && hasMarginRightAuto:
			return "center"
		case hasMarginLeftAuto:
			return "right"
		case hasMarginRightAuto:
			return "left"
		}

		marginValue, hasMargin := declarations["margin"]
		if !hasMargin {
			return ""
		}

		parts := strings.Fields(strings.TrimSpace(marginValue))
		if len(parts) == 0 {
			return ""
		}

		isAuto := func(value string) bool {
			return strings.TrimSpace(value) == "auto"
		}

		switch len(parts) {
		case 2:
			if isAuto(parts[1]) {
				return "center"
			}
		case 3:
			if isAuto(parts[1]) {
				return "center"
			}
		case 4:
			right := parts[1]
			left := parts[3]
			if isAuto(left) && !isAuto(right) {
				return "right"
			}
			if isAuto(right) && !isAuto(left) {
				return "left"
			}
			if isAuto(right) && isAuto(left) {
				return "center"
			}
		}

		return ""
	}

	inferAlignFromInnerClasses := func(inner string) string {
		matches := innerClassAttrRe.FindAllStringSubmatch(inner, -1)
		if len(matches) == 0 {
			return ""
		}

		hasToken := func(classValue string, token string) bool {
			pattern := regexp.MustCompile(`(^|\s)` + regexp.QuoteMeta(token) + `(\s|$)`)
			return pattern.MatchString(classValue)
		}

		for i := len(matches) - 1; i >= 0; i -= 1 {
			if len(matches[i]) < 3 {
				continue
			}
			classValue := strings.ToLower(strings.TrimSpace(matches[i][1]))
			if classValue == "" {
				classValue = strings.ToLower(strings.TrimSpace(matches[i][2]))
			}
			if classValue == "" {
				continue
			}

			rightTokens := []string{"ql-align-right", "align-right", "text-right", "is-right-aligned", "has-text-align-right"}
			for _, token := range rightTokens {
				if hasToken(classValue, token) {
					return "right"
				}
			}

			centerTokens := []string{"ql-align-center", "align-center", "text-center", "is-centered", "has-text-align-center"}
			for _, token := range centerTokens {
				if hasToken(classValue, token) {
					return "center"
				}
			}

			leftTokens := []string{"ql-align-left", "align-left", "text-left", "is-left-aligned", "has-text-align-left"}
			for _, token := range leftTokens {
				if hasToken(classValue, token) {
					return "left"
				}
			}
		}

		return ""
	}

	inferAlignFromInnerImages := func(inner string) string {
		imageTags := innerImageTagRe.FindAllString(inner, -1)
		if len(imageTags) == 0 {
			return ""
		}

		getAttrValue := func(tag string, attr string) string {
			doubleQuoted := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(attr) + `\s*=\s*"([^"]*)"`)
			singleQuoted := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(attr) + `\s*=\s*'([^']*)'`)
			if m := doubleQuoted.FindStringSubmatch(tag); len(m) == 2 {
				return m[1]
			}
			if m := singleQuoted.FindStringSubmatch(tag); len(m) == 2 {
				return m[1]
			}
			return ""
		}

		for i := len(imageTags) - 1; i >= 0; i -= 1 {
			styleValue := getAttrValue(imageTags[i], "style")
			if styleValue == "" {
				continue
			}
			if align := inferAlignFromImageStyle(styleValue); align != "" {
				return align
			}
		}

		return ""
	}

	ensureStyleProp := func(tag string, prop string, value string) string {
		if value == "" {
			return tag
		}

		propRe := regexp.MustCompile(`(?i)(?:^|;)\s*` + regexp.QuoteMeta(prop) + `\s*:\s*[^;]+;?`)
		if matches := styleRe.FindStringSubmatch(tag); len(matches) == 2 {
			styleValue := matches[1]
			styleValue = propRe.ReplaceAllString(styleValue, "")
			styleValue = strings.TrimSpace(styleValue)
			if styleValue != "" && !strings.HasSuffix(styleValue, ";") {
				styleValue += ";"
			}
			styleValue += prop + ":" + value + ";"
			return styleRe.ReplaceAllString(tag, `style="`+styleValue+`"`)
		}

		return strings.Replace(tag, ">", ` style="`+prop+`:`+value+`;">`, 1)
	}

	processCellBlocks := func(src string, tagName string) string {
		cellBlockRe := regexp.MustCompile(`(?is)<` + tagName + `\b([^>]*)>(.*?)</` + tagName + `>`)

		return cellBlockRe.ReplaceAllStringFunc(src, func(block string) string {
			matches := cellBlockRe.FindStringSubmatch(block)
			if len(matches) != 3 {
				return block
			}

			attrs := matches[1]
			inner := matches[2]
			openTag := "<" + tagName + attrs + ">"

			align := ""
			if m := alignAttrRe.FindStringSubmatch(openTag); len(m) == 2 {
				align = strings.ToLower(strings.TrimSpace(m[1]))
			}
			if align == "" {
				if m := styleRe.FindStringSubmatch(openTag); len(m) == 2 {
					if a := alignStyleRe.FindStringSubmatch(m[1]); len(a) == 2 {
						align = strings.ToLower(a[1])
					}
				}
			}
			if align == "" {
				align = lastMatchValue(innerAlignRe, inner)
			}
			if align == "" {
				align = lastMatchValue(innerAlignSingleQuoteRe, inner)
			}
			if align == "" {
				align = lastMatchValue(innerAlignAttrRe, inner)
			}
			if align == "" {
				align = lastMatchValue(innerAlignAttrSingleQuoteRe, inner)
			}
			if align == "" {
				align = inferAlignFromInnerImages(inner)
			}
			if align == "" {
				align = inferAlignFromInnerClasses(inner)
			}

			valign := ""
			if m := valignAttrRe.FindStringSubmatch(openTag); len(m) == 2 {
				valign = strings.ToLower(strings.TrimSpace(m[1]))
			}
			if valign == "" {
				if m := styleRe.FindStringSubmatch(openTag); len(m) == 2 {
					if v := valignStyleRe.FindStringSubmatch(m[1]); len(v) == 2 {
						valign = strings.ToLower(v[1])
					}
				}
			}
			if valign == "" {
				valign = lastMatchValue(innerValignRe, inner)
			}
			if valign == "" {
				valign = lastMatchValue(innerValignSingleQuoteRe, inner)
			}
			if valign == "" {
				valign = lastMatchValue(innerValignAttrRe, inner)
			}
			if valign == "" {
				valign = lastMatchValue(innerValignAttrSingleQuoteRe, inner)
			}

			updatedOpen := openTag
			if align != "" {
				if !alignAttrRe.MatchString(updatedOpen) {
					updatedOpen = strings.Replace(updatedOpen, ">", ` align="`+align+`">`, 1)
				}
				updatedOpen = ensureStyleProp(updatedOpen, "text-align", align)

				// Apple Mail ignores margin-left:auto on display:block images
				// (width:auto block elements fill container width, leaving no
				// room for auto margins). Switch to display:inline-block so the
				// cell's text-align controls image position instead.
				displayBlockRe := regexp.MustCompile(`(?i)(display\s*:\s*)block\b`)
				inner = innerImageTagRe.ReplaceAllStringFunc(inner, func(imgTag string) string {
					return displayBlockRe.ReplaceAllString(imgTag, "${1}inline-block")
				})
			}
			if valign != "" {
				if !valignAttrRe.MatchString(updatedOpen) {
					updatedOpen = strings.Replace(updatedOpen, ">", ` valign="`+valign+`">`, 1)
				}
				updatedOpen = ensureStyleProp(updatedOpen, "vertical-align", valign)
			}

			return updatedOpen + inner + "</" + tagName + ">"
		})
	}

	output := processCellBlocks(input, "td")
	output = processCellBlocks(output, "th")
	return output
}

func enforceContentTableStyles(input string) string {
	styleRe := regexp.MustCompile(`(?i)\bstyle\s*=\s*"([^"]*)"`)

	ensureStyle := func(tag, defaults string) string {
		if matches := styleRe.FindStringSubmatch(tag); len(matches) == 2 {
			existing := matches[1]
			if existing != "" && !strings.HasSuffix(strings.TrimSpace(existing), ";") {
				existing += ";"
			}
			return styleRe.ReplaceAllString(tag, `style="`+defaults+existing+`"`)
		}
		return strings.Replace(tag, ">", ` style="`+defaults+`">`, 1)
	}

	ensureStyleIfMissing := func(tag string, props map[string]string) string {
		var existingStyle string
		if matches := styleRe.FindStringSubmatch(tag); len(matches) == 2 {
			existingStyle = matches[1]
		}
		lower := strings.ToLower(existingStyle)
		additions := ""
		for prop, val := range props {
			if !strings.Contains(lower, prop) {
				additions += prop + ":" + val + ";"
			}
		}
		if additions == "" && existingStyle != "" {
			return tag
		}
		if existingStyle != "" {
			if !strings.HasSuffix(strings.TrimSpace(existingStyle), ";") {
				existingStyle += ";"
			}
			return styleRe.ReplaceAllString(tag, `style="`+additions+existingStyle+`"`)
		}
		return strings.Replace(tag, ">", ` style="`+additions+`">`, 1)
	}

	// Tables: full-width + fixed layout + border-collapse
	tableRe := regexp.MustCompile(`(?i)<table\b[^>]*>`)
	input = tableRe.ReplaceAllStringFunc(input, func(tag string) string {
		return ensureStyleIfMissing(tag, map[string]string{
			"border-collapse": "collapse",
			"width":           "100%",
			"max-width":       "100%",
			"table-layout":    "fixed",
		})
	})

	// Table cells: border + padding
	tdRe := regexp.MustCompile(`(?i)<td\b[^>]*>`)
	input = tdRe.ReplaceAllStringFunc(input, func(tag string) string {
		return ensureStyleIfMissing(tag, map[string]string{
			"border":  "1px solid #ced4da",
			"padding": "4px 8px",
		})
	})

	// Table headers: border + padding + background + font-weight
	thRe := regexp.MustCompile(`(?i)<th\b[^>]*>`)
	input = thRe.ReplaceAllStringFunc(input, func(tag string) string {
		return ensureStyleIfMissing(tag, map[string]string{
			"border":           "1px solid #ced4da",
			"padding":          "4px 8px",
			"background-color": "#f1f3f5",
			"font-weight":      "600",
		})
	})

	// Zero out margin on <p> inside <li> before the general paragraph pass.
	// TipTap serialises list-item content as <li><p>text</p></li>, so without
	// this pre-pass the paragraph margin rule below would space list items like
	// block paragraphs in email clients.
	liPRe := regexp.MustCompile(`(?i)<p\b[^>]*>`)
	liBlockRe := regexp.MustCompile(`(?is)<li\b[^>]*>.*?</li\s*>`)
	input = liBlockRe.ReplaceAllStringFunc(input, func(liBlock string) string {
		return liPRe.ReplaceAllStringFunc(liBlock, func(pTag string) string {
			return ensureStyleIfMissing(pTag, map[string]string{"margin": "0"})
		})
	})

	// Paragraphs: margin
	pRe := regexp.MustCompile(`(?i)<p\b[^>]*>`)
	input = pRe.ReplaceAllStringFunc(input, func(tag string) string {
		return ensureStyleIfMissing(tag, map[string]string{
			"margin": "8px 0 0 0",
		})
	})

	// Headings
	headingDefaults := map[string]string{
		"h1": "font-size:1.5em;font-weight:700;margin:1em 0 0.5em 0;",
		"h2": "font-size:1.25em;font-weight:700;margin:1em 0 0.5em 0;",
		"h3": "font-size:1.125em;font-weight:600;margin:1em 0 0.5em 0;",
		"h4": "font-size:1em;font-weight:600;margin:1em 0 0.5em 0;",
	}
	for tag, defaults := range headingDefaults {
		re := regexp.MustCompile(`(?i)<` + tag + `\b[^>]*>`)
		d := defaults
		input = re.ReplaceAllStringFunc(input, func(match string) string {
			return ensureStyle(match, d)
		})
	}

	// Lists: margin + padding
	listRe := regexp.MustCompile(`(?i)<(?:ul|ol)\b[^>]*>`)
	input = listRe.ReplaceAllStringFunc(input, func(tag string) string {
		return ensureStyleIfMissing(tag, map[string]string{
			"margin":       "0.5em 0",
			"padding-left": "1.5em",
		})
	})

	// List items: zero margin/padding so the <p> wrapper that TipTap emits
	// inside each <li> does not add paragraph-like spacing in email clients.
	liTagRe := regexp.MustCompile(`(?i)<li\b[^>]*>`)
	input = liTagRe.ReplaceAllStringFunc(input, func(tag string) string {
		return ensureStyleIfMissing(tag, map[string]string{
			"margin":  "0",
			"padding": "0",
		})
	})

	// Horizontal rules
	hrRe := regexp.MustCompile(`(?i)<hr\b[^>]*>`)
	input = hrRe.ReplaceAllStringFunc(input, func(tag string) string {
		return ensureStyleIfMissing(tag, map[string]string{
			"border":           "none",
			"height":           "1px",
			"background-color": "#e5e7eb",
			"margin":           "1.5em 0",
		})
	})

	// Links: for <a> tags that contain a <span>, remove the default underline
	// from the <a> and apply it to the <span> so the underline color matches
	// the text color set by the editor. For <a> tags without a <span>, keep
	// the underline on the <a> itself.
	aBlockRe := regexp.MustCompile(`(?is)<a\b[^>]*>.*?</a\s*>`)
	spanRe := regexp.MustCompile(`(?i)<span\b[^>]*>`)
	aOpenRe := regexp.MustCompile(`(?i)<a\b[^>]*>`)
	input = aBlockRe.ReplaceAllStringFunc(input, func(aBlock string) string {
		if spanRe.MatchString(aBlock) {
			// Has <span> children: remove underline from <a>, add to <span>.
			aBlock = aOpenRe.ReplaceAllStringFunc(aBlock, func(tag string) string {
				return ensureStyleIfMissing(tag, map[string]string{
					"color":           "inherit",
					"text-decoration": "none",
				})
			})
			aBlock = spanRe.ReplaceAllStringFunc(aBlock, func(spanTag string) string {
				return ensureStyleIfMissing(spanTag, map[string]string{
					"text-decoration": "underline",
				})
			})
		} else {
			// No <span>: ensure underline stays on the <a>.
			aBlock = aOpenRe.ReplaceAllStringFunc(aBlock, func(tag string) string {
				return ensureStyleIfMissing(tag, map[string]string{
					"color":           "inherit",
					"text-decoration": "underline",
				})
			})
		}
		return aBlock
	})

	return input
}

func enforceTableFullWidth(input string) string {
	tableRe := regexp.MustCompile(`(?i)<table\b[^>]*>`)
	styleRe := regexp.MustCompile(`(?i)\bstyle\s*=\s*"([^"]*)"`)
	widthAttrRe := regexp.MustCompile(`(?i)\swidth\s*=\s*"[^"]*"`)

	return tableRe.ReplaceAllStringFunc(input, func(tag string) string {
		updated := tag

		if matches := styleRe.FindStringSubmatch(updated); len(matches) == 2 {
			styleValue := matches[1]
			styleValue = regexp.MustCompile(`(?i)(?:^|;)\s*width\s*:\s*[^;]+;?`).ReplaceAllString(styleValue, "")
			styleValue = regexp.MustCompile(`(?i)(?:^|;)\s*max-width\s*:\s*[^;]+;?`).ReplaceAllString(styleValue, "")
			styleValue = regexp.MustCompile(`(?i)(?:^|;)\s*min-width\s*:\s*[^;]+;?`).ReplaceAllString(styleValue, "")
			styleValue = regexp.MustCompile(`(?i)(?:^|;)\s*table-layout\s*:\s*[^;]+;?`).ReplaceAllString(styleValue, "")
			styleValue = regexp.MustCompile(`(?i)(?:^|;)\s*border-collapse\s*:\s*[^;]+;?`).ReplaceAllString(styleValue, "")
			styleValue = strings.TrimSpace(styleValue)
			if styleValue != "" && !strings.HasSuffix(styleValue, ";") {
				styleValue += ";"
			}
			styleValue = "width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse;" + styleValue
			updated = styleRe.ReplaceAllString(updated, `style="`+styleValue+`"`)
		} else {
			updated = strings.Replace(updated, "<table", `<table style="width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse;"`, 1)
		}

		if widthAttrRe.MatchString(updated) {
			updated = widthAttrRe.ReplaceAllString(updated, ` width="100%"`)
		} else {
			updated = strings.Replace(updated, ">", ` width="100%">`, 1)
		}

		return updated
	})
}

func contentPreview(markdown, contentHTML string, maxLines, maxChars int) string {
	if strings.TrimSpace(contentHTML) != "" {
		return htmlPreviewText(contentHTML, maxLines, maxChars)
	}
	return markdownPreviewText(markdown, maxLines, maxChars)
}

func htmlPreviewText(input string, maxLines, maxChars int) string {
	// Insert newlines before block-level closing tags so text from different
	// paragraphs/divs/headings doesn't merge together after tag stripping.
	blockBoundary := regexp.MustCompile(`(?i)</(p|div|h[1-6]|li|tr|blockquote)>`)
	s := blockBoundary.ReplaceAllString(input, "\n")
	brRe := regexp.MustCompile(`(?i)<br\s*/?>`)
	s = brRe.ReplaceAllString(s, "\n")
	s = regexp.MustCompile(`<[^>]+>`).ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	s = strings.ReplaceAll(s, "\r", "")

	lines := strings.Split(s, "\n")
	normalized := make([]string, 0, maxLines)
	for _, line := range lines {
		trimmed := strings.Join(strings.Fields(strings.TrimSpace(line)), " ")
		if trimmed == "" {
			continue
		}
		normalized = append(normalized, trimmed)
		if len(normalized) >= maxLines {
			break
		}
	}

	joined := strings.Join(normalized, " ")
	if len(joined) <= maxChars {
		return joined
	}
	return strings.TrimSpace(joined[:maxChars]) + "..."
}

func stripHTMLTags(input string) string {
	stripped := regexp.MustCompile(`<[^>]+>`).ReplaceAllString(input, " ")
	stripped = strings.Join(strings.Fields(stripped), " ")
	return strings.TrimSpace(stripped)
}

func sanitizeHTML(htmlInput string) string {
	policy := bluemonday.UGCPolicy()
	policy.RequireParseableURLs(false)
	policy.AllowDataURIImages()
	policy.AllowURLSchemes("http", "https", "data")
	policy.AllowAttrs("src").Matching(regexp.MustCompile(`^(?i)(https?://|data:image/)`)).OnElements("img")
	policy.AllowAttrs("alt", "title").OnElements("img")
	policy.AllowAttrs("href").OnElements("a")
	policy.AllowAttrs("style").OnElements(
		"p", "span", "div",
		"table", "thead", "tbody", "tfoot", "tr", "th", "td",
		"h1", "h2", "h3", "h4", "h5", "h6",
		"ul", "ol", "li",
		"strong", "em", "u", "a", "img",
		"blockquote",
	)
	styleValuePattern := regexp.MustCompile(`(?i)^[a-z0-9\s#(),.%'"\-+/]+$`)
	policy.AllowStyles(
		"text-align", "font-size", "font-family", "font-weight", "font-style",
		"text-decoration", "line-height", "color", "background-color",
		"vertical-align", "width", "max-width", "height",
		"display", "margin", "margin-left", "margin-right", "margin-top", "margin-bottom",
		"border", "border-left", "border-collapse", "table-layout",
		"padding", "padding-left", "padding-right", "padding-top", "padding-bottom",
	).Matching(styleValuePattern).OnElements(
		"p", "span", "div",
		"table", "thead", "tbody", "tfoot", "tr", "th", "td",
		"h1", "h2", "h3", "h4", "h5", "h6",
		"ul", "ol", "li",
		"strong", "em", "u", "a", "img",
		"blockquote",
	)
	policy.AllowElements("table", "thead", "tbody", "tfoot", "tr", "th", "td", "blockquote")
	policy.AllowAttrs("align", "valign", "colspan", "rowspan").OnElements("th", "td")
	sanitized := policy.Sanitize(htmlInput)
	sanitized = strings.ReplaceAll(sanitized, "<blockquote>", `<blockquote style="border-left:4px solid #ccc;background-color:#f5f5f5;margin:1em 0;padding:0.75em 1em">`)
	return sanitized
}

func renderMarkdownToSafeHTML(markdown string) (string, error) {
	var raw bytes.Buffer
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithRendererOptions(gmhtml.WithUnsafe()),
	)
	if err := md.Convert([]byte(markdown), &raw); err != nil {
		return "", err
	}

	policy := bluemonday.UGCPolicy()
	policy.RequireParseableURLs(false)
	policy.AllowDataURIImages()
	policy.AllowURLSchemes("http", "https", "data")
	policy.AllowAttrs("src").Matching(regexp.MustCompile(`^(?i)(https?://|data:image/)`)).OnElements("img")
	policy.AllowAttrs("alt", "title").OnElements("img")
	policy.AllowAttrs("style").OnElements(
		"p", "span", "div",
		"table", "thead", "tbody", "tfoot", "tr", "th", "td",
		"h1", "h2", "h3", "h4", "h5", "h6",
		"ul", "ol", "li",
		"strong", "em", "u", "a", "img",
		"blockquote",
	)
	styleValuePattern := regexp.MustCompile(`(?i)^[a-z0-9\s#(),.%'"\-+/]+$`)
	policy.AllowStyles(
		"text-align",
		"font-size",
		"font-family",
		"font-weight",
		"font-style",
		"text-decoration",
		"line-height",
		"color",
		"background-color",
		"vertical-align",
		"width",
		"max-width",
		"height",
		"display",
		"margin",
		"margin-left",
		"margin-right",
		"margin-top",
		"margin-bottom",
		"border",
		"border-left",
		"border-collapse",
		"table-layout",
		"padding",
		"padding-left",
		"padding-right",
		"padding-top",
		"padding-bottom",
	).Matching(styleValuePattern).OnElements(
		"p", "span", "div",
		"table", "thead", "tbody", "tfoot", "tr", "th", "td",
		"h1", "h2", "h3", "h4", "h5", "h6",
		"ul", "ol", "li",
		"strong", "em", "u", "a", "img",
		"blockquote",
	)
	policy.AllowElements("table", "thead", "tbody", "tfoot", "tr", "th", "td", "blockquote")
	policy.AllowAttrs("align", "valign", "colspan", "rowspan").OnElements("th", "td")

	sanitized := policy.Sanitize(raw.String())
	sanitized = strings.ReplaceAll(sanitized, "<blockquote>", `<blockquote style="border-left:4px solid #ccc;background-color:#f5f5f5;margin:1em 0;padding:0.75em 1em">`)
	return sanitized, nil
}

type inlineAttachment struct {
	CID      string
	MimeType string
	Data     []byte
}

func extractInlineDataImages(htmlBody string) (string, []inlineAttachment, error) {
	re := regexp.MustCompile(`src="(data:[^"]+)"`)
	matches := re.FindAllStringSubmatch(htmlBody, -1)
	if len(matches) == 0 {
		return htmlBody, nil, nil
	}

	attachments := make([]inlineAttachment, 0, len(matches))
	updated := htmlBody
	seen := make(map[string]string, len(matches))

	for _, m := range matches {
		dataURI := m[1]
		if !strings.HasPrefix(strings.ToLower(dataURI), "data:image/") {
			continue
		}

		cid, ok := seen[dataURI]
		if !ok {
			mimeType, data, err := decodeDataImageURI(dataURI)
			if err != nil {
				return "", nil, err
			}

			cid = fmt.Sprintf("inline-image-%d", len(attachments)+1)
			attachments = append(attachments, inlineAttachment{CID: cid, MimeType: mimeType, Data: data})
			seen[dataURI] = cid
		}

		updated = strings.ReplaceAll(updated, `src="`+dataURI+`"`, `src="cid:`+cid+`"`)
	}

	return updated, attachments, nil
}

func decodeDataImageURI(dataURI string) (string, []byte, error) {
	dataURI = normalizeDataURIForParsing(dataURI)
	if !strings.HasPrefix(dataURI, "data:") {
		return "", nil, fmt.Errorf("invalid data uri")
	}

	payload := strings.TrimPrefix(dataURI, "data:")
	comma := strings.Index(payload, ",")
	if comma < 0 {
		return "", nil, fmt.Errorf("invalid data uri payload")
	}

	meta := payload[:comma]
	encoded := payload[comma+1:]
	parts := strings.Split(meta, ";")
	mimeType := parts[0]
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	isBase64 := false
	if len(parts) > 1 {
		filtered := make([]string, 0, len(parts)-1)
		for _, part := range parts[1:] {
			if strings.EqualFold(part, "base64") {
				isBase64 = true
				continue
			}
			if part != "" {
				filtered = append(filtered, part)
			}
		}
		if len(filtered) > 0 {
			mimeType += ";" + strings.Join(filtered, ";")
		}
	}

	if isBase64 {
		clean := strings.ReplaceAll(encoded, "\n", "")
		clean = strings.ReplaceAll(clean, "\r", "")
		data, err := base64.StdEncoding.DecodeString(clean)
		if err != nil {
			return "", nil, err
		}
		return mimeType, data, nil
	}

	decoded, err := url.PathUnescape(encoded)
	if err != nil {
		return "", nil, err
	}
	return mimeType, []byte(decoded), nil
}

// sendEmail dispatches to Microsoft Graph API or SMTP based on configuration.
func (h *Handler) sendEmail(recipient, subject, htmlBody, textBody, accessToken, senderEmail string) error {
	if h.cfg.UseGraphAPI && accessToken != "" {
		return h.sendGraphMail(recipient, subject, htmlBody, accessToken)
	}
	return h.sendSMTP(recipient, subject, htmlBody, textBody, accessToken, senderEmail)
}

func (h *Handler) sendEmailBcc(recipients []string, subject, htmlBody, textBody, accessToken, senderEmail string) error {
	if h.cfg.UseGraphAPI && accessToken != "" {
		return h.sendGraphMailBcc(recipients, subject, htmlBody, accessToken)
	}
	return h.sendSMTPBcc(recipients, subject, htmlBody, textBody, accessToken, senderEmail)
}

// sendGraphMail sends an email via the Microsoft Graph API using the user's access token.
func (h *Handler) sendGraphMail(recipient, subject, htmlBody, accessToken string) error {
	if recipient == "" {
		return nil
	}

	payload := map[string]any{
		"message": map[string]any{
			"subject": subject,
			"body": map[string]string{
				"contentType": "HTML",
				"content":     htmlBody,
			},
			"toRecipients": []map[string]any{
				{
					"emailAddress": map[string]string{
						"address": recipient,
					},
				},
			},
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("graph: marshal payload: %w", err)
	}

	req, err := http.NewRequest("POST", "https://graph.microsoft.com/v1.0/me/sendMail", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("graph: create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("graph: send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		var errBody bytes.Buffer
		errBody.ReadFrom(resp.Body)
		if resp.StatusCode == http.StatusUnauthorized {
			return errTokenExpired
		}
		return fmt.Errorf("graph: sendMail returned %d: %s", resp.StatusCode, errBody.String())
	}

	return nil
}

// sendGraphMailBcc sends a single email via the Microsoft Graph API with all recipients in BCC.
func (h *Handler) sendGraphMailBcc(recipients []string, subject, htmlBody, accessToken string) error {
	if len(recipients) == 0 {
		return nil
	}

	bccList := make([]map[string]any, 0, len(recipients))
	for _, r := range recipients {
		bccList = append(bccList, map[string]any{
			"emailAddress": map[string]string{
				"address": r,
			},
		})
	}

	payload := map[string]any{
		"message": map[string]any{
			"subject": subject,
			"body": map[string]string{
				"contentType": "HTML",
				"content":     htmlBody,
			},
			"toRecipients":  []map[string]any{},
			"bccRecipients": bccList,
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("graph: marshal payload: %w", err)
	}

	req, err := http.NewRequest("POST", "https://graph.microsoft.com/v1.0/me/sendMail", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("graph: create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("graph: send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		var errBody bytes.Buffer
		errBody.ReadFrom(resp.Body)
		if resp.StatusCode == http.StatusUnauthorized {
			return errTokenExpired
		}
		return fmt.Errorf("graph: sendMail returned %d: %s", resp.StatusCode, errBody.String())
	}

	return nil
}

// xoauth2Auth implements smtp.Auth for the SASL XOAUTH2 mechanism.
type xoauth2Auth struct {
	user        string
	accessToken string
}

func (a xoauth2Auth) Start(_ *smtp.ServerInfo) (string, []byte, error) {
	msg := fmt.Sprintf("user=%s\x01auth=Bearer %s\x01\x01", a.user, a.accessToken)
	return "XOAUTH2", []byte(msg), nil
}

func (a xoauth2Auth) Next(_ []byte, more bool) ([]byte, error) {
	if more {
		// Server sent a challenge (error JSON); return empty to proceed to proper error.
		return []byte{}, nil
	}
	return nil, nil
}

func (h *Handler) sendSMTP(recipient, subject, htmlBody, textBody, accessToken, senderEmail string) error {
	if recipient == "" {
		return nil
	}

	cidHTML, attachments, err := extractInlineDataImages(htmlBody)
	if err != nil {
		return fmt.Errorf("extract inline images: %w", err)
	}

	// Sanitize header values to prevent SMTP header injection
	sanitizeHeader := func(v string) string {
		v = strings.ReplaceAll(v, "\r", "")
		v = strings.ReplaceAll(v, "\n", "")
		return v
	}

	message := strings.Builder{}
	message.WriteString("From: " + sanitizeHeader(h.cfg.SMTPFrom) + "\r\n")
	message.WriteString("To: " + sanitizeHeader(recipient) + "\r\n")
	message.WriteString("Subject: " + sanitizeHeader(subject) + "\r\n")
	message.WriteString("MIME-Version: 1.0\r\n")

	altBoundary := fmt.Sprintf("alt-boundary-%d", time.Now().UnixNano())

	if len(attachments) == 0 {
		message.WriteString("Content-Type: multipart/alternative; boundary=" + altBoundary + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		message.WriteString(textBody + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
		message.WriteString(cidHTML + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "--\r\n")
	} else {
		relBoundary := fmt.Sprintf("rel-boundary-%d", time.Now().UnixNano())
		message.WriteString("Content-Type: multipart/related; boundary=" + relBoundary + "\r\n\r\n")
		message.WriteString("--" + relBoundary + "\r\n")
		message.WriteString("Content-Type: multipart/alternative; boundary=" + altBoundary + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		message.WriteString(textBody + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
		message.WriteString(cidHTML + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "--\r\n")
		for _, att := range attachments {
			message.WriteString("--" + relBoundary + "\r\n")
			message.WriteString("Content-Type: " + att.MimeType + "\r\n")
			message.WriteString("Content-Transfer-Encoding: base64\r\n")
			message.WriteString("Content-ID: <" + att.CID + ">\r\n")
			message.WriteString("Content-Disposition: inline\r\n\r\n")
			b64 := base64.StdEncoding.EncodeToString(att.Data)
			for i := 0; i < len(b64); i += 76 {
				end := i + 76
				if end > len(b64) {
					end = len(b64)
				}
				message.WriteString(b64[i:end] + "\r\n")
			}
		}
		message.WriteString("--" + relBoundary + "--\r\n")
	}

	envelopeSender := h.cfg.SMTPFrom
	if parsed, err := mail.ParseAddress(h.cfg.SMTPFrom); err == nil {
		envelopeSender = parsed.Address
	}

	var auth smtp.Auth
	switch {
	case h.cfg.SMTPXoauth2:
		if accessToken == "" {
			return fmt.Errorf("smtp xoauth2 enabled but no access token in context")
		}
		auth = xoauth2Auth{user: senderEmail, accessToken: accessToken}
	case h.cfg.SMTPUser != "":
		auth = smtp.PlainAuth("", h.cfg.SMTPUser, h.cfg.SMTPPass, h.cfg.SMTPHost)
	}

	addr := h.cfg.SMTPHost + ":" + h.cfg.SMTPPort
	return smtp.SendMail(addr, auth, envelopeSender, []string{recipient}, []byte(message.String()))
}

// sendSMTPBcc sends a single email with all recipients in BCC via SMTP.
func (h *Handler) sendSMTPBcc(recipients []string, subject, htmlBody, textBody, accessToken, senderEmail string) error {
	if len(recipients) == 0 {
		return nil
	}

	cidHTML, attachments, err := extractInlineDataImages(htmlBody)
	if err != nil {
		return fmt.Errorf("extract inline images: %w", err)
	}

	sanitizeHeader := func(v string) string {
		v = strings.ReplaceAll(v, "\r", "")
		v = strings.ReplaceAll(v, "\n", "")
		return v
	}

	message := strings.Builder{}
	message.WriteString("From: " + sanitizeHeader(h.cfg.SMTPFrom) + "\r\n")
	message.WriteString("Subject: " + sanitizeHeader(subject) + "\r\n")
	message.WriteString("MIME-Version: 1.0\r\n")

	altBoundary := fmt.Sprintf("alt-boundary-%d", time.Now().UnixNano())

	if len(attachments) == 0 {
		message.WriteString("Content-Type: multipart/alternative; boundary=" + altBoundary + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		message.WriteString(textBody + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
		message.WriteString(cidHTML + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "--\r\n")
	} else {
		relBoundary := fmt.Sprintf("rel-boundary-%d", time.Now().UnixNano())
		message.WriteString("Content-Type: multipart/related; boundary=" + relBoundary + "\r\n\r\n")
		message.WriteString("--" + relBoundary + "\r\n")
		message.WriteString("Content-Type: multipart/alternative; boundary=" + altBoundary + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		message.WriteString(textBody + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
		message.WriteString(cidHTML + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "--\r\n")
		for _, att := range attachments {
			message.WriteString("--" + relBoundary + "\r\n")
			message.WriteString("Content-Type: " + att.MimeType + "\r\n")
			message.WriteString("Content-Transfer-Encoding: base64\r\n")
			message.WriteString("Content-ID: <" + att.CID + ">\r\n")
			message.WriteString("Content-Disposition: inline\r\n\r\n")
			b64 := base64.StdEncoding.EncodeToString(att.Data)
			for i := 0; i < len(b64); i += 76 {
				end := i + 76
				if end > len(b64) {
					end = len(b64)
				}
				message.WriteString(b64[i:end] + "\r\n")
			}
		}
		message.WriteString("--" + relBoundary + "--\r\n")
	}

	envelopeSender := h.cfg.SMTPFrom
	if parsed, err := mail.ParseAddress(h.cfg.SMTPFrom); err == nil {
		envelopeSender = parsed.Address
	}

	var auth smtp.Auth
	switch {
	case h.cfg.SMTPXoauth2:
		if accessToken == "" {
			return fmt.Errorf("smtp xoauth2 enabled but no access token in context")
		}
		auth = xoauth2Auth{user: senderEmail, accessToken: accessToken}
	case h.cfg.SMTPUser != "":
		auth = smtp.PlainAuth("", h.cfg.SMTPUser, h.cfg.SMTPPass, h.cfg.SMTPHost)
	}

	addr := h.cfg.SMTPHost + ":" + h.cfg.SMTPPort
	return smtp.SendMail(addr, auth, envelopeSender, recipients, []byte(message.String()))
}

func (h *Handler) writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (h *Handler) writeError(w http.ResponseWriter, status int, message string) {
	h.writeJSON(w, status, map[string]string{"error": message})
}

// --- User preferences (saved icons) ---

const maxSavedIcons = 50

func (h *Handler) GetSavedIcons(w http.ResponseWriter, r *http.Request) {
	owner := resolveOwnerEmail(UserFromContext(r.Context()), "")
	if owner == "" {
		owner = "anonymous"
	}

	var doc struct {
		Icons []string `bson:"icons"`
	}
	err := h.userPrefs.FindOne(r.Context(), bson.M{"_id": owner}).Decode(&doc)
	if err != nil {
		// Not found → empty list
		h.writeJSON(w, http.StatusOK, map[string][]string{"icons": {}})
		return
	}
	if doc.Icons == nil {
		doc.Icons = []string{}
	}
	h.writeJSON(w, http.StatusOK, map[string][]string{"icons": doc.Icons})
}

func (h *Handler) PutSavedIcons(w http.ResponseWriter, r *http.Request) {
	owner := resolveOwnerEmail(UserFromContext(r.Context()), "")
	if owner == "" {
		owner = "anonymous"
	}

	var req struct {
		Icons []string `json:"icons"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	if len(req.Icons) > maxSavedIcons {
		req.Icons = req.Icons[:maxSavedIcons]
	}

	opts := options.Replace().SetUpsert(true)
	_, err := h.userPrefs.ReplaceOne(r.Context(), bson.M{"_id": owner}, bson.M{
		"_id":       owner,
		"icons":     req.Icons,
		"updatedAt": time.Now().UTC(),
	}, opts)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to save icons")
		return
	}

	h.writeJSON(w, http.StatusOK, map[string][]string{"icons": req.Icons})
}
