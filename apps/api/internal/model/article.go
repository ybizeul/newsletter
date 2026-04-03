package model

import "time"

type ArticleStatus string

const (
	ArticleStatusDraft     ArticleStatus = "draft"
	ArticleStatusPublished ArticleStatus = "published"
	ArticleStatusArchived  ArticleStatus = "archived"
)

type Article struct {
	ID            string        `bson:"_id" json:"id"`
	AuthorID      string        `bson:"authorId" json:"authorId"`
	Title         string        `bson:"title" json:"title"`
	Markdown      string        `bson:"markdown" json:"markdown"`
	Tags          []string      `bson:"tags,omitempty" json:"tags,omitempty"`
	TopicIcon     string        `bson:"topicIcon,omitempty" json:"topicIcon,omitempty"`
	Illustration  string        `bson:"illustration,omitempty" json:"illustration,omitempty"`
	SentCount     int64         `bson:"sentCount" json:"sentCount"`
	LastUsed      *time.Time    `bson:"last_used,omitempty" json:"lastUsed,omitempty"`
	Status        ArticleStatus `bson:"status" json:"status"`
	LockOwnerID   string        `bson:"lockOwnerId,omitempty" json:"lockOwnerId,omitempty"`
	LockExpiresAt *time.Time    `bson:"lockExpiresAt,omitempty" json:"lockExpiresAt,omitempty"`
	Version       int64         `bson:"version" json:"version"`
	CreatedAt     time.Time     `bson:"createdAt" json:"createdAt"`
	UpdatedAt     time.Time     `bson:"updatedAt" json:"updatedAt"`
	PublishedAt   *time.Time    `bson:"publishedAt,omitempty" json:"publishedAt,omitempty"`
	ArchivedAt    *time.Time    `bson:"archivedAt,omitempty" json:"archivedAt,omitempty"`
}
