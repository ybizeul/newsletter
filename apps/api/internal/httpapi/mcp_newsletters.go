package httpapi

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"newsletter/api/internal/model"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func (h *Handler) registerMCPNewsletterTools(server *mcp.Server, readOnly, write, remove *mcp.ToolAnnotations) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "search_newsletters",
		Description: "Search newsletters visible to the authenticated user. Returns at most 20 summaries with id, title, preview, language, status, article ids, and updated time.",
		Annotations: readOnly,
	}, h.mcpSearchNewsletters)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_newsletter",
		Description: "Read one newsletter by id when the visibility rules allow it.",
		Annotations: readOnly,
	}, h.mcpGetNewsletter)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "create_newsletter",
		Description: "Create a private draft newsletter. Title is required. Language defaults to fr. Owner and creator are taken from the access token.",
		Annotations: write,
	}, h.mcpCreateNewsletter)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "update_newsletter",
		Description: "Update a newsletter the caller owns. Title is required. Omitted fields stay unchanged. Status, schedule, archive, and public link cannot be changed.",
		Annotations: write,
	}, h.mcpUpdateNewsletter)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delete_newsletter",
		Description: "Delete a newsletter the caller owns.",
		Annotations: remove,
	}, h.mcpDeleteNewsletter)
}

type mcpSearchNewslettersInput struct {
	Query    string `json:"query,omitempty" jsonschema:"optional text matched against title, intro, and footer"`
	Status   string `json:"status,omitempty" jsonschema:"optional status filter: draft, scheduled, sending, sent, or failed"`
	Language string `json:"language,omitempty" jsonschema:"optional edition language such as en or fr"`
}

type mcpNewsletterSummary struct {
	ID         string   `json:"id" jsonschema:"newsletter id"`
	Title      string   `json:"title" jsonschema:"newsletter title"`
	Preview    string   `json:"preview" jsonschema:"short plain-text preview of the intro"`
	Language   string   `json:"language" jsonschema:"edition language code"`
	Status     string   `json:"status" jsonschema:"draft, scheduled, sending, sent, or failed"`
	ArticleIDs []string `json:"articleIds" jsonschema:"article ids in display order"`
	UpdatedAt  string   `json:"updatedAt" jsonschema:"last update time in RFC3339"`
}

type mcpSearchNewslettersOutput struct {
	Newsletters []mcpNewsletterSummary `json:"newsletters" jsonschema:"matching newsletters visible to the caller"`
}

type mcpGetNewsletterInput struct {
	ID string `json:"id" jsonschema:"newsletter id"`
}

type mcpNewsletterDetail struct {
	ID              string   `json:"id" jsonschema:"newsletter id"`
	Title           string   `json:"title" jsonschema:"newsletter title"`
	Language        string   `json:"language" jsonschema:"edition language code"`
	Template        string   `json:"template" jsonschema:"template name"`
	IntroMarkdown   string   `json:"introMarkdown" jsonschema:"intro markdown"`
	FooterMarkdown  string   `json:"footerMarkdown" jsonschema:"footer markdown"`
	ArticleIDs      []string `json:"articleIds" jsonschema:"article ids in display order"`
	IncludeIndex    bool     `json:"includeIndex" jsonschema:"whether the newsletter includes a table of contents"`
	ContactTags     []string `json:"contactTags" jsonschema:"contact tags used to choose recipients"`
	ContactTagsMode string   `json:"contactTagsMode" jsonschema:"any or all"`
	RecipientIDs    []string `json:"recipientIds" jsonschema:"recipient email addresses"`
	Status          string   `json:"status" jsonschema:"draft, scheduled, sending, sent, or failed"`
	UpdatedAt       string   `json:"updatedAt" jsonschema:"last update time in RFC3339"`
}

type mcpCreateNewsletterInput struct {
	Title           string   `json:"title" jsonschema:"newsletter title"`
	Language        string   `json:"language,omitempty" jsonschema:"optional edition language such as en or fr. Defaults to fr"`
	Template        string   `json:"template,omitempty" jsonschema:"optional template name. Defaults to default"`
	IntroMarkdown   string   `json:"introMarkdown,omitempty" jsonschema:"optional intro markdown"`
	FooterMarkdown  string   `json:"footerMarkdown,omitempty" jsonschema:"optional footer markdown"`
	ArticleIDs      []string `json:"articleIds,omitempty" jsonschema:"optional article ids in display order"`
	IncludeIndex    bool     `json:"includeIndex,omitempty" jsonschema:"optional; include a table of contents"`
	ContactTags     []string `json:"contactTags,omitempty" jsonschema:"optional contact tags used to choose recipients"`
	ContactTagsMode string   `json:"contactTagsMode,omitempty" jsonschema:"optional tag match mode: any or all"`
	RecipientIDs    []string `json:"recipientIds,omitempty" jsonschema:"optional recipient email addresses"`
}

type mcpUpdateNewsletterInput struct {
	ID              string    `json:"id" jsonschema:"newsletter id"`
	Title           string    `json:"title" jsonschema:"newsletter title"`
	Language        *string   `json:"language,omitempty" jsonschema:"optional edition language such as en or fr"`
	Template        *string   `json:"template,omitempty" jsonschema:"optional template name"`
	IntroMarkdown   *string   `json:"introMarkdown,omitempty" jsonschema:"optional intro markdown"`
	FooterMarkdown  *string   `json:"footerMarkdown,omitempty" jsonschema:"optional footer markdown"`
	ArticleIDs      *[]string `json:"articleIds,omitempty" jsonschema:"optional article ids in display order"`
	IncludeIndex    *bool     `json:"includeIndex,omitempty" jsonschema:"optional; include a table of contents"`
	ContactTags     *[]string `json:"contactTags,omitempty" jsonschema:"optional contact tags used to choose recipients"`
	ContactTagsMode *string   `json:"contactTagsMode,omitempty" jsonschema:"optional tag match mode: any or all"`
	RecipientIDs    *[]string `json:"recipientIds,omitempty" jsonschema:"optional recipient email addresses"`
}

func (h *Handler) mcpSearchNewsletters(ctx context.Context, _ *mcp.CallToolRequest, in mcpSearchNewslettersInput) (*mcp.CallToolResult, mcpSearchNewslettersOutput, error) {
	out := mcpSearchNewslettersOutput{Newsletters: []mcpNewsletterSummary{}}
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	status, err := parseMCPNewsletterStatus(in.Status)
	if err != nil {
		return nil, out, err
	}
	language, err := parseMCPLanguage(in.Language, "")
	if err != nil {
		return nil, out, err
	}
	if err := h.mcpNewslettersReady(); err != nil {
		return nil, out, err
	}

	cursor, err := h.newsletters.Find(ctx, mcpVisibleNewsletterFilter(user, status), options.Find().SetSort(bson.D{{Key: "updatedAt", Value: -1}}))
	if err != nil {
		log.Printf("mcp search newsletters: %v", err)
		return nil, out, fmt.Errorf("failed to search newsletters")
	}
	defer cursor.Close(ctx)

	var newsletters []model.Newsletter
	if err := cursor.All(ctx, &newsletters); err != nil {
		log.Printf("mcp search newsletters: %v", err)
		return nil, out, fmt.Errorf("failed to search newsletters")
	}

	query := strings.TrimSpace(in.Query)
	for _, newsletter := range newsletters {
		if language != "" && normalizeArticleLanguage(string(newsletter.Language), "") != language {
			continue
		}
		if !mcpNewsletterMatchesQuery(newsletter, query) {
			continue
		}
		out.Newsletters = append(out.Newsletters, mcpNewsletterSummary{
			ID:         newsletter.ID,
			Title:      newsletter.Title,
			Preview:    contentPreview(newsletter.IntroMarkdown, newsletter.IntroHTML, 3, 180),
			Language:   string(newsletter.Language),
			Status:     string(newsletter.Status),
			ArticleIDs: mcpStringList(newsletter.ArticleIDs),
			UpdatedAt:  newsletter.UpdatedAt.UTC().Format(time.RFC3339),
		})
		if len(out.Newsletters) >= mcpSearchLimit {
			break
		}
	}
	return nil, out, nil
}

func (h *Handler) mcpGetNewsletter(ctx context.Context, _ *mcp.CallToolRequest, in mcpGetNewsletterInput) (*mcp.CallToolResult, mcpNewsletterDetail, error) {
	var out mcpNewsletterDetail
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	id := strings.TrimSpace(in.ID)
	if id == "" {
		return nil, out, fmt.Errorf("id is required")
	}
	if err := h.mcpNewslettersReady(); err != nil {
		return nil, out, err
	}
	newsletter, err := h.mcpVisibleNewsletter(ctx, user, id)
	if err != nil {
		return nil, out, err
	}
	return nil, mcpNewsletterDetailFrom(newsletter), nil
}

func (h *Handler) mcpCreateNewsletter(ctx context.Context, _ *mcp.CallToolRequest, in mcpCreateNewsletterInput) (*mcp.CallToolResult, mcpNewsletterDetail, error) {
	var out mcpNewsletterDetail
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	newsletter, err := newMCPDraftNewsletter(user, in, time.Now())
	if err != nil {
		return nil, out, err
	}
	if err := h.mcpNewslettersReady(); err != nil {
		return nil, out, err
	}
	if _, err := h.newsletters.InsertOne(ctx, newsletter); err != nil {
		log.Printf("mcp create newsletter: %v", err)
		return nil, out, fmt.Errorf("failed to create newsletter")
	}
	return nil, mcpNewsletterDetailFrom(newsletter), nil
}

func (h *Handler) mcpUpdateNewsletter(ctx context.Context, _ *mcp.CallToolRequest, in mcpUpdateNewsletterInput) (*mcp.CallToolResult, mcpNewsletterDetail, error) {
	var out mcpNewsletterDetail
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	id := strings.TrimSpace(in.ID)
	if id == "" {
		return nil, out, fmt.Errorf("id is required")
	}
	if strings.TrimSpace(in.Title) == "" {
		return nil, out, fmt.Errorf("title is required")
	}
	if err := h.mcpNewslettersReady(); err != nil {
		return nil, out, err
	}
	existing, err := h.mcpVisibleNewsletter(ctx, user, id)
	if err != nil {
		return nil, out, err
	}
	if !mcpCallerOwns(user, existing.Owner) {
		return nil, out, fmt.Errorf("only the owner can update this newsletter")
	}
	updated, err := applyMCPNewsletterUpdate(existing, in, time.Now())
	if err != nil {
		return nil, out, err
	}
	set := bson.M{
		"title":           updated.Title,
		"language":        updated.Language,
		"template":        updated.Template,
		"introMarkdown":   updated.IntroMarkdown,
		"introHTML":       updated.IntroHTML,
		"footerMarkdown":  updated.FooterMarkdown,
		"footerHTML":      updated.FooterHTML,
		"includeIndex":    updated.IncludeIndex,
		"articleIds":      mcpStringList(updated.ArticleIDs),
		"recipientIds":    mcpStringList(updated.RecipientIDs),
		"contactTags":     mcpStringList(updated.ContactTags),
		"contactTagsMode": updated.ContactTagsMode,
		"updatedAt":       updated.UpdatedAt,
	}
	result, err := h.newsletters.UpdateOne(ctx, bson.M{"_id": existing.ID, "owner": existing.Owner}, bson.M{"$set": set})
	if err != nil {
		log.Printf("mcp update newsletter: %v", err)
		return nil, out, fmt.Errorf("failed to update newsletter")
	}
	if result.MatchedCount == 0 {
		return nil, out, fmt.Errorf("newsletter not found")
	}
	return nil, mcpNewsletterDetailFrom(updated), nil
}

func (h *Handler) mcpDeleteNewsletter(ctx context.Context, _ *mcp.CallToolRequest, in mcpDeleteInput) (*mcp.CallToolResult, mcpDeleteOutput, error) {
	var out mcpDeleteOutput
	user, err := mcpCaller(ctx)
	if err != nil {
		return nil, out, err
	}
	id := strings.TrimSpace(in.ID)
	if id == "" {
		return nil, out, fmt.Errorf("id is required")
	}
	if err := h.mcpNewslettersReady(); err != nil {
		return nil, out, err
	}
	newsletter, err := h.mcpVisibleNewsletter(ctx, user, id)
	if err != nil {
		return nil, out, err
	}
	if !mcpCallerOwns(user, newsletter.Owner) {
		return nil, out, fmt.Errorf("only the owner can delete this newsletter")
	}
	result, err := h.newsletters.DeleteOne(ctx, bson.M{"_id": newsletter.ID, "owner": newsletter.Owner})
	if err != nil {
		log.Printf("mcp delete newsletter: %v", err)
		return nil, out, fmt.Errorf("failed to delete newsletter")
	}
	if result.DeletedCount == 0 {
		return nil, out, fmt.Errorf("newsletter not found")
	}
	return nil, mcpDeleteOutput{ID: newsletter.ID, Deleted: true}, nil
}

func (h *Handler) mcpNewslettersReady() error {
	if h == nil || h.newsletters == nil {
		return fmt.Errorf("newsletter store unavailable")
	}
	return nil
}

func (h *Handler) mcpVisibleNewsletter(ctx context.Context, user *User, id string) (model.Newsletter, error) {
	var newsletter model.Newsletter
	err := h.newsletters.FindOne(ctx, mcpVisibleNewsletterByIDFilter(user, id)).Decode(&newsletter)
	if err == mongo.ErrNoDocuments {
		return model.Newsletter{}, fmt.Errorf("newsletter not found")
	}
	if err != nil {
		log.Printf("mcp fetch newsletter: %v", err)
		return model.Newsletter{}, fmt.Errorf("failed to fetch newsletter")
	}
	return newsletter, nil
}

func mcpVisibleNewsletterFilter(user *User, status model.NewsletterStatus) bson.M {
	visibility := newsletterVisibilityFilter(user)
	if status == "" {
		return visibility
	}
	return bson.M{"$and": []bson.M{
		visibility,
		{"status": status},
	}}
}

func mcpVisibleNewsletterByIDFilter(user *User, id string) bson.M {
	return bson.M{
		"_id":  id,
		"$and": []bson.M{newsletterVisibilityFilter(user)},
	}
}

func newMCPDraftNewsletter(user *User, in mcpCreateNewsletterInput, now time.Time) (model.Newsletter, error) {
	if user == nil || strings.TrimSpace(user.ID) == "" || resolveOwnerEmail(user, "") == "" {
		return model.Newsletter{}, fmt.Errorf("not authenticated")
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return model.Newsletter{}, fmt.Errorf("title is required")
	}
	language, err := parseMCPLanguage(in.Language, model.LanguageFrench)
	if err != nil {
		return model.Newsletter{}, err
	}
	template, err := validateNewsletterTemplateName(in.Template)
	if err != nil {
		return model.Newsletter{}, err
	}
	introHTML, err := renderMarkdownToSafeHTML(in.IntroMarkdown)
	if err != nil {
		return model.Newsletter{}, fmt.Errorf("failed to render markdown")
	}
	footerHTML, err := renderMarkdownToSafeHTML(in.FooterMarkdown)
	if err != nil {
		return model.Newsletter{}, fmt.Errorf("failed to render markdown")
	}
	recipients, err := normalizeRecipientIDs(in.RecipientIDs)
	if err != nil {
		return model.Newsletter{}, err
	}
	mode, err := parseMCPContactTagsMode(in.ContactTagsMode)
	if err != nil {
		return model.Newsletter{}, err
	}
	now = now.UTC()
	tags := normalizeContactTags(in.ContactTags)
	if tags == nil {
		tags = []string{}
	}
	return model.Newsletter{
		ID:              bson.NewObjectID().Hex(),
		CreatorID:       user.ID,
		Owner:           resolveOwnerEmail(user, ""),
		Title:           title,
		Language:        language,
		Template:        template,
		PublicLink:      false,
		IntroMarkdown:   in.IntroMarkdown,
		IntroHTML:       introHTML,
		FooterMarkdown:  in.FooterMarkdown,
		FooterHTML:      footerHTML,
		IncludeIndex:    in.IncludeIndex,
		ArticleIDs:      mcpArticleIDs(in.ArticleIDs),
		RecipientIDs:    recipients,
		ContactTags:     tags,
		ContactTagsMode: mode,
		Status:          model.NewsletterStatusDraft,
		CreatedAt:       now,
		UpdatedAt:       now,
	}, nil
}

func applyMCPNewsletterUpdate(existing model.Newsletter, in mcpUpdateNewsletterInput, now time.Time) (model.Newsletter, error) {
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return model.Newsletter{}, fmt.Errorf("title is required")
	}
	existing.Title = title
	existing.UpdatedAt = now.UTC()
	if in.Language != nil {
		language, err := parseMCPLanguage(*in.Language, model.LanguageFrench)
		if err != nil {
			return model.Newsletter{}, err
		}
		existing.Language = language
	}
	if in.Template != nil {
		template, err := validateNewsletterTemplateName(*in.Template)
		if err != nil {
			return model.Newsletter{}, err
		}
		existing.Template = template
	}
	if in.IntroMarkdown != nil {
		html, err := renderMarkdownToSafeHTML(*in.IntroMarkdown)
		if err != nil {
			return model.Newsletter{}, fmt.Errorf("failed to render markdown")
		}
		existing.IntroMarkdown = *in.IntroMarkdown
		existing.IntroHTML = html
	}
	if in.FooterMarkdown != nil {
		html, err := renderMarkdownToSafeHTML(*in.FooterMarkdown)
		if err != nil {
			return model.Newsletter{}, fmt.Errorf("failed to render markdown")
		}
		existing.FooterMarkdown = *in.FooterMarkdown
		existing.FooterHTML = html
	}
	if in.ArticleIDs != nil {
		existing.ArticleIDs = mcpArticleIDs(*in.ArticleIDs)
	}
	if in.IncludeIndex != nil {
		existing.IncludeIndex = *in.IncludeIndex
	}
	if in.ContactTags != nil {
		tags := normalizeContactTags(*in.ContactTags)
		if tags == nil {
			tags = []string{}
		}
		existing.ContactTags = tags
	}
	if in.ContactTagsMode != nil {
		mode, err := parseMCPContactTagsMode(*in.ContactTagsMode)
		if err != nil {
			return model.Newsletter{}, err
		}
		existing.ContactTagsMode = mode
	}
	if in.RecipientIDs != nil {
		recipients, err := normalizeRecipientIDs(*in.RecipientIDs)
		if err != nil {
			return model.Newsletter{}, err
		}
		existing.RecipientIDs = recipients
	}
	return existing, nil
}

func mcpNewsletterDetailFrom(item model.Newsletter) mcpNewsletterDetail {
	mode := strings.TrimSpace(item.ContactTagsMode)
	if mode == "" {
		mode = "any"
	}
	return mcpNewsletterDetail{
		ID:              item.ID,
		Title:           item.Title,
		Language:        string(item.Language),
		Template:        normalizeNewsletterTemplateName(item.Template),
		IntroMarkdown:   item.IntroMarkdown,
		FooterMarkdown:  item.FooterMarkdown,
		ArticleIDs:      mcpStringList(item.ArticleIDs),
		IncludeIndex:    item.IncludeIndex,
		ContactTags:     mcpStringList(item.ContactTags),
		ContactTagsMode: mode,
		RecipientIDs:    mcpStringList(item.RecipientIDs),
		Status:          string(item.Status),
		UpdatedAt:       item.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func mcpNewsletterMatchesQuery(item model.Newsletter, query string) bool {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return true
	}
	if strings.Contains(strings.ToLower(item.Title), query) {
		return true
	}
	if strings.Contains(strings.ToLower(item.IntroMarkdown), query) {
		return true
	}
	if strings.Contains(strings.ToLower(item.FooterMarkdown), query) {
		return true
	}
	preview := contentPreview(item.IntroMarkdown, item.IntroHTML, 3, 180)
	return strings.Contains(strings.ToLower(preview), query)
}

func mcpArticleIDs(ids []string) []string {
	if len(ids) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func parseMCPNewsletterStatus(raw string) (model.NewsletterStatus, error) {
	switch status := model.NewsletterStatus(strings.ToLower(strings.TrimSpace(raw))); status {
	case "":
		return "", nil
	case model.NewsletterStatusDraft, model.NewsletterStatusScheduled, model.NewsletterStatusSending, model.NewsletterStatusSent, model.NewsletterStatusFailed:
		return status, nil
	default:
		return "", fmt.Errorf("status must be draft, scheduled, sending, sent, or failed")
	}
}

func parseMCPContactTagsMode(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "any":
		return "any", nil
	case "all":
		return "all", nil
	default:
		return "", fmt.Errorf("contactTagsMode must be any or all")
	}
}
