// Command renderserver is a small synchronous HTTP server that executes a
// single Edit Recipe against a single uploaded file and returns the
// rendered result — the Phase 2 "editor export" path (spec P0: "export
// produces the same recipe format Plexus pipelines consume"). Deliberately
// separate from cmd/worker's async NATS-dispatch loop: a slow render
// blocking an HTTP client is a different failure mode than an HTTP request
// blocking NATS message processing, and internal/render.RunRecipe /
// processors.Lookup are shared regardless of which binary calls them. See
// docs/tasks/TASK-editor-export.md.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/benitopedro13/plexus/workers/internal/processors"
	"github.com/benitopedro13/plexus/workers/internal/render"
)

// maxUploadBytes caps the multipart request body this server will read —
// the first place raw client bytes reach the Go side (apps/orchestrator's
// export controller forwards whatever it received, unchecked). 64 MiB
// comfortably covers full-resolution photos; not researched against a real
// photo corpus, a documented first-pass default in the same category as
// grainMaxSigma/pngCompressionFromQuality's judgment calls elsewhere in
// this codebase, not a governed spec value.
const maxUploadBytes = 64 << 20

// contentTypeByExt is an explicit map rather than the stdlib mime
// package's TypeByExtension, which on non-Windows platforms reads the
// host's /etc/mime.types — present and populated very differently between
// local macOS dev and a minimal Debian-slim Docker runtime (workers/
// Dockerfile), so relying on it would be exactly the kind of
// unverified-across-environments behavior CLAUDE.md §0 warns against. This
// mirrors the exact format set workers/internal/processors already
// supports (format.go's four image formats, ffmpeg.go's video/audio
// codec-pair formats).
// ".jpg" is also mapped (not just ".jpeg") because a step-less recipe's
// output path (render.RunRecipe's no-op case) keeps the *uploaded*
// filename's extension verbatim rather than a processor-normalized one —
// every processor-produced output already uses ".jpeg", but a passthrough
// export of an untouched upload commonly won't.
var contentTypeByExt = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
	".avif": "image/avif",
	".mp4":  "video/mp4",
	".webm": "video/webm",
	".mp3":  "audio/mpeg",
	".aac":  "audio/aac",
	".opus": "audio/opus",
	".wav":  "audio/wav",
}

func main() {
	if err := processors.Startup(); err != nil {
		log.Fatalf("start libvips: %v", err)
	}
	defer processors.Shutdown()

	if err := processors.CheckAvailable(); err != nil {
		log.Fatalf("check ffmpeg: %v", err)
	}

	addr := os.Getenv("RENDER_SERVER_ADDR")
	if addr == "" {
		addr = ":8090"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/render", renderHandler)

	log.Println("renderserver listening on", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("serve: %v", err)
	}
}

func renderHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		http.Error(w, fmt.Sprintf("parse multipart form: %v", err), http.StatusBadRequest)
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, fmt.Sprintf("missing %q file part: %v", "file", err), http.StatusBadRequest)
		return
	}
	defer func() { _ = file.Close() }()

	var steps []render.RecipeStep
	if raw := r.FormValue("recipe"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &steps); err != nil {
			http.Error(w, fmt.Sprintf("invalid %q field: %v", "recipe", err), http.StatusBadRequest)
			return
		}
	}

	sourceDir, err := os.MkdirTemp("", "plexus-render-src-*")
	if err != nil {
		log.Printf("mkdir temp: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer func() { _ = os.RemoveAll(sourceDir) }()

	sourcePath := filepath.Join(sourceDir, "source"+filepath.Ext(header.Filename))
	if err := saveUpload(sourcePath, file); err != nil {
		log.Printf("save upload: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	outputPath, cleanup, err := render.RunRecipe(r.Context(), render.NewRenderID(), sourcePath, steps)
	if err != nil {
		http.Error(w, fmt.Sprintf("render recipe: %v", err), http.StatusUnprocessableEntity)
		return
	}
	defer cleanup()

	data, err := os.ReadFile(outputPath)
	if err != nil {
		log.Printf("read rendered output %q: %v", outputPath, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	ext := filepath.Ext(outputPath)
	contentType, ok := contentTypeByExt[strings.ToLower(ext)]
	if !ok {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", "export"+ext))
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(data); err != nil {
		log.Printf("write response: %v", err)
	}
}

func saveUpload(path string, src io.Reader) error {
	dst, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %q: %w", path, err)
	}
	defer func() { _ = dst.Close() }()

	if _, err := io.Copy(dst, src); err != nil {
		return fmt.Errorf("write %q: %w", path, err)
	}
	return nil
}
