package httpapi

import (
	"context"
	"fmt"
	"html"
	"log"
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

func (h *Handler) upsertArticleTranslation(ctx context.Context, articleID string, language model.LanguageCode, owner string, title string, markdown string, contentHTML string, now time.Time) error {
	lang := defaultArticleLanguage(language)
	filter := bson.M{"articleId": articleID, "language": lang}

	// Check if translation exists and verify ownership before updating
	var existing model.ArticleTranslation
	err := h.articleTranslations.FindOne(ctx, filter).Decode(&existing)
	if err == nil {
		// Translation exists, check ownership
		existingOwner := strings.TrimSpace(strings.ToLower(existing.Owner))
		requesterOwner := strings.TrimSpace(strings.ToLower(owner))
		if existingOwner != "" && existingOwner != requesterOwner {
			return fmt.Errorf("only the translation owner can update this translation")
		}
	} else if err != mongo.ErrNoDocuments {
		return err
	}

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
			"owner":     owner,
			"createdAt": now,
		},
	}
	_, err = h.articleTranslations.UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
	return err
}

func (h *Handler) deleteArticleTranslation(ctx context.Context, articleID string, language model.LanguageCode, owner string) error {
	lang := defaultArticleLanguage(language)

	// Check ownership before deleting
	var existing model.ArticleTranslation
	filter := bson.M{"articleId": articleID, "language": lang}
	err := h.articleTranslations.FindOne(ctx, filter).Decode(&existing)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil // Already deleted
		}
		return err
	}

	existingOwner := strings.TrimSpace(strings.ToLower(existing.Owner))
	requesterOwner := strings.TrimSpace(strings.ToLower(owner))
	if existingOwner != "" && existingOwner != requesterOwner {
		return fmt.Errorf("only the translation owner can delete this translation")
	}

	_, err = h.articleTranslations.DeleteOne(ctx, filter)
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
			articles[i].TranslationOwner = translation.Owner
			continue
		}

		if strictPreferred && preferred != "" {
			articles[i].Title = ""
			articles[i].Markdown = ""
			articles[i].ContentHTML = ""
			articles[i].TranslationOwner = ""
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
		{
			Keys:    bson.D{{Key: "owner", Value: 1}},
			Options: options.Index().SetName("owner_idx"),
		},
	})
	if err != nil {
		return fmt.Errorf("create article translation indexes: %w", err)
	}

	// Migration 1: Delete translations that are missing both title and content
	deleteFilter := bson.M{
		"$or": []bson.M{
			{
				"title":    bson.M{"$in": []interface{}{"", nil}},
				"markdown": bson.M{"$in": []interface{}{"", nil}},
			},
			{
				"title":    bson.M{"$exists": false},
				"markdown": bson.M{"$exists": false},
			},
		},
	}
	deleteResult, err := h.articleTranslations.DeleteMany(ctx, deleteFilter)
	if err != nil {
		return fmt.Errorf("delete incomplete translations: %w", err)
	}
	if deleteResult.DeletedCount > 0 {
		log.Printf("Deleted %d incomplete translations", deleteResult.DeletedCount)
	}

	// Migration 2: Set owner on translations without owner (from article owner)
	cursor, err := h.articleTranslations.Find(ctx, bson.M{
		"$or": []bson.M{
			{"owner": bson.M{"$exists": false}},
			{"owner": ""},
		},
	})
	if err != nil {
		return fmt.Errorf("find translations without owner: %w", err)
	}
	defer cursor.Close(ctx)

	var translationsWithoutOwner []model.ArticleTranslation
	if err := cursor.All(ctx, &translationsWithoutOwner); err != nil {
		return fmt.Errorf("decode translations without owner: %w", err)
	}

	for _, translation := range translationsWithoutOwner {
		if strings.TrimSpace(translation.ArticleID) == "" {
			continue
		}

		// Get article owner
		var article model.Article
		if err := h.articles.FindOne(ctx, bson.M{"_id": translation.ArticleID}).Decode(&article); err != nil {
			if err == mongo.ErrNoDocuments {
				// Article doesn't exist, delete orphaned translation
				_, _ = h.articleTranslations.DeleteOne(ctx, bson.M{"_id": translation.ID})
				continue
			}
			return fmt.Errorf("find article %s for translation owner migration: %w", translation.ArticleID, err)
		}

		// Set translation owner to article owner
		_, err := h.articleTranslations.UpdateByID(ctx, translation.ID, bson.M{
			"$set": bson.M{"owner": article.Owner},
		})
		if err != nil {
			return fmt.Errorf("set owner on translation %s: %w", translation.ID, err)
		}
	}

	// Migration 3: Move legacy article content to translations
	migrationFilter := bson.M{
		"$or": []bson.M{
			{"title": bson.M{"$exists": true}},
			{"markdown": bson.M{"$exists": true}},
			{"contentHTML": bson.M{"$exists": true}},
		},
	}

	legacyCursor, err := h.articles.Find(ctx, migrationFilter)
	if err != nil {
		return fmt.Errorf("find legacy articles for translation migration: %w", err)
	}
	defer legacyCursor.Close(ctx)

	var legacyArticles []model.Article
	if err := legacyCursor.All(ctx, &legacyArticles); err != nil {
		return fmt.Errorf("decode legacy articles for translation migration: %w", err)
	}

	for _, legacy := range legacyArticles {
		if strings.TrimSpace(legacy.ID) == "" {
			continue
		}

		now := time.Now().UTC()

		// Use direct insert/update without ownership check for migration
		lang := model.LanguageFrench
		filter := bson.M{"articleId": legacy.ID, "language": lang}
		update := bson.M{
			"$set": bson.M{
				"title":       strings.TrimSpace(legacy.Title),
				"markdown":    legacy.Markdown,
				"contentHTML": legacy.ContentHTML,
				"owner":       legacy.Owner,
				"updatedAt":   now,
			},
			"$setOnInsert": bson.M{
				"_id":       bson.NewObjectID().Hex(),
				"articleId": legacy.ID,
				"language":  lang,
				"createdAt": now,
			},
		}
		_, err := h.articleTranslations.UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
		if err != nil {
			return fmt.Errorf("upsert article translation for article %s: %w", legacy.ID, err)
		}

		_, err = h.articles.UpdateByID(ctx, legacy.ID, bson.M{
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
