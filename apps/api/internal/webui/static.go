package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var embeddedFiles embed.FS

func Handler() http.Handler {
	distFS, err := fs.Sub(embeddedFiles, "dist")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "web ui is unavailable", http.StatusInternalServerError)
		})
	}

	fileServer := http.FileServer(http.FS(distFS))
	indexHTML, _ := fs.ReadFile(distFS, "index.html")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}

		requested := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if requested == "." || requested == "" {
			requested = "index.html"
		}

		if _, err := fs.Stat(distFS, requested); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}

		if len(indexHTML) == 0 {
			http.NotFound(w, r)
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(indexHTML)
	})
}
