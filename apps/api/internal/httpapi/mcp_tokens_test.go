package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestNewMCPTokenStoresOnlyHash(t *testing.T) {
	raw, storedHash, err := newMCPToken()
	if err != nil {
		t.Fatalf("newMCPToken() error = %v", err)
	}
	if !strings.HasPrefix(raw, mcpTokenPrefix) {
		t.Fatalf("token %q does not have prefix %q", raw, mcpTokenPrefix)
	}

	sum := sha256.Sum256([]byte(raw))
	wantHash := base64.RawURLEncoding.EncodeToString(sum[:])
	if storedHash != wantHash {
		t.Fatalf("stored hash = %q, want SHA-256 digest %q", storedHash, wantHash)
	}

	encoded, err := bson.Marshal(mcpTokenDoc{
		ID:        "token-id",
		TokenHash: storedHash,
		UserID:    "oidc-subject",
		Email:     "user@example.com",
		Label:     "Claude Code",
		CreatedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("marshal token document: %v", err)
	}
	if bytes.Contains(encoded, []byte(raw)) {
		t.Fatal("token document contains the plaintext token")
	}
}

func TestBearerToken(t *testing.T) {
	for _, test := range []struct {
		header string
		want   string
		ok     bool
	}{
		{"Bearer nlmcp_secret", "nlmcp_secret", true},
		{"bearer nlmcp_secret", "nlmcp_secret", true},
		{"", "", false},
		{"Basic nlmcp_secret", "", false},
		{"Bearer", "", false},
		{"Bearer one two", "", false},
	} {
		got, ok := bearerToken(test.header)
		if got != test.want || ok != test.ok {
			t.Errorf("bearerToken(%q) = (%q, %t), want (%q, %t)", test.header, got, ok, test.want, test.ok)
		}
	}
}
