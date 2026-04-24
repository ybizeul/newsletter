package model

import "time"

type Contact struct {
	ID        string    `bson:"_id" json:"id"`
	Owner     string    `bson:"owner,omitempty" json:"owner,omitempty"`
	FirstName string    `bson:"firstName" json:"firstName"`
	LastName  string    `bson:"lastName" json:"lastName"`
	Email     string    `bson:"email" json:"email"`
	Tags      []string  `bson:"tags,omitempty" json:"tags,omitempty"`
	CreatedAt time.Time `bson:"createdAt" json:"createdAt"`
	UpdatedAt time.Time `bson:"updatedAt" json:"updatedAt"`
}
