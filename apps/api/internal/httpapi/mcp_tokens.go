package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	mcpTokenPrefix    = "nlmcp_"
	maxMCPTokenLabel  = 100
	mcpTokenSecretLen = 32
)

// mcpTokenDoc deliberately contains no plaintext token field. The SHA-256
// digest is sufficient for lookup and means a database disclosure cannot be
// used to authenticate to the MCP endpoint.
type mcpTokenDoc struct {
	ID         string     `bson:"_id"`
	TokenHash  string     `bson:"tokenHash"`
	UserID     string     `bson:"userID"`
	Email      string     `bson:"email"`
	Name       string     `bson:"name,omitempty"`
	Label      string     `bson:"label"`
	TokenHint  string     `bson:"tokenHint"`
	CreatedAt  time.Time  `bson:"createdAt"`
	LastUsedAt *time.Time `bson:"lastUsedAt,omitempty"`
	RevokedAt  *time.Time `bson:"revokedAt,omitempty"`
	ExpiresAt  *time.Time `bson:"expiresAt,omitempty"`
}

type createMCPTokenRequest struct {
	Label string `json:"label"`
}

type mcpTokenResponse struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	TokenHint  string     `json:"tokenHint"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	Token      string     `json:"token,omitempty"`
}

func (a *OIDCAuth) CreateMCPToken(w http.ResponseWriter, r *http.Request) {
	user, ok := mcpTokenUser(r)
	if !ok {
		mcpTokenError(w, http.StatusUnauthorized, "not authenticated")
		return
	}

	var req createMCPTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		mcpTokenError(w, http.StatusBadRequest, "invalid payload")
		return
	}
	label := strings.TrimSpace(req.Label)
	if label == "" || len([]rune(label)) > maxMCPTokenLabel {
		mcpTokenError(w, http.StatusBadRequest, "label is required and must be at most 100 characters")
		return
	}

	rawToken, hash, err := newMCPToken()
	if err != nil {
		mcpTokenError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}
	now := time.Now().UTC()
	doc := mcpTokenDoc{
		ID:        bson.NewObjectID().Hex(),
		TokenHash: hash,
		UserID:    user.ID,
		Email:     strings.ToLower(strings.TrimSpace(user.Email)),
		Name:      strings.TrimSpace(user.Name),
		Label:     label,
		TokenHint: rawToken[:len(mcpTokenPrefix)+8],
		CreatedAt: now,
	}
	if _, err := a.mcpTokens.InsertOne(r.Context(), doc); err != nil {
		mcpTokenError(w, http.StatusInternalServerError, "failed to create token")
		return
	}

	mcpTokenJSON(w, http.StatusCreated, mcpTokenResponse{
		ID:        doc.ID,
		Label:     doc.Label,
		TokenHint: doc.TokenHint,
		CreatedAt: doc.CreatedAt,
		Token:     rawToken,
	})
}

func (a *OIDCAuth) ListMCPTokens(w http.ResponseWriter, r *http.Request) {
	user, ok := mcpTokenUser(r)
	if !ok {
		mcpTokenError(w, http.StatusUnauthorized, "not authenticated")
		return
	}

	cursor, err := a.mcpTokens.Find(
		r.Context(),
		bson.M{
			"userID": user.ID,
			"$or":    []bson.M{{"revokedAt": bson.M{"$exists": false}}, {"revokedAt": nil}},
		},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}),
	)
	if err != nil {
		mcpTokenError(w, http.StatusInternalServerError, "failed to list tokens")
		return
	}
	defer cursor.Close(r.Context())

	var docs []mcpTokenDoc
	if err := cursor.All(r.Context(), &docs); err != nil {
		mcpTokenError(w, http.StatusInternalServerError, "failed to decode tokens")
		return
	}
	items := make([]mcpTokenResponse, 0, len(docs))
	for _, doc := range docs {
		items = append(items, mcpTokenResponse{
			ID:         doc.ID,
			Label:      doc.Label,
			TokenHint:  doc.TokenHint,
			CreatedAt:  doc.CreatedAt,
			LastUsedAt: doc.LastUsedAt,
		})
	}
	mcpTokenJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *OIDCAuth) RevokeMCPToken(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := mcpTokenUser(r)
	if !ok {
		mcpTokenError(w, http.StatusUnauthorized, "not authenticated")
		return
	}

	now := time.Now().UTC()
	result, err := a.mcpTokens.UpdateOne(
		r.Context(),
		bson.M{
			"_id":    id,
			"userID": user.ID,
			"$or":    []bson.M{{"revokedAt": bson.M{"$exists": false}}, {"revokedAt": nil}},
		},
		bson.M{"$set": bson.M{"revokedAt": now}},
	)
	if err != nil {
		mcpTokenError(w, http.StatusInternalServerError, "failed to revoke token")
		return
	}
	if result.MatchedCount == 0 {
		mcpTokenError(w, http.StatusNotFound, "token not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func mcpTokenUser(r *http.Request) (*User, bool) {
	user := UserFromContext(r.Context())
	if user == nil || strings.TrimSpace(user.ID) == "" || strings.TrimSpace(user.Email) == "" {
		return nil, false
	}
	return user, true
}

func newMCPToken() (rawToken, tokenHash string, err error) {
	secret := make([]byte, mcpTokenSecretLen)
	if _, err := rand.Read(secret); err != nil {
		return "", "", fmt.Errorf("read random token bytes: %w", err)
	}
	rawToken = mcpTokenPrefix + base64.RawURLEncoding.EncodeToString(secret)
	hash := sha256.Sum256([]byte(rawToken))
	return rawToken, base64.RawURLEncoding.EncodeToString(hash[:]), nil
}

func mcpTokenJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func mcpTokenError(w http.ResponseWriter, status int, message string) {
	mcpTokenJSON(w, status, map[string]string{"error": message})
}
