package model

import "time"

type HeaderStatus string

const (
	HeaderStatusDraft     HeaderStatus = "draft"
	HeaderStatusPublished HeaderStatus = "published"
	HeaderStatusArchived  HeaderStatus = "archived"
)

type Header struct {
	ID        string       `bson:"_id" json:"id"`
	CreatorID string       `bson:"creatorId" json:"creatorId"`
	Owner     string       `bson:"owner,omitempty" json:"owner,omitempty"`
	Title     string       `bson:"title" json:"title"`
	Markdown  string       `bson:"markdown" json:"markdown"`
	Status    HeaderStatus `bson:"status" json:"status"`
	Version   int64        `bson:"version" json:"version"`
	CreatedAt time.Time    `bson:"createdAt" json:"createdAt"`
	UpdatedAt time.Time    `bson:"updatedAt" json:"updatedAt"`
}
