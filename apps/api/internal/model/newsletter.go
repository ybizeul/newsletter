package model

import "time"

type NewsletterStatus string

const (
	NewsletterStatusDraft     NewsletterStatus = "draft"
	NewsletterStatusScheduled NewsletterStatus = "scheduled"
	NewsletterStatusSending   NewsletterStatus = "sending"
	NewsletterStatusSent      NewsletterStatus = "sent"
	NewsletterStatusFailed    NewsletterStatus = "failed"
)

type Newsletter struct {
	ID              string           `bson:"_id" json:"id"`
	CreatorID       string           `bson:"creatorId" json:"creatorId"`
	Owner           string           `bson:"owner,omitempty" json:"owner,omitempty"`
	Title           string           `bson:"title" json:"title"`
	Language        LanguageCode     `bson:"language,omitempty" json:"language,omitempty"`
	Template        string           `bson:"template,omitempty" json:"template,omitempty"`
	PublicLink      bool             `bson:"publicLink,omitempty" json:"publicLink"`
	PublicSlug      string           `bson:"publicSlug,omitempty" json:"publicSlug,omitempty"`
	HeaderID        string           `bson:"headerId,omitempty" json:"headerId,omitempty"`
	IntroMarkdown   string           `bson:"introMarkdown" json:"introMarkdown"`
	IntroHTML       string           `bson:"introHTML,omitempty" json:"introHTML,omitempty"`
	FooterMarkdown  string           `bson:"footerMarkdown" json:"footerMarkdown"`
	FooterHTML      string           `bson:"footerHTML,omitempty" json:"footerHTML,omitempty"`
	IncludeIndex    bool             `bson:"includeIndex" json:"includeIndex"`
	ArticleIDs      []string         `bson:"articleIds" json:"articleIds"`
	RecipientIDs    []string         `bson:"recipientIds" json:"recipientIds"`
	ContactTags     []string         `bson:"contactTags,omitempty" json:"contactTags,omitempty"`
	ContactTagsMode string           `bson:"contactTagsMode,omitempty" json:"contactTagsMode,omitempty"`
	ContentWidth    int              `bson:"contentWidth,omitempty" json:"contentWidth"`
	IsFavorite      bool             `bson:"isFavorite" json:"isFavorite"`
	Archived        bool             `bson:"archived" json:"archived"`
	ArchivedAt      *time.Time       `bson:"archivedAt,omitempty" json:"archivedAt,omitempty"`
	Status          NewsletterStatus `bson:"status" json:"status"`
	DeliveryError   string           `bson:"deliveryError,omitempty" json:"deliveryError,omitempty"`
	ScheduledAt     *time.Time       `bson:"scheduledAt,omitempty" json:"scheduledAt,omitempty"`
	SentAt          *time.Time       `bson:"sentAt,omitempty" json:"sentAt,omitempty"`
	CreatedAt       time.Time        `bson:"createdAt" json:"createdAt"`
	UpdatedAt       time.Time        `bson:"updatedAt" json:"updatedAt"`
}
