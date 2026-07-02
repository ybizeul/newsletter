package httpapi

import (
	"context"
	"fmt"
	"html"
	"strings"
	"time"

	"newsletter/api/internal/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func normalizeArticleLanguage(raw string, fallback model.LanguageCode) model.LanguageCode {
	candidate := model.LanguageCode(strings.TrimSpace(strings.ToLower(raw)))
	if candidate == "" {
		return fallback
	}
	for _, supported := range model.SupportedArticleLanguages {
		if supported == candidate {
			return candidate
		}
	}
	return fallback
}

func defaultArticleLanguage(value model.LanguageCode) model.LanguageCode {
	if value == "" {
		return model.LanguageFrench
	}
	return normalizeArticleLanguage(string(value), model.LanguageFrench)
}

func (h *Handler) upsertArticleTranslation(ctx context.Context, articleID string, language model.LanguageCode, title string, markdown string, contentHTML string, now time.Time) error {
	lang := defaultArticleLanguage(language)
	filter := bson.M{"articleId": articleID, "language": lang}
	update := bson.M{
		"$set": bson.M{
			"title":       strings.TrimSpace(title),
			"markdown":    markdown,
			"contentHTML": contentHTML,
			"updatedAt":   now,
		},
		"$setOnInsert": bson.M{
			"_id":       bson.NewObjectID().Hex(),
			"articleId": articleID,
			"language":  lang,
			"createdAt": now,
		},
	}
	_, err := h.articleTranslations.UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
	return err
}

func (h *Handler) deleteArticleTranslation(ctx context.Context, articleID string, language model.LanguageCode) error {
	lang := defaultArticleLanguage(language)
	_, err := h.articleTranslations.DeleteOne(ctx, bson.M{"articleId": articleID, "language": lang})
	return err
}

func isBlankArticleTranslationInput(title, markdown, contentHTML string) bool {
	if strings.TrimSpace(title) != "" {
		return false
	}
	if strings.TrimSpace(markdown) != "" {
		return false
	}
	text := html.UnescapeString(stripHTMLTags(contentHTML))
	text = strings.ReplaceAll(text, "\u00a0", " ")
	return strings.TrimSpace(text) == ""
}

func (h *Handler) loadArticleTranslations(ctx context.Context, articleIDs []string) (map[string]map[model.LanguageCode]model.ArticleTranslation, error) {
	result := make(map[string]map[model.LanguageCode]model.ArticleTranslation)
	if len(articleIDs) == 0 {
		return result, nil
	}

	cursor, err := h.articleTranslations.Find(ctx, bson.M{"articleId": bson.M{"$in": articleIDs}})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var rows []model.ArticleTranslation
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}

	for _, row := range rows {
		if _, ok := result[row.ArticleID]; !ok {
			result[row.ArticleID] = make(map[model.LanguageCode]model.ArticleTranslation)
		}
		result[row.ArticleID][defaultArticleLanguage(row.Language)] = row
	}

	return result, nil
}

func isBlankArticleTranslation(translation model.ArticleTranslation) bool {
	return strings.TrimSpace(translation.Title) == "" &&
		strings.TrimSpace(translation.Markdown) == "" &&
		strings.TrimSpace(translation.ContentHTML) == ""
}

func pickArticleTranslation(byLang map[model.LanguageCode]model.ArticleTranslation, preferred model.LanguageCode, strictPreferred bool, secondaryFallback model.LanguageCode) (model.ArticleTranslation, bool) {
	if len(byLang) == 0 {
		return model.ArticleTranslation{}, false
	}

	preferredTranslation, hasPreferred := byLang[preferred]
	secondaryTranslation, hasSecondary := byLang[secondaryFallback]

	if preferred != "" {
		if hasPreferred {
			if !isBlankArticleTranslation(preferredTranslation) || strictPreferred {
				return preferredTranslation, true
			}
		}
		if strictPreferred {
			return model.ArticleTranslation{}, false
		}
	}
	if secondaryFallback != "" {
		if hasSecondary && !isBlankArticleTranslation(secondaryTranslation) {
			return secondaryTranslation, true
		}
	}
	for _, supported := range model.SupportedArticleLanguages {
		if translation, ok := byLang[supported]; ok {
			if isBlankArticleTranslation(translation) {
				continue
			}
			return translation, true
		}
	}

	if preferred != "" && hasPreferred {
		return preferredTranslation, true
	}
	if secondaryFallback != "" && hasSecondary {
		return secondaryTranslation, true
	}
	for _, supported := range model.SupportedArticleLanguages {
		if translation, ok := byLang[supported]; ok {
			return translation, true
		}
	}
	for _, translation := range byLang {
		return translation, true
	}

	return model.ArticleTranslation{}, false
}

func (h *Handler) applyArticleTranslations(ctx context.Context, articles []model.Article, preferred model.LanguageCode, strictPreferred bool, secondaryFallback model.LanguageCode) error {
	if len(articles) == 0 {
		return nil
	}

	articleIDs := make([]string, 0, len(articles))
	for i := range articles {
		articleIDs = append(articleIDs, articles[i].ID)
	}

	translationsByArticle, err := h.loadArticleTranslations(ctx, articleIDs)
	if err != nil {
		return err
	}

	for i := range articles {
		byLang := translationsByArticle[articles[i].ID]
		available := make([]model.LanguageCode, 0, len(byLang))
		for _, supported := range model.SupportedArticleLanguages {
			if _, ok := byLang[supported]; ok {
				available = append(available, supported)
			}
		}
		articles[i].AvailableLangs = available

		translation, ok := pickArticleTranslation(byLang, preferred, strictPreferred, secondaryFallback)
		if ok {
			articles[i].Title = translation.Title
			articles[i].Markdown = translation.Markdown
			articles[i].ContentHTML = translation.ContentHTML
			continue
		}

		if strictPreferred && preferred != "" {
			articles[i].Title = ""
			articles[i].Markdown = ""
			articles[i].ContentHTML = ""
		}
	}

	return nil
}

func (h *Handler) EnsureArticleTranslations(ctx context.Context) error {
	if h.articleTranslations == nil {
		return fmt.Errorf("article translations collection is not configured")
	}

	_, err := h.articleTranslations.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "articleId", Value: 1}, {Key: "language", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("article_language_unique"),
		},
		{
			Keys:    bson.D{{Key: "articleId", Value: 1}},
			Options: options.Index().SetName("article_id_idx"),
		},
	})
	if err != nil {
		return fmt.Errorf("create article translation indexes: %w", err)
	}

	migrationFilter := bson.M{
		"$or": []bson.M{
			{"title": bson.M{"$exists": true}},
			{"markdown": bson.M{"$exists": true}},
			{"contentHTML": bson.M{"$exists": true}},
		},
	}

	cursor, err := h.articles.Find(ctx, migrationFilter)
	if err != nil {
		return fmt.Errorf("find legacy articles for translation migration: %w", err)
	}
	defer cursor.Close(ctx)

	var legacyArticles []model.Article
	if err := cursor.All(ctx, &legacyArticles); err != nil {
		return fmt.Errorf("decode legacy articles for translation migration: %w", err)
	}

	for _, legacy := range legacyArticles {
		if strings.TrimSpace(legacy.ID) == "" {
			continue
		}

		now := time.Now().UTC()
		if err := h.upsertArticleTranslation(
			ctx,
			legacy.ID,
			model.LanguageFrench,
			legacy.Title,
			legacy.Markdown,
			legacy.ContentHTML,
			now,
		); err != nil {
			return fmt.Errorf("upsert article translation for article %s: %w", legacy.ID, err)
		}

		_, err := h.articles.UpdateByID(ctx, legacy.ID, bson.M{
			"$unset": bson.M{
				"title":           "",
				"markdown":        "",
				"contentHTML":     "",
				"defaultLanguage": "",
			},
		})
		if err != nil {
			return fmt.Errorf("update article %s after translation migration: %w", legacy.ID, err)
		}
	}

	_, err = h.articles.UpdateMany(ctx, bson.M{"defaultLanguage": bson.M{"$exists": true}}, bson.M{
		"$unset": bson.M{"defaultLanguage": ""},
	})
	if err != nil {
		return fmt.Errorf("remove default language from existing articles: %w", err)
	}

	return nil
}
