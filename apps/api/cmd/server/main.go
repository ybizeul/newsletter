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
		"smtp config detected host_set=%t from_set=%t user_set=%t pass_set=%t",
		cfg.SMTPHost != "",
		cfg.SMTPFrom != "",
		cfg.SMTPUser != "",
		cfg.SMTPPass != "",
	)

	ctx := context.Background()
	mongoClient, err := db.Connect(ctx, cfg.MongoURI)
	if err != nil {
		log.Fatalf("failed to connect to mongodb: %v", err)
	}
	defer func() {
		_ = mongoClient.Disconnect(context.Background())
	}()

	h := httpapi.NewHandler(mongoClient.Database(cfg.MongoDatabase), cfg)
	webHandler := webui.Handler()
	go startScheduler(h, cfg.ScheduleTick)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	r.Route("/api", func(api chi.Router) {
		api.Route("/articles", func(article chi.Router) {
			article.Post("/", h.CreateArticle)
			article.Get("/", h.ListArticles)
			article.Put("/{id}", func(w http.ResponseWriter, r *http.Request) {
				h.UpdateArticle(w, r, chi.URLParam(r, "id"))
			})
			article.Delete("/{id}", func(w http.ResponseWriter, r *http.Request) {
				h.DeleteArticle(w, r, chi.URLParam(r, "id"))
			})
		})

		api.Route("/newsletters", func(newsletter chi.Router) {
			newsletter.Post("/", h.CreateNewsletter)
			newsletter.Get("/", h.ListNewsletters)
			newsletter.Put("/{id}", func(w http.ResponseWriter, r *http.Request) {
				h.UpdateNewsletter(w, r, chi.URLParam(r, "id"))
			})
			newsletter.Get("/{id}/preview", func(w http.ResponseWriter, r *http.Request) {
				h.GetNewsletterPreview(w, r, chi.URLParam(r, "id"))
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

		api.Post("/render/markdown", h.RenderMarkdown)
		api.Get("/runtime-config", h.GetRuntimeConfig)
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
