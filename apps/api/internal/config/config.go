package config

import (
	"log"
	"os"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	Port          string
	MongoURI      string
	MongoDatabase string
	SMTPHost      string
	SMTPPort      string
	SMTPFrom      string
	SMTPUser      string
	SMTPPass      string
	DefaultTZ     string
	ScheduleTick  time.Duration
}

func Load() Config {
	loadDotEnvFiles()

	return Config{
		Port:          getEnv("API_PORT", "8080"),
		MongoURI:      getEnv("MONGO_URI", "mongodb://localhost:27017"),
		MongoDatabase: getEnv("MONGO_DATABASE", "newsletter"),
		SMTPHost:      getEnv("SMTP_HOST", ""),
		SMTPPort:      getEnv("SMTP_PORT", "587"),
		SMTPFrom:      getEnv("SMTP_FROM", "no-reply@example.com"),
		SMTPUser:      getEnv("SMTP_USER", ""),
		SMTPPass:      getEnv("SMTP_PASS", ""),
		DefaultTZ:     getEnv("DEFAULT_TZ", "UTC"),
		ScheduleTick:  20 * time.Second,
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
