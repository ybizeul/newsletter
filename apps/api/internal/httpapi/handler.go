package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log"
	"net/http"
	"net/smtp"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"newsletter/api/internal/config"
	"newsletter/api/internal/model"

	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	gmhtml "github.com/yuin/goldmark/renderer/html"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type Handler struct {
	articles    *mongo.Collection
	newsletters *mongo.Collection
	cfg         config.Config
}

var errNewsletterAlreadySending = errors.New("newsletter is already sending")

func NewHandler(db *mongo.Database, cfg config.Config) *Handler {
	return &Handler{
		articles:    db.Collection("articles"),
		newsletters: db.Collection("newsletters"),
		cfg:         cfg,
	}
}

type createArticleRequest struct {
	AuthorID     string `json:"authorId"`
	Title        string `json:"title"`
	Markdown     string `json:"markdown"`
	TopicIcon    string `json:"topicIcon"`
	Illustration string `json:"illustration"`
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
		ID:           bson.NewObjectID().Hex(),
		AuthorID:     req.AuthorID,
		Title:        req.Title,
		Markdown:     req.Markdown,
		TopicIcon:    req.TopicIcon,
		Illustration: req.Illustration,
		Status:       model.ArticleStatusDraft,
		Version:      1,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	if _, err := h.articles.InsertOne(r.Context(), article); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to create article")
		return
	}

	h.writeJSON(w, http.StatusCreated, article)
}

func (h *Handler) ListArticles(w http.ResponseWriter, r *http.Request) {
	cursor, err := h.articles.Find(r.Context(), bson.M{})
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

	sort.Slice(articles, func(i, j int) bool {
		return articles[i].CreatedAt.After(articles[j].CreatedAt)
	})

	h.writeJSON(w, http.StatusOK, map[string]any{"items": articles})
}

type updateArticleRequest struct {
	Title        string `json:"title"`
	Markdown     string `json:"markdown"`
	TopicIcon    string `json:"topicIcon"`
	Illustration string `json:"illustration"`
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
			"title":        strings.TrimSpace(req.Title),
			"markdown":     req.Markdown,
			"topicIcon":    strings.TrimSpace(req.TopicIcon),
			"illustration": strings.TrimSpace(req.Illustration),
			"updatedAt":    time.Now().UTC(),
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

type createNewsletterRequest struct {
	CreatorID     string   `json:"creatorId"`
	Title         string   `json:"title"`
	IntroMarkdown string   `json:"introMarkdown"`
	ArticleIDs    []string `json:"articleIds"`
	RecipientIDs  []string `json:"recipientIds"`
}

type updateNewsletterRequest struct {
	Title         string   `json:"title"`
	IntroMarkdown string   `json:"introMarkdown"`
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

	now := time.Now().UTC()
	newsletter := model.Newsletter{
		ID:            bson.NewObjectID().Hex(),
		CreatorID:     req.CreatorID,
		Title:         req.Title,
		IntroMarkdown: req.IntroMarkdown,
		ArticleIDs:    req.ArticleIDs,
		RecipientIDs:  req.RecipientIDs,
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
	cursor, err := h.newsletters.Find(r.Context(), bson.M{})
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

	sort.Slice(newsletters, func(i, j int) bool {
		return newsletters[i].CreatedAt.After(newsletters[j].CreatedAt)
	})

	h.writeJSON(w, http.StatusOK, map[string]any{"items": newsletters})
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

	update := bson.M{
		"$set": bson.M{
			"title":         strings.TrimSpace(req.Title),
			"introMarkdown": req.IntroMarkdown,
			"articleIds":    req.ArticleIDs,
			"recipientIds":  req.RecipientIDs,
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

	htmlBody, textBody, err := h.renderNewsletter(*newsletter, articles)
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

	htmlBody, textBody, err := h.renderNewsletter(*loadedNewsletter, articles)
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

func (h *Handler) renderNewsletter(newsletter model.Newsletter, articles []model.Article) (string, string, error) {
	introHTML, err := renderMarkdownToSafeHTML(newsletter.IntroMarkdown)
	if err != nil {
		return "", "", err
	}
	introHTML = enforceImageFullWidth(introHTML)

	var body strings.Builder
	body.WriteString("<!doctype html><html><body style=\"font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111\">\n")
	body.WriteString("<div style=\"max-width:680px;margin:0 auto;padding:24px\">\n")
	body.WriteString("<section style=\"margin-bottom:28px\">" + introHTML + "</section>\n")

	var text strings.Builder
	text.WriteString(newsletter.IntroMarkdown + "\n\n")

	for _, article := range articles {
		articleHTML, err := renderMarkdownToSafeHTML(article.Markdown)
		if err != nil {
			return "", "", err
		}
		articleHTML = enforceImageFullWidth(articleHTML)
		hasIconIllustration := regexp.MustCompile(`(?i)^data:image/svg\+xml(?:;[^,]*)?,`).MatchString(article.Illustration)

		body.WriteString("<article style=\"margin-bottom:32px;border-top:1px solid #e5e7eb;padding-top:20px\">\n")
		if hasIconIllustration {
			body.WriteString("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-collapse:collapse;margin:0 0 8px;width:100%\"><tr>")
			body.WriteString("<td style=\"width:40px;vertical-align:middle;padding:0 10px 0 0\"><img src=\"" + html.EscapeString(article.Illustration) + "\" alt=\"\" width=\"40\" height=\"40\" style=\"display:block;width:40px;height:40px;border-radius:9999px\" /></td>")
			body.WriteString("<td style=\"vertical-align:middle\"><h2 style=\"margin:0;font-size:20px;line-height:1.3\">" + html.EscapeString(article.Title) + "</h2></td>")
			body.WriteString("</tr></table>\n")
		} else {
			body.WriteString("<h2 style=\"margin:0 0 8px;font-size:20px;line-height:1.3\">" + html.EscapeString(article.Title) + "</h2>\n")
		}
		if article.Illustration != "" && !hasIconIllustration {
			body.WriteString("<p style=\"margin:12px 0\"><img src=\"" + html.EscapeString(article.Illustration) + "\" alt=\"" + html.EscapeString(article.Title) + "\" style=\"max-width:100%;width:100%;height:auto;display:block;margin:0 auto;float:none;border-radius:8px\" /></p>\n")
		}
		body.WriteString(articleHTML + "\n")
		body.WriteString("</article>\n")

		text.WriteString(article.Title + "\n")
		text.WriteString(article.Markdown + "\n\n")
	}

	body.WriteString("</div></body></html>")
	return body.String(), strings.TrimSpace(text.String()), nil
}

func enforceImageFullWidth(input string) string {
	re := regexp.MustCompile(`(?i)<img\b([^>]*)>`)

	return re.ReplaceAllStringFunc(input, func(tag string) string {
		styleRe := regexp.MustCompile(`(?i)style\s*=\s*"([^"]*)"`)
		if matches := styleRe.FindStringSubmatch(tag); len(matches) == 2 {
			styleValue := strings.TrimSpace(matches[1])
			if styleValue != "" && !strings.HasSuffix(styleValue, ";") {
				styleValue += ";"
			}
			styleValue += "max-width:100%;width:100%;height:auto;display:block;margin:0 auto;float:none;"
			return styleRe.ReplaceAllString(tag, `style="`+styleValue+`"`)
		}

		return strings.Replace(tag, "<img", `<img style="max-width:100%;width:100%;height:auto;display:block;margin:0 auto;float:none;"`, 1)
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
	policy.AllowAttrs("style").OnElements("p", "img")
	policy.AllowStyles("text-align").OnElements("p")
	policy.AllowElements("table", "thead", "tbody", "tfoot", "tr", "th", "td")
	policy.AllowAttrs("align", "colspan", "rowspan").OnElements("th", "td")

	return policy.Sanitize(raw.String()), nil
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

	processedHTML, attachments, err := extractInlineDataImages(htmlBody)
	if err != nil {
		return err
	}

	message := strings.Builder{}
	message.WriteString("From: " + h.cfg.SMTPFrom + "\r\n")
	message.WriteString("To: " + recipient + "\r\n")
	message.WriteString("Subject: " + subject + "\r\n")
	message.WriteString("MIME-Version: 1.0\r\n")

	if len(attachments) == 0 {
		altBoundary := fmt.Sprintf("alt-boundary-%d", time.Now().UnixNano())
		message.WriteString("Content-Type: multipart/alternative; boundary=" + altBoundary + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		message.WriteString(textBody + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
		message.WriteString(processedHTML + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "--\r\n")
	} else {
		relatedBoundary := fmt.Sprintf("related-boundary-%d", time.Now().UnixNano())
		altBoundary := fmt.Sprintf("alt-boundary-%d", time.Now().UnixNano())

		message.WriteString("Content-Type: multipart/related; boundary=" + relatedBoundary + "\r\n\r\n")
		message.WriteString("--" + relatedBoundary + "\r\n")
		message.WriteString("Content-Type: multipart/alternative; boundary=" + altBoundary + "\r\n\r\n")

		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		message.WriteString(textBody + "\r\n\r\n")

		message.WriteString("--" + altBoundary + "\r\n")
		message.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
		message.WriteString(processedHTML + "\r\n\r\n")
		message.WriteString("--" + altBoundary + "--\r\n")

		for _, attachment := range attachments {
			encoded := base64.StdEncoding.EncodeToString(attachment.Data)
			message.WriteString("--" + relatedBoundary + "\r\n")
			message.WriteString("Content-Type: " + attachment.MimeType + "\r\n")
			message.WriteString("Content-Transfer-Encoding: base64\r\n")
			message.WriteString("Content-ID: <" + attachment.CID + ">\r\n")
			message.WriteString("Content-Disposition: inline\r\n\r\n")

			for i := 0; i < len(encoded); i += 76 {
				end := i + 76
				if end > len(encoded) {
					end = len(encoded)
				}
				message.WriteString(encoded[i:end] + "\r\n")
			}
			message.WriteString("\r\n")
		}

		message.WriteString("--" + relatedBoundary + "--\r\n")
	}

	auth := smtp.PlainAuth("", h.cfg.SMTPUser, h.cfg.SMTPPass, h.cfg.SMTPHost)
	addr := h.cfg.SMTPHost + ":" + h.cfg.SMTPPort

	if h.cfg.SMTPUser == "" {
		auth = nil
	}

	return smtp.SendMail(addr, auth, h.cfg.SMTPFrom, []string{recipient}, []byte(message.String()))
}

func (h *Handler) writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (h *Handler) writeError(w http.ResponseWriter, status int, message string) {
	h.writeJSON(w, status, map[string]string{"error": message})
}

func (h *Handler) GetRuntimeConfig(w http.ResponseWriter, _ *http.Request) {
	h.writeJSON(w, http.StatusOK, map[string]any{
		"smtpConfigured": h.cfg.SMTPHost != "" && h.cfg.SMTPFrom != "",
	})
}
