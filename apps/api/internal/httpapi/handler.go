package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"image"
	"image/png"
	"log"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"regexp"
	"sort"
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
	articles    *mongo.Collection
	headers     *mongo.Collection
	newsletters *mongo.Collection
	cfg         config.Config
}

var errNewsletterAlreadySending = errors.New("newsletter is already sending")

const maxNewsletterRecipients = 3

func NewHandler(db *mongo.Database, cfg config.Config) *Handler {
	return &Handler{
		articles:    db.Collection("articles"),
		headers:     db.Collection("headers"),
		newsletters: db.Collection("newsletters"),
		cfg:         cfg,
	}
}

type createArticleRequest struct {
	AuthorID        string   `json:"authorId"`
	Title           string   `json:"title"`
	Markdown        string   `json:"markdown"`
	Tags            []string `json:"tags"`
	TopicIcon       string   `json:"topicIcon"`
	Illustration    string   `json:"illustration"`
	IconSource      string   `json:"iconSource"`
	IconZoom        int      `json:"iconZoom"`
	IconBgColor     string   `json:"iconBgColor"`
	IconStrokeColor string   `json:"iconStrokeColor"`
}

type articleSummary struct {
	ID           string              `json:"id"`
	Title        string              `json:"title"`
	Tags         []string            `json:"tags,omitempty"`
	TopicIcon    string              `json:"topicIcon,omitempty"`
	Illustration string              `json:"illustration,omitempty"`
	SentCount    int64               `json:"sentCount"`
	LastUsed     *time.Time          `json:"lastUsed,omitempty"`
	Status       model.ArticleStatus `json:"status"`
	CreatedAt    time.Time           `json:"createdAt"`
	UpdatedAt    time.Time           `json:"updatedAt"`
	Preview      string              `json:"preview"`
}

type articleSummarySource struct {
	ID           string              `bson:"_id"`
	Title        string              `bson:"title"`
	Markdown     string              `bson:"markdown"`
	Tags         []string            `bson:"tags,omitempty"`
	TopicIcon    string              `bson:"topicIcon,omitempty"`
	Illustration string              `bson:"illustration,omitempty"`
	SentCount    int64               `bson:"sentCount"`
	LastUsed     *time.Time          `bson:"last_used,omitempty"`
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

	if req.AuthorID == "" || req.Title == "" {
		h.writeError(w, http.StatusBadRequest, "authorId and title are required")
		return
	}

	now := time.Now().UTC()
	article := model.Article{
		ID:              bson.NewObjectID().Hex(),
		AuthorID:        req.AuthorID,
		Title:           req.Title,
		Markdown:        req.Markdown,
		Tags:            normalizeArticleTags(req.Tags),
		TopicIcon:       req.TopicIcon,
		Illustration:    req.Illustration,
		IconSource:      strings.TrimSpace(req.IconSource),
		IconZoom:        normalizeIconZoom(req.IconZoom),
		IconBgColor:     strings.TrimSpace(req.IconBgColor),
		IconStrokeColor: strings.TrimSpace(req.IconStrokeColor),
		SentCount:       0,
		Status:          model.ArticleStatusDraft,
		Version:         1,
		CreatedAt:       now,
		UpdatedAt:       now,
	}

	if _, err := h.articles.InsertOne(r.Context(), article); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to create article")
		return
	}

	h.writeJSON(w, http.StatusCreated, article)
}

func (h *Handler) ListArticles(w http.ResponseWriter, r *http.Request) {
	findOptions := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})
	view := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("view")))

	if view != "full" {
		findOptions.SetProjection(bson.M{
			"title":        1,
			"markdown":     1,
			"tags":         1,
			"topicIcon":    1,
			"illustration": 1,
			"sentCount":    1,
			"last_used":    1,
			"status":       1,
			"createdAt":    1,
			"updatedAt":    1,
		})

		cursor, err := h.articles.Find(r.Context(), bson.M{}, findOptions)
		if err != nil {
			h.writeError(w, http.StatusInternalServerError, "failed to list articles")
			return
		}
		defer cursor.Close(r.Context())

		var rawItems []articleSummarySource
		if err := cursor.All(r.Context(), &rawItems); err != nil {
			h.writeError(w, http.StatusInternalServerError, "failed to decode articles")
			return
		}

		items := make([]articleSummary, 0, len(rawItems))
		for _, raw := range rawItems {
			items = append(items, articleSummary{
				ID:           raw.ID,
				Title:        raw.Title,
				Tags:         raw.Tags,
				TopicIcon:    raw.TopicIcon,
				Illustration: raw.Illustration,
				SentCount:    raw.SentCount,
				LastUsed:     raw.LastUsed,
				Status:       raw.Status,
				CreatedAt:    raw.CreatedAt,
				UpdatedAt:    raw.UpdatedAt,
				Preview:      markdownPreviewText(raw.Markdown, 3, 180),
			})
		}

		h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
		return
	}

	cursor, err := h.articles.Find(r.Context(), bson.M{}, findOptions)
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

	h.writeJSON(w, http.StatusOK, map[string]any{"items": articles})
}

func (h *Handler) GetArticle(w http.ResponseWriter, r *http.Request, id string) {
	var article model.Article
	if err := h.articles.FindOne(r.Context(), bson.M{"_id": id}).Decode(&article); err != nil {
		if err == mongo.ErrNoDocuments {
			h.writeError(w, http.StatusNotFound, "article not found")
			return
		}
		h.writeError(w, http.StatusInternalServerError, "failed to fetch article")
		return
	}

	h.writeJSON(w, http.StatusOK, article)
}

type updateArticleRequest struct {
	Title           string   `json:"title"`
	Markdown        string   `json:"markdown"`
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

	if req.Title == "" {
		h.writeError(w, http.StatusBadRequest, "title is required")
		return
	}

	update := bson.M{
		"$set": bson.M{
			"title":           strings.TrimSpace(req.Title),
			"markdown":        req.Markdown,
			"tags":            normalizeArticleTags(req.Tags),
			"topicIcon":       strings.TrimSpace(req.TopicIcon),
			"illustration":    strings.TrimSpace(req.Illustration),
			"iconSource":      strings.TrimSpace(req.IconSource),
			"iconZoom":        normalizeIconZoom(req.IconZoom),
			"iconBgColor":     strings.TrimSpace(req.IconBgColor),
			"iconStrokeColor": strings.TrimSpace(req.IconStrokeColor),
			"updatedAt":       time.Now().UTC(),
		},
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

	var article model.Article
	if err := h.articles.FindOne(r.Context(), bson.M{"_id": id}).Decode(&article); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to fetch updated article")
		return
	}

	h.writeJSON(w, http.StatusOK, article)
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

		key := strings.ToLower(recipient)
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
	result, err := h.articles.DeleteOne(r.Context(), bson.M{"_id": id})
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to delete article")
		return
	}
	if result.DeletedCount == 0 {
		h.writeError(w, http.StatusNotFound, "article not found")
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

	if strings.TrimSpace(req.CreatorID) == "" || strings.TrimSpace(req.Title) == "" {
		h.writeError(w, http.StatusBadRequest, "creatorId and title are required")
		return
	}

	now := time.Now().UTC()
	header := model.Header{
		ID:        bson.NewObjectID().Hex(),
		CreatorID: strings.TrimSpace(req.CreatorID),
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
	cursor, err := h.headers.Find(r.Context(), bson.M{})
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

	result, err := h.headers.UpdateByID(r.Context(), id, update)
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
	result, err := h.headers.DeleteOne(r.Context(), bson.M{"_id": id})
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
	CreatorID     string   `json:"creatorId"`
	Title         string   `json:"title"`
	HeaderID      string   `json:"headerId"`
	IntroMarkdown string   `json:"introMarkdown"`
	IncludeIndex  bool     `json:"includeIndex"`
	ArticleIDs    []string `json:"articleIds"`
	RecipientIDs  []string `json:"recipientIds"`
}

type updateNewsletterRequest struct {
	Title         string   `json:"title"`
	HeaderID      string   `json:"headerId"`
	IntroMarkdown string   `json:"introMarkdown"`
	IncludeIndex  bool     `json:"includeIndex"`
	ArticleIDs    []string `json:"articleIds"`
	RecipientIDs  []string `json:"recipientIds"`
}

func (h *Handler) CreateNewsletter(w http.ResponseWriter, r *http.Request) {
	var req createNewsletterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	if req.CreatorID == "" || req.Title == "" {
		h.writeError(w, http.StatusBadRequest, "creatorId and title are required")
		return
	}

	recipientIDs, err := normalizeRecipientIDs(req.RecipientIDs)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	now := time.Now().UTC()
	newsletter := model.Newsletter{
		ID:            bson.NewObjectID().Hex(),
		CreatorID:     req.CreatorID,
		Title:         req.Title,
		HeaderID:      strings.TrimSpace(req.HeaderID),
		IntroMarkdown: req.IntroMarkdown,
		IncludeIndex:  req.IncludeIndex,
		ArticleIDs:    req.ArticleIDs,
		RecipientIDs:  recipientIDs,
		IsFavorite:    false,
		Status:        model.NewsletterStatusDraft,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	if _, err := h.newsletters.InsertOne(r.Context(), newsletter); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to create newsletter")
		return
	}

	h.writeJSON(w, http.StatusCreated, newsletter)
}

func (h *Handler) ListNewsletters(w http.ResponseWriter, r *http.Request) {
	findOptions := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})

	if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("view")), "summary") {
		findOptions.SetProjection(bson.M{
			"title":         1,
			"headerId":      1,
			"introMarkdown": 1,
			"includeIndex":  1,
			"articleIds":    1,
			"recipientIds":  1,
			"isFavorite":    1,
			"status":        1,
			"deliveryError": 1,
			"scheduledAt":   1,
			"sentAt":        1,
			"createdAt":     1,
			"updatedAt":     1,
		})

		type newsletterSummarySource struct {
			ID            string                 `bson:"_id"`
			Title         string                 `bson:"title"`
			HeaderID      string                 `bson:"headerId,omitempty"`
			IntroMarkdown string                 `bson:"introMarkdown"`
			IncludeIndex  bool                   `bson:"includeIndex"`
			ArticleIDs    []string               `bson:"articleIds"`
			RecipientIDs  []string               `bson:"recipientIds"`
			IsFavorite    bool                   `bson:"isFavorite"`
			Status        model.NewsletterStatus `bson:"status"`
			DeliveryError string                 `bson:"deliveryError,omitempty"`
			ScheduledAt   *time.Time             `bson:"scheduledAt,omitempty"`
			SentAt        *time.Time             `bson:"sentAt,omitempty"`
			CreatedAt     time.Time              `bson:"createdAt"`
			UpdatedAt     time.Time              `bson:"updatedAt"`
		}

		type newsletterSummary struct {
			ID            string                 `json:"id"`
			Title         string                 `json:"title"`
			HeaderID      string                 `json:"headerId,omitempty"`
			IncludeIndex  bool                   `json:"includeIndex"`
			ArticleIDs    []string               `json:"articleIds"`
			RecipientIDs  []string               `json:"recipientIds"`
			IsFavorite    bool                   `json:"isFavorite"`
			Status        model.NewsletterStatus `json:"status"`
			DeliveryError string                 `json:"deliveryError,omitempty"`
			ScheduledAt   *time.Time             `json:"scheduledAt,omitempty"`
			SentAt        *time.Time             `json:"sentAt,omitempty"`
			CreatedAt     time.Time              `json:"createdAt"`
			UpdatedAt     time.Time              `json:"updatedAt"`
			Preview       string                 `json:"preview"`
		}

		cursor, err := h.newsletters.Find(r.Context(), bson.M{}, findOptions)
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
				Title:         raw.Title,
				HeaderID:      raw.HeaderID,
				IncludeIndex:  raw.IncludeIndex,
				ArticleIDs:    raw.ArticleIDs,
				RecipientIDs:  raw.RecipientIDs,
				IsFavorite:    raw.IsFavorite,
				Status:        raw.Status,
				DeliveryError: raw.DeliveryError,
				ScheduledAt:   raw.ScheduledAt,
				SentAt:        raw.SentAt,
				CreatedAt:     raw.CreatedAt,
				UpdatedAt:     raw.UpdatedAt,
				Preview:       markdownPreviewText(raw.IntroMarkdown, 3, 180),
			})
		}

		h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
		return
	}

	cursor, err := h.newsletters.Find(r.Context(), bson.M{}, findOptions)
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

	h.writeJSON(w, http.StatusOK, map[string]any{"items": newsletters})
}

func (h *Handler) GetNewsletter(w http.ResponseWriter, r *http.Request, id string) {
	var newsletter model.Newsletter
	if err := h.newsletters.FindOne(r.Context(), bson.M{"_id": id}).Decode(&newsletter); err != nil {
		if err == mongo.ErrNoDocuments {
			h.writeError(w, http.StatusNotFound, "newsletter not found")
			return
		}
		h.writeError(w, http.StatusInternalServerError, "failed to fetch newsletter")
		return
	}

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

	update := bson.M{
		"$set": bson.M{
			"title":         strings.TrimSpace(req.Title),
			"headerId":      strings.TrimSpace(req.HeaderID),
			"introMarkdown": req.IntroMarkdown,
			"includeIndex":  req.IncludeIndex,
			"articleIds":    req.ArticleIDs,
			"recipientIds":  recipientIDs,
			"updatedAt":     time.Now().UTC(),
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
		"smtpConfigured": h.cfg.SMTPHost != "" && h.cfg.SMTPFrom != "",
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
				"status":        model.NewsletterStatusFailed,
				"deliveryError": "previous sending state was reset by manual send",
				"updatedAt":     time.Now().UTC(),
			},
		})
	}

	if err := h.processScheduledNewsletter(r.Context(), newsletter); err != nil {
		if errors.Is(err, errNewsletterAlreadySending) {
			h.writeError(w, http.StatusConflict, "newsletter is already sending")
			return
		}

		log.Printf("send-now failed newsletter_id=%s error=%v", newsletter.ID, err)
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
	result, err := h.newsletters.DeleteOne(r.Context(), bson.M{"_id": id})
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
	if h.cfg.SMTPHost == "" || h.cfg.SMTPFrom == "" {
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

	htmlBody, textBody, err := h.renderNewsletter(ctx, *loadedNewsletter, articles)
	if err != nil {
		return err
	}

	for _, recipient := range loadedNewsletter.RecipientIDs {
		recipient = strings.TrimSpace(recipient)
		if recipient == "" {
			continue
		}
		log.Printf("smtp send start newsletter_id=%s recipient=%s smtp_host=%s smtp_port=%s", loadedNewsletter.ID, recipient, h.cfg.SMTPHost, h.cfg.SMTPPort)
		if err := h.sendSMTP(recipient, loadedNewsletter.Title, htmlBody, textBody); err != nil {
			log.Printf("smtp send failed newsletter_id=%s recipient=%s error=%v", loadedNewsletter.ID, recipient, err)
			return err
		}
		log.Printf("smtp send success newsletter_id=%s recipient=%s", loadedNewsletter.ID, recipient)
	}

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

func (h *Handler) renderNewsletter(ctx context.Context, newsletter model.Newsletter, articles []model.Article) (string, string, error) {
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

	introHTML, err := renderMarkdownToSafeHTML(newsletter.IntroMarkdown)
	if err != nil {
		return "", "", err
	}
	introHTML = enforceImageFullWidth(introHTML)

	var body strings.Builder
	body.WriteString("<!doctype html><html><body style=\"margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111\">\n")
	body.WriteString("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\" style=\"border-collapse:collapse;margin:0;padding:0;mso-table-lspace:0pt;mso-table-rspace:0pt;\">\n")
	body.WriteString("<tr><td align=\"center\" style=\"padding:24px 8px;mso-line-height-rule:exactly\">\n")
	body.WriteString("<!--[if mso]><table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"680\" align=\"center\" style=\"border-collapse:collapse;\"><tr><td width=\"680\" style=\"width:680px;\"><![endif]-->\n")
	body.WriteString("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\" align=\"center\" style=\"width:100%;max-width:680px;border-collapse:collapse;margin:0 auto;table-layout:fixed;mso-table-lspace:0pt;mso-table-rspace:0pt;\">\n")
	body.WriteString("<tr><td style=\"padding:0;text-align:left;width:100%;word-break:break-word;overflow-wrap:anywhere;\">\n")
	if headerHTML != "" {
		body.WriteString("<div style=\"margin-bottom:20px\">" + headerHTML + "</div>\n")
	}
	body.WriteString("<div style=\"margin-bottom:28px\">" + introHTML + "</div>\n")

	var text strings.Builder
	if headerText != "" {
		text.WriteString(headerText + "\n\n")
	}
	text.WriteString(newsletter.IntroMarkdown + "\n\n")

	if newsletter.IncludeIndex && len(articles) > 0 {
		body.WriteString("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\" style=\"margin:0 0 24px;border-collapse:collapse;background:#f1f3f5;border:1px solid #e9ecef\">\n")
		body.WriteString("<tr><td style=\"padding:14px 16px\">\n")
		body.WriteString("<p style=\"margin:0 0 10px;font-size:14px;line-height:20px;font-weight:700;color:#343a40\">In this issue</p>\n")
		body.WriteString("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\" style=\"border-collapse:collapse\">\n")
		for _, article := range articles {
			body.WriteString("<tr>")
			body.WriteString("<td style=\"width:16px;vertical-align:top;font-size:14px;line-height:20px;color:#343a40\">&bull;</td>")
			body.WriteString("<td style=\"vertical-align:top;font-size:14px;line-height:20px;color:#343a40;padding:0 0 6px\">" + html.EscapeString(article.Title) + "</td>")
			body.WriteString("</tr>\n")
		}
		body.WriteString("</table>\n")
		body.WriteString("</td></tr></table>\n")

		text.WriteString("In this issue\n")
		for _, article := range articles {
			text.WriteString("- " + article.Title + "\n")
		}
		text.WriteString("\n")
	}

	for _, article := range articles {
		articleHTML, err := renderMarkdownToSafeHTML(article.Markdown)
		if err != nil {
			return "", "", err
		}
		articleHTML = enforceImageFullWidth(articleHTML)
		illustration := strings.TrimSpace(article.Illustration)
		hasIconIllustration := strings.TrimSpace(article.IconSource) != "" ||
			regexp.MustCompile(`(?i)^data:image/(svg\+xml|png|jpeg|gif)(?:;[^,]*)?,`).MatchString(illustration)
		iconIllustration := illustration
		if hasIconIllustration {
			convertedPNG, convErr := convertSVGDataURLToPNGDataURL(illustration)
			if convErr != nil {
				log.Printf("icon svg->png conversion failed article_id=%s error=%v", article.ID, convErr)
			} else {
				iconIllustration = convertedPNG
			}
		}

		body.WriteString("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\" style=\"border-collapse:collapse;margin:0 0 20px;table-layout:fixed\"><tr><td style=\"border-top:1px solid #e5e7eb;font-size:0;line-height:0;height:0\">&nbsp;</td></tr></table>\n")
		body.WriteString("<div style=\"margin-bottom:32px\">\n")
		if hasIconIllustration {
			body.WriteString("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-collapse:collapse;table-layout:fixed;margin:0 0 8px;width:100%\"><tr>")
			body.WriteString("<td style=\"width:40px;vertical-align:middle\"><img src=\"" + html.EscapeString(iconIllustration) + "\" alt=\"\" width=\"40\" height=\"40\" style=\"display:block;width:40px;height:40px;border-radius:9999px\" /></td>")
			body.WriteString("<td style=\"width:10px;font-size:0;line-height:0\">&nbsp;</td>")
			body.WriteString("<td style=\"vertical-align:middle;word-break:break-word;overflow-wrap:anywhere;font-size:20px;line-height:26px;color:#111111;mso-line-height-rule:exactly;\"><b style=\"font-weight:700;mso-bidi-font-weight:bold;\">" + html.EscapeString(article.Title) + "</b></td>")
			body.WriteString("</tr></table>\n")
		} else {
			body.WriteString("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\" style=\"border-collapse:collapse;margin:0 0 8px;table-layout:fixed\"><tr><td style=\"vertical-align:middle;word-break:break-word;overflow-wrap:anywhere;font-size:20px;line-height:26px;color:#111111;mso-line-height-rule:exactly;\"><b style=\"font-weight:700;mso-bidi-font-weight:bold;\">" + html.EscapeString(article.Title) + "</b></td></tr></table>\n")
		}
		if illustration != "" && !hasIconIllustration {
			body.WriteString("<p style=\"margin:12px 0\"><img src=\"" + html.EscapeString(illustration) + "\" alt=\"" + html.EscapeString(article.Title) + "\" style=\"max-width:100%;width:100%;height:auto;display:block;margin:0 auto;float:none;border-radius:8px\" /></p>\n")
		}
		body.WriteString(articleHTML + "\n")
		body.WriteString("</div>\n")

		text.WriteString(article.Title + "\n")
		text.WriteString(article.Markdown + "\n\n")
	}

	body.WriteString("</td></tr></table>\n")
	body.WriteString("<!--[if mso]></td></tr></table><![endif]-->\n")
	body.WriteString("</td></tr></table></body></html>")
	htmlBody := convertSVGDataURLsInHTMLToPNG(body.String())
	return htmlBody, strings.TrimSpace(text.String()), nil
}

func convertSVGDataURLsInHTMLToPNG(input string) string {
	svgDataURIRe := regexp.MustCompile(`(?i)data:image/svg\+xml(?:;[^,]*)?,[^"'\s>)]+`)
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

func convertSVGDataURLToPNGDataURL(input string) (string, error) {
	trimmed := strings.TrimSpace(input)
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

	return re.ReplaceAllStringFunc(input, func(tag string) string {
		tag = widthAttrRe.ReplaceAllString(tag, "")
		tag = heightAttrRe.ReplaceAllString(tag, "")
		styleRe := regexp.MustCompile(`(?i)style\s*=\s*"([^"]*)"`)
		if matches := styleRe.FindStringSubmatch(tag); len(matches) == 2 {
			styleValue := strings.TrimSpace(matches[1])
			if styleValue != "" && !strings.HasSuffix(styleValue, ";") {
				styleValue += ";"
			}
			styleValue += "max-width:100%;width:100%;height:auto;display:block;margin:0 auto;float:none;"
			updated := styleRe.ReplaceAllString(tag, `style="`+styleValue+`"`)
			if !regexp.MustCompile(`(?i)\swidth\s*=`).MatchString(updated) {
				updated = strings.Replace(updated, ">", ` width="100%">`, 1)
			}
			return updated
		}

		updated := strings.Replace(tag, "<img", `<img style="max-width:100%;width:100%;height:auto;display:block;margin:0 auto;float:none;"`, 1)
		if !regexp.MustCompile(`(?i)\swidth\s*=`).MatchString(updated) {
			updated = strings.Replace(updated, ">", ` width="100%">`, 1)
		}
		return updated
	})
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
			styleValue += "max-width:100%;width:auto;height:auto;display:block;float:none;"
			return styleRe.ReplaceAllString(tag, `style="`+styleValue+`"`)
		}

		return strings.Replace(tag, "<img", `<img style="max-width:100%;width:auto;height:auto;display:block;float:none;"`, 1)
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

func (h *Handler) sendSMTP(recipient, subject, htmlBody, textBody string) error {
	if recipient == "" {
		return nil
	}

	message := strings.Builder{}
	message.WriteString("From: " + h.cfg.SMTPFrom + "\r\n")
	message.WriteString("To: " + recipient + "\r\n")
	message.WriteString("Subject: " + subject + "\r\n")
	message.WriteString("MIME-Version: 1.0\r\n")

	altBoundary := fmt.Sprintf("alt-boundary-%d", time.Now().UnixNano())
	message.WriteString("Content-Type: multipart/alternative; boundary=" + altBoundary + "\r\n\r\n")
	message.WriteString("--" + altBoundary + "\r\n")
	message.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
	message.WriteString(textBody + "\r\n\r\n")
	message.WriteString("--" + altBoundary + "\r\n")
	message.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
	message.WriteString(htmlBody + "\r\n\r\n")
	message.WriteString("--" + altBoundary + "--\r\n")

	envelopeSender := h.cfg.SMTPFrom
	if parsed, err := mail.ParseAddress(h.cfg.SMTPFrom); err == nil {
		envelopeSender = parsed.Address
	}

	auth := smtp.PlainAuth("", h.cfg.SMTPUser, h.cfg.SMTPPass, h.cfg.SMTPHost)
	addr := h.cfg.SMTPHost + ":" + h.cfg.SMTPPort

	if h.cfg.SMTPUser == "" {
		auth = nil
	}

	return smtp.SendMail(addr, auth, envelopeSender, []string{recipient}, []byte(message.String()))
}

func (h *Handler) writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (h *Handler) writeError(w http.ResponseWriter, status int, message string) {
	h.writeJSON(w, status, map[string]string{"error": message})
}
