package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"newsletter/api/internal/config"

	"github.com/coreos/go-oidc/v3/oidc"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"golang.org/x/oauth2"
)

// User represents an authenticated user extracted from the OIDC ID token.
type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

type contextKey int

const (
	userContextKey        contextKey = 0
	accessTokenContextKey contextKey = 1
)

// UserFromContext returns the authenticated user from context, or nil.
func UserFromContext(ctx context.Context) *User {
	u, _ := ctx.Value(userContextKey).(*User)
	return u
}

// AccessTokenFromContext returns the OAuth2 access token from context, or empty string.
func AccessTokenFromContext(ctx context.Context) string {
	t, _ := ctx.Value(accessTokenContextKey).(string)
	return t
}

func contextWithUser(ctx context.Context, u *User) context.Context {
	return context.WithValue(ctx, userContextKey, u)
}

const (
	sessionCookieName  = "newsletter_session"
	stateCookieName    = "oidc_state"
	returnToCookieName = "oidc_return_to"
	callbackPath       = "/callback"
	sessionDuration    = 24 * time.Hour
)

// OIDCAuth handles OIDC authentication flows.
type OIDCAuth struct {
	enabled      bool
	provider     *oidc.Provider
	verifier     *oidc.IDTokenVerifier
	clientID     string
	clientSecret string
	smtpXoauth2  bool
	useGraphAPI  bool
	sessions     *mongo.Collection
}

// NewOIDCAuth initialises the OIDC provider via discovery.
// When cfg.OIDCEnabled() is false it returns a disabled no-op instance.
func NewOIDCAuth(cfg config.Config, db *mongo.Database) (*OIDCAuth, error) {
	if !cfg.OIDCEnabled() {
		log.Println("oidc: disabled (env vars not set)")
		return &OIDCAuth{enabled: false}, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	provider, err := oidc.NewProvider(ctx, cfg.OIDCIssuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery on %s: %w", cfg.OIDCIssuer, err)
	}

	verifier := provider.Verifier(&oidc.Config{ClientID: cfg.OIDCApplicationID})

	sessions := db.Collection("sessions")
	// Create TTL index so expired sessions are auto-removed by MongoDB.
	_, _ = sessions.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "expiresAt", Value: 1}},
		Options: options.Index().SetExpireAfterSeconds(0),
	})

	log.Printf("oidc: enabled issuer=%s client_id=%s", cfg.OIDCIssuer, cfg.OIDCApplicationID)

	return &OIDCAuth{
		enabled:      true,
		provider:     provider,
		verifier:     verifier,
		clientID:     cfg.OIDCApplicationID,
		clientSecret: cfg.OIDCSecret,
		smtpXoauth2:  cfg.SMTPXoauth2,
		useGraphAPI:  cfg.UseGraphAPI,
		sessions:     sessions,
	}, nil
}

// Enabled reports whether OIDC authentication is active.
func (a *OIDCAuth) Enabled() bool { return a.enabled }

// ---------------------------------------------------------------------------
// Helpers: redirect URI from request
// ---------------------------------------------------------------------------

func redirectURI(r *http.Request) string {
	scheme := "https"
	if r.TLS == nil {
		if fwd := r.Header.Get("X-Forwarded-Proto"); fwd != "" {
			scheme = fwd
		} else {
			scheme = "http"
		}
	}
	host := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
		host = fwd
	}
	return scheme + "://" + host + callbackPath
}

func (a *OIDCAuth) oauth2Config(redirectURL string) oauth2.Config {
	scopes := []string{oidc.ScopeOpenID, "profile", "email", oidc.ScopeOfflineAccess}
	if a.smtpXoauth2 {
		if a.useGraphAPI {
			scopes = append(scopes, "https://graph.microsoft.com/Mail.Send")
		} else {
			scopes = append(scopes, "https://outlook.office.com/Mail.Send")
		}
	}
	return oauth2.Config{
		ClientID:     a.clientID,
		ClientSecret: a.clientSecret,
		Endpoint:     a.provider.Endpoint(),
		RedirectURL:  redirectURL,
		Scopes:       scopes,
	}
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// HandleLogin redirects the user to the OIDC provider's authorize endpoint.
func (a *OIDCAuth) HandleLogin(w http.ResponseWriter, r *http.Request) {
	state, err := randomState()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"

	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName,
		Value:    state,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isSecure,
		MaxAge:   300,
	})

	// Persist the returnTo path so the callback can redirect back.
	if returnTo := r.URL.Query().Get("returnTo"); returnTo != "" {
		http.SetCookie(w, &http.Cookie{
			Name:     returnToCookieName,
			Value:    returnTo,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   isSecure,
			MaxAge:   300,
		})
	}

	cfg := a.oauth2Config(redirectURI(r))
	log.Printf("oidc: login redirect_uri=%s", cfg.RedirectURL)
	http.Redirect(w, r, cfg.AuthCodeURL(state), http.StatusFound)
}

// HandleCallback processes the OIDC authorization code callback.
func (a *OIDCAuth) HandleCallback(w http.ResponseWriter, r *http.Request) {
	log.Printf("oidc: callback received path=%s query_present=%t", r.URL.Path, r.URL.RawQuery != "")

	// Validate state
	stateCookie, err := r.Cookie(stateCookieName)
	if err != nil || stateCookie.Value == "" {
		http.Error(w, "missing state cookie", http.StatusBadRequest)
		return
	}
	if r.URL.Query().Get("state") != stateCookie.Value {
		http.Error(w, "state mismatch", http.StatusBadRequest)
		return
	}
	// Clear state cookie
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})

	// Check for error from provider
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		desc := r.URL.Query().Get("error_description")
		log.Printf("oidc callback error: %s – %s", errParam, desc)
		http.Error(w, "authentication failed: "+errParam, http.StatusUnauthorized)
		return
	}

	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}

	cfg := a.oauth2Config(redirectURI(r))
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	token, err := cfg.Exchange(ctx, code)
	if err != nil {
		log.Printf("oidc: code exchange failed: %v", err)
		http.Error(w, "code exchange failed", http.StatusUnauthorized)
		return
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "no id_token in response", http.StatusUnauthorized)
		return
	}

	idToken, err := a.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		log.Printf("oidc: id_token verification failed: %v", err)
		http.Error(w, "invalid id_token", http.StatusUnauthorized)
		return
	}

	var claims struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := idToken.Claims(&claims); err != nil {
		log.Printf("oidc: claims extraction failed: %v", err)
		http.Error(w, "failed to read claims", http.StatusInternalServerError)
		return
	}

	user := &User{
		ID:    claims.Sub,
		Email: claims.Email,
		Name:  claims.Name,
	}

	log.Printf("oidc: authenticated user sub=%q email=%q name=%q", user.ID, user.Email, user.Name)

	accessToken := ""
	if a.smtpXoauth2 {
		accessToken = token.AccessToken
	}
	sessionID, err := a.createSession(r.Context(), user, accessToken)
	if err != nil {
		log.Printf("oidc: session creation failed: %v", err)
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sessionID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		MaxAge:   int(sessionDuration.Seconds()),
	})

	// Redirect to the returnTo path if set, otherwise to root.
	redirectTo := "/"
	if cookie, err := r.Cookie(returnToCookieName); err == nil && cookie.Value != "" {
		redirectTo = cookie.Value
		http.SetCookie(w, &http.Cookie{
			Name:     returnToCookieName,
			Value:    "",
			Path:     "/",
			HttpOnly: true,
			MaxAge:   -1,
		})
	}
	http.Redirect(w, r, redirectTo, http.StatusFound)
}

// HandleLogout clears the session cookie and removes the server-side session.
func (a *OIDCAuth) HandleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
		_, _ = a.sessions.DeleteOne(r.Context(), bson.M{"_id": cookie.Value})
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
	http.Redirect(w, r, "/", http.StatusFound)
}

// HandleMe returns the currently authenticated user as JSON.
func (a *OIDCAuth) HandleMe(w http.ResponseWriter, r *http.Request) {
	if !a.enabled {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"oidc disabled"}`))
		return
	}

	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"not authenticated"}`))
		return
	}

	payload, err := a.loadSession(r.Context(), cookie.Value)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid session"}`))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload.User)
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Middleware validates the session cookie and injects the user into context.
// When OIDC is disabled it is a no-op passthrough.
func (a *OIDCAuth) Middleware(next http.Handler) http.Handler {
	if !a.enabled {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookieName)
		if err != nil || cookie.Value == "" {
			http.Error(w, `{"error":"not authenticated"}`, http.StatusUnauthorized)
			return
		}

		payload, err := a.loadSession(r.Context(), cookie.Value)
		if err != nil {
			http.Error(w, `{"error":"invalid session"}`, http.StatusUnauthorized)
			return
		}

		ctx := contextWithUser(r.Context(), &payload.User)
		if payload.AccessToken != "" {
			ctx = context.WithValue(ctx, accessTokenContextKey, payload.AccessToken)
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ---------------------------------------------------------------------------
// Server-side session store (MongoDB)
// ---------------------------------------------------------------------------

type sessionPayload struct {
	User        User   `json:"u" bson:"user"`
	AccessToken string `json:"at,omitempty" bson:"accessToken,omitempty"`
	ExpiresAt   int64  `json:"exp" bson:"-"`
}

type sessionDoc struct {
	ID          string    `bson:"_id"`
	User        User      `bson:"user"`
	AccessToken string    `bson:"accessToken,omitempty"`
	ExpiresAt   time.Time `bson:"expiresAt"`
}

func (a *OIDCAuth) createSession(ctx context.Context, u *User, accessToken string) (string, error) {
	id, err := randomSessionID()
	if err != nil {
		return "", err
	}

	doc := sessionDoc{
		ID:          id,
		User:        *u,
		AccessToken: accessToken,
		ExpiresAt:   time.Now().Add(sessionDuration),
	}

	_, err = a.sessions.InsertOne(ctx, doc)
	if err != nil {
		return "", fmt.Errorf("insert session: %w", err)
	}

	log.Printf("oidc: session created id=%s user=%s", id, u.Email)
	return id, nil
}

func (a *OIDCAuth) loadSession(ctx context.Context, id string) (*sessionPayload, error) {
	var doc sessionDoc
	err := a.sessions.FindOne(ctx, bson.M{"_id": id}).Decode(&doc)
	if err != nil {
		return nil, fmt.Errorf("session not found: %w", err)
	}
	if time.Now().After(doc.ExpiresAt) {
		_, _ = a.sessions.DeleteOne(ctx, bson.M{"_id": id})
		return nil, fmt.Errorf("session expired")
	}
	return &sessionPayload{
		User:        doc.User,
		AccessToken: doc.AccessToken,
	}, nil
}

func randomSessionID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func randomState() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
