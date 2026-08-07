package model

import "time"

type ArticleStatus string

type LanguageCode string

const (
	ArticleStatusDraft     ArticleStatus = "draft"
	ArticleStatusPublished ArticleStatus = "published"
	ArticleStatusArchived  ArticleStatus = "archived"

	LanguageEnglish  LanguageCode = "en"
	LanguageFrench   LanguageCode = "fr"
	LanguageGerman   LanguageCode = "de"
	LanguageSpanish  LanguageCode = "es"
	LanguageItalian  LanguageCode = "it"
	LanguageJapanese LanguageCode = "ja"
	LanguageChinese  LanguageCode = "zh"
)

var SupportedArticleLanguages = []LanguageCode{
	LanguageEnglish,
	LanguageFrench,
	LanguageGerman,
	LanguageSpanish,
	LanguageItalian,
	LanguageJapanese,
	LanguageChinese,
}

type ArticleTranslation struct {
	ID          string       `bson:"_id" json:"id"`
	ArticleID   string       `bson:"articleId" json:"articleId"`
	Language    LanguageCode `bson:"language" json:"language"`
	Owner       string       `bson:"owner,omitempty" json:"owner,omitempty"`
	Title       string       `bson:"title" json:"title"`
	Markdown    string       `bson:"markdown" json:"markdown"`
	ContentHTML string       `bson:"contentHTML,omitempty" json:"contentHTML,omitempty"`
	CreatedAt   time.Time    `bson:"createdAt" json:"createdAt"`
	UpdatedAt   time.Time    `bson:"updatedAt" json:"updatedAt"`
}

type Article struct {
	ID               string         `bson:"_id" json:"id"`
	AuthorID         string         `bson:"authorId" json:"authorId"`
	Owner            string         `bson:"owner,omitempty" json:"owner,omitempty"`
	Public           bool           `bson:"public" json:"public"`
	Title            string         `bson:"title" json:"title"`
	Markdown         string         `bson:"markdown" json:"markdown"`
	ContentHTML      string         `bson:"contentHTML,omitempty" json:"contentHTML,omitempty"`
	Tags             []string       `bson:"tags,omitempty" json:"tags,omitempty"`
	TopicIcon        string         `bson:"topicIcon,omitempty" json:"topicIcon,omitempty"`
	Illustration     string         `bson:"illustration,omitempty" json:"illustration,omitempty"`
	IconSource       string         `bson:"iconSource,omitempty" json:"iconSource,omitempty"`
	IconZoom         int            `bson:"iconZoom,omitempty" json:"iconZoom,omitempty"`
	IconBgColor      string         `bson:"iconBgColor,omitempty" json:"iconBgColor,omitempty"`
	IconStrokeColor  string         `bson:"iconStrokeColor,omitempty" json:"iconStrokeColor,omitempty"`
	IconFillColor    string         `bson:"iconFillColor,omitempty" json:"iconFillColor,omitempty"`
	SentCount        int64          `bson:"sentCount" json:"sentCount"`
	LastUsed         *time.Time     `bson:"last_used,omitempty" json:"lastUsed,omitempty"`
	Preview          string         `bson:"preview,omitempty" json:"preview,omitempty"`
	Status           ArticleStatus  `bson:"status" json:"status"`
	LockOwnerID      string         `bson:"lockOwnerId,omitempty" json:"lockOwnerId,omitempty"`
	LockExpiresAt    *time.Time     `bson:"lockExpiresAt,omitempty" json:"lockExpiresAt,omitempty"`
	Version          int64          `bson:"version" json:"version"`
	CreatedAt        time.Time      `bson:"createdAt" json:"createdAt"`
	UpdatedAt        time.Time      `bson:"updatedAt" json:"updatedAt"`
	PublishedAt      *time.Time     `bson:"publishedAt,omitempty" json:"publishedAt,omitempty"`
	ArchivedAt       *time.Time     `bson:"archivedAt,omitempty" json:"archivedAt,omitempty"`
	AvailableLangs   []LanguageCode `bson:"-" json:"availableLanguages,omitempty"`
	TranslationOwner string         `bson:"-" json:"translationOwner,omitempty"`
}
