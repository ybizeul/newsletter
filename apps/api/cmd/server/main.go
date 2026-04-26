package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"newsletter/api/internal/config"
	"newsletter/api/internal/db"
	"newsletter/api/internal/httpapi"
	"newsletter/api/internal/webui"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	cfg := config.Load()
	log.Printf(
		"smtp config detected host_set=%t from_set=%t user_set=%t pass_set=%t xoauth2=%t",
		cfg.SMTPHost != "",
		cfg.SMTPFrom != "",
		cfg.SMTPUser != "",
		cfg.SMTPPass != "",
		cfg.SMTPXoauth2,
	)

	ctx := context.Background()
	mongoClient, err := db.Connect(ctx, cfg.MongoURI)
	if err != nil {
		log.Fatalf("failed to connect to mongodb: %v", err)
	}
	defer func() {
		_ = mongoClient.Disconnect(context.Background())
	}()

	auth, err := httpapi.NewOIDCAuth(cfg)
	if err != nil {
		log.Fatalf("failed to initialise oidc: %v", err)
	}

	h := httpapi.NewHandler(mongoClient.Database(cfg.MongoDatabase), cfg)
	webHandler := webui.Handler()
	go startScheduler(h, cfg.ScheduleTick)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))
	// Limit request body size to 10 MB to prevent memory exhaustion attacks.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
			next.ServeHTTP(w, r)
		})
	})

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// OIDC callback at top level (registered with identity provider as /callback)
	r.Get("/callback", auth.HandleCallback)

	r.Route("/api", func(api chi.Router) {
		// OIDC auth routes (outside auth middleware)
		api.Get("/auth/login", auth.HandleLogin)
		api.Post("/auth/logout", auth.HandleLogout)
		api.Get("/auth/me", auth.HandleMe)

		// runtime-config is outside the auth middleware so the frontend can
		// determine whether OIDC is enabled before authenticating.
		api.Get("/runtime-config", h.GetRuntimeConfig)

		api.Group(func(protected chi.Router) {
			protected.Use(auth.Middleware)

			protected.Route("/articles", func(article chi.Router) {
				article.Post("/", h.CreateArticle)
				article.Get("/", h.ListArticles)
				article.Get("/{id}", func(w http.ResponseWriter, r *http.Request) {
					h.GetArticle(w, r, chi.URLParam(r, "id"))
				})
				article.Post("/{id}/claim", func(w http.ResponseWriter, r *http.Request) {
					h.ClaimArticle(w, r, chi.URLParam(r, "id"))
				})
				article.Put("/{id}", func(w http.ResponseWriter, r *http.Request) {
					h.UpdateArticle(w, r, chi.URLParam(r, "id"))
				})
				article.Delete("/{id}", func(w http.ResponseWriter, r *http.Request) {
					h.DeleteArticle(w, r, chi.URLParam(r, "id"))
				})
			})

			protected.Route("/headers", func(header chi.Router) {
				header.Post("/", h.CreateHeader)
				header.Get("/", h.ListHeaders)
				header.Put("/{id}", func(w http.ResponseWriter, r *http.Request) {
					h.UpdateHeader(w, r, chi.URLParam(r, "id"))
				})
				header.Delete("/{id}", func(w http.ResponseWriter, r *http.Request) {
					h.DeleteHeader(w, r, chi.URLParam(r, "id"))
				})
			})

			protected.Get("/saved-icons", h.GetSavedIcons)
			protected.Put("/saved-icons", h.PutSavedIcons)

			protected.Route("/newsletters", func(newsletter chi.Router) {
				newsletter.Post("/", h.CreateNewsletter)
				newsletter.Get("/", h.ListNewsletters)
				newsletter.Get("/{id}", func(w http.ResponseWriter, r *http.Request) {
					h.GetNewsletter(w, r, chi.URLParam(r, "id"))
				})
				newsletter.Post("/{id}/claim", func(w http.ResponseWriter, r *http.Request) {
					h.ClaimNewsletter(w, r, chi.URLParam(r, "id"))
				})
				newsletter.Put("/{id}", func(w http.ResponseWriter, r *http.Request) {
					h.UpdateNewsletter(w, r, chi.URLParam(r, "id"))
				})
				newsletter.Get("/{id}/preview", func(w http.ResponseWriter, r *http.Request) {
					h.GetNewsletterPreview(w, r, chi.URLParam(r, "id"))
				})
				newsletter.Post("/{id}/favorite", func(w http.ResponseWriter, r *http.Request) {
					h.SetNewsletterFavorite(w, r, chi.URLParam(r, "id"))
				})
				newsletter.Post("/{id}/send-now", func(w http.ResponseWriter, r *http.Request) {
					h.SendNewsletterNow(w, r, chi.URLParam(r, "id"))
				})
				newsletter.Post("/{id}/schedule", func(w http.ResponseWriter, r *http.Request) {
					h.ScheduleNewsletter(w, r, chi.URLParam(r, "id"))
				})
				newsletter.Delete("/{id}", func(w http.ResponseWriter, r *http.Request) {
					h.DeleteNewsletter(w, r, chi.URLParam(r, "id"))
				})
			})

			protected.Route("/contacts", func(contact chi.Router) {
				contact.Post("/", h.CreateContact)
				contact.Get("/", h.ListContacts)
				contact.Post("/import", h.BulkImportContacts)
				contact.Put("/{id}", func(w http.ResponseWriter, r *http.Request) {
					h.UpdateContact(w, r, chi.URLParam(r, "id"))
				})
				contact.Delete("/{id}", func(w http.ResponseWriter, r *http.Request) {
					h.DeleteContact(w, r, chi.URLParam(r, "id"))
				})
			})

			protected.Post("/render/markdown", h.RenderMarkdown)
		})
	})

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		webHandler.ServeHTTP(w, r)
	})
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		webHandler.ServeHTTP(w, r)
	})

	addr := ":" + cfg.Port
	log.Printf("api server listening on %s", addr)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}

func startScheduler(h *httpapi.Handler, tick time.Duration) {
	ticker := time.NewTicker(tick)
	defer ticker.Stop()

	for range ticker.C {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := h.RunSchedulerOnce(ctx); err != nil {
			log.Printf("scheduler loop error: %v", err)
		}
		cancel()
	}
}
