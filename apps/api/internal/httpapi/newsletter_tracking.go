package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const newsletterOpenTokenTTL = 180 * 24 * time.Hour

var trackingPixelGIF = []byte{
	71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0,
	255, 255, 255, 33, 249, 4, 1, 0, 0, 1, 0, 44, 0, 0, 0, 0,
	1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
}

type newsletterOpenToken struct {
	ID         string     `bson:"_id"`
	Newsletter string     `bson:"newsletterId"`
	TokenHash  string     `bson:"tokenHash"`
	OpenedAt   *time.Time `bson:"openedAt,omitempty"`
	CreatedAt  time.Time  `bson:"createdAt"`
	ExpiresAt  time.Time  `bson:"expiresAt"`
}

func (h *Handler) EnsureNewsletterOpenTracking(ctx context.Context) error {
	if h.newsletterOpenTokens == nil {
		return fmt.Errorf("newsletter open token collection is not configured")
	}

	_, err := h.newsletterOpenTokens.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "tokenHash", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("token_hash_unique"),
		},
		{
			Keys:    bson.D{{Key: "newsletterId", Value: 1}, {Key: "openedAt", Value: 1}},
			Options: options.Index().SetName("newsletter_opened_idx"),
		},
		{
			Keys:    bson.D{{Key: "expiresAt", Value: 1}},
			Options: options.Index().SetExpireAfterSeconds(0).SetName("expires_at_ttl"),
		},
	})
	if err != nil {
		return fmt.Errorf("create newsletter open token indexes: %w", err)
	}
	return nil
}

func (h *Handler) isOpenTrackingEnabled() bool {
	return strings.TrimSpace(h.cfg.PublicBaseURL) != ""
}

func makeNewsletterOpenToken() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func hashNewsletterOpenToken(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func isObviousOpenScanner(userAgent string) bool {
	ua := strings.ToLower(strings.TrimSpace(userAgent))
	if ua == "" {
		return false
	}

	obviousScannerSignatures := []string{
		"proofpoint",
		"mimecast",
		"barracuda",
		"sophos",
		"symantec",
		"trendmicro",
		"fireeye",
		"urlscan",
		"talos",
		"mailguard",
	}

	for _, signature := range obviousScannerSignatures {
		if strings.Contains(ua, signature) {
			return true
		}
	}

	return false
}

func (h *Handler) buildNewsletterOpenPixelURL(token string) string {
	base := strings.TrimSpace(h.cfg.PublicBaseURL)
	if base == "" {
		return ""
	}
	lowerBase := strings.ToLower(base)
	if !strings.HasPrefix(lowerBase, "http://") && !strings.HasPrefix(lowerBase, "https://") {
		base = "https://" + base
	}
	return strings.TrimRight(base, "/") + "/t/" + token + ".gif"
}

func appendTrackingPixel(htmlBody, pixelURL string) string {
	if strings.TrimSpace(pixelURL) == "" {
		return htmlBody
	}
	pixel := `<img src="` + pixelURL + `" width="1" height="1" alt="" style="display:block;border:0;outline:none;text-decoration:none;width:1px;height:1px;" />`

	lower := strings.ToLower(htmlBody)
	closeBodyIndex := strings.LastIndex(lower, "</body>")
	if closeBodyIndex >= 0 {
		return htmlBody[:closeBodyIndex] + pixel + htmlBody[closeBodyIndex:]
	}
	return htmlBody + pixel
}

func deduplicateRecipientEmails(recipients []string) []string {
	unique := make([]string, 0, len(recipients))
	seen := make(map[string]struct{}, len(recipients))
	for _, raw := range recipients {
		normalized := strings.ToLower(strings.TrimSpace(raw))
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		unique = append(unique, normalized)
	}
	return unique
}

func (h *Handler) createOpenTokensForRecipients(ctx context.Context, newsletterID string, recipientCount int, now time.Time) ([]string, error) {
	tokens := make([]string, 0, recipientCount)
	docs := make([]any, 0, recipientCount)

	for i := 0; i < recipientCount; i++ {
		token, err := makeNewsletterOpenToken()
		if err != nil {
			return nil, err
		}
		tokenHash := hashNewsletterOpenToken(token)
		tokens = append(tokens, token)
		docs = append(docs, newsletterOpenToken{
			ID:         bson.NewObjectID().Hex(),
			Newsletter: newsletterID,
			TokenHash:  tokenHash,
			CreatedAt:  now,
			ExpiresAt:  now.Add(newsletterOpenTokenTTL),
		})
	}

	if len(docs) > 0 {
		if _, err := h.newsletterOpenTokens.InsertMany(ctx, docs); err != nil {
			return nil, err
		}
	}

	return tokens, nil
}

func (h *Handler) TrackNewsletterOpen(w http.ResponseWriter, r *http.Request, token string) {
	w.Header().Set("Content-Type", "image/gif")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")

	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(trackingPixelGIF)
		return
	}

	token = strings.TrimSpace(token)
	if token == "" {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(trackingPixelGIF)
		return
	}

	// Ignore obvious scanner opens for unique counting.
	if isObviousOpenScanner(r.UserAgent()) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(trackingPixelGIF)
		return
	}

	tokenHash := hashNewsletterOpenToken(token)
	now := time.Now().UTC()
	filter := bson.M{
		"tokenHash": tokenHash,
		"openedAt":  bson.M{"$exists": false},
		"expiresAt": bson.M{"$gt": now},
	}

	update := bson.M{"$set": bson.M{"openedAt": now}}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)

	var updated newsletterOpenToken
	err := h.newsletterOpenTokens.FindOneAndUpdate(r.Context(), filter, update, opts).Decode(&updated)
	if err == nil {
		_, _ = h.newsletters.UpdateByID(r.Context(), updated.Newsletter, bson.M{
			"$inc": bson.M{"openedUniqueCount": 1},
			"$set": bson.M{"updatedAt": now},
		})
	}

	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(trackingPixelGIF)
}
