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
	ID            string           `bson:"_id" json:"id"`
	CreatorID     string           `bson:"creatorId" json:"creatorId"`
	Title         string           `bson:"title" json:"title"`
	HeaderID      string           `bson:"headerId,omitempty" json:"headerId,omitempty"`
	IntroMarkdown string           `bson:"introMarkdown" json:"introMarkdown"`
	IncludeIndex  bool             `bson:"includeIndex" json:"includeIndex"`
	ArticleIDs    []string         `bson:"articleIds" json:"articleIds"`
	RecipientIDs  []string         `bson:"recipientIds" json:"recipientIds"`
	Status        NewsletterStatus `bson:"status" json:"status"`
	DeliveryError string           `bson:"deliveryError,omitempty" json:"deliveryError,omitempty"`
	ScheduledAt   *time.Time       `bson:"scheduledAt,omitempty" json:"scheduledAt,omitempty"`
	SentAt        *time.Time       `bson:"sentAt,omitempty" json:"sentAt,omitempty"`
	CreatedAt     time.Time        `bson:"createdAt" json:"createdAt"`
	UpdatedAt     time.Time        `bson:"updatedAt" json:"updatedAt"`
}
