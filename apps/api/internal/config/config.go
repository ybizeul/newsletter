package config

import (
	"log"
	"os"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	Port             string
	MongoURI         string
	MongoDatabase    string
	SMTPHost         string
	SMTPPort         string
	SMTPFrom         string
	SMTPUser         string
	SMTPPass         string
	SMTPXoauth2      bool
	UseGraphAPI      bool
	PublicBaseURL    string
	DefaultTZ        string
	ScheduleTick     time.Duration
	ContactsDisabled bool

	OIDCIssuer        string
	OIDCApplicationID string
	OIDCSecret        string
}

func (c Config) OIDCEnabled() bool {
	return c.OIDCIssuer != "" && c.OIDCApplicationID != "" && c.OIDCSecret != ""
}

func Load() Config {
	loadDotEnvFiles()

	return Config{
		Port:             getEnv("API_PORT", "8080"),
		MongoURI:         getEnv("MONGO_URI", "mongodb://localhost:27017"),
		MongoDatabase:    getEnv("MONGO_DATABASE", "newsletter"),
		SMTPHost:         getEnv("SMTP_HOST", ""),
		SMTPPort:         getEnv("SMTP_PORT", "587"),
		SMTPFrom:         getEnv("SMTP_FROM", "no-reply@example.com"),
		SMTPUser:         getEnv("SMTP_USER", ""),
		SMTPPass:         getEnv("SMTP_PASS", ""),
		SMTPXoauth2:      getEnvBool("SMTP_XOAUTH2", false),
		UseGraphAPI:      getEnvBool("USE_GRAPH_API", false),
		PublicBaseURL:    getEnv("PUBLIC_BASE_URL", ""),
		DefaultTZ:        getEnv("DEFAULT_TZ", "UTC"),
		ScheduleTick:     20 * time.Second,
		ContactsDisabled: getEnvBool("DISABLE_CONTACTS", false),

		OIDCIssuer:        getEnv("OIDC_ISSUER", ""),
		OIDCApplicationID: getEnv("OIDC_APPLICATION_ID", ""),
		OIDCSecret:        getEnv("OIDC_SECRET", ""),
	}
}

func loadDotEnvFiles() {
	candidates := []string{
		".env",
		"../.env",
		"../../.env",
	}

	for _, path := range candidates {
		if err := godotenv.Overload(path); err == nil {
			log.Printf("loaded environment from %s", path)
			return
		}
	}
}

func getEnv(key, fallback string) string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return v
}

func getEnvBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	switch v {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	default:
		return fallback
	}
}
