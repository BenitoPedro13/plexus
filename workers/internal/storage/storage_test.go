package storage_test

import (
	"bytes"
	"context"
	"os"
	"testing"

	miniogo "github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/testcontainers/testcontainers-go"
	miniocontainer "github.com/testcontainers/testcontainers-go/modules/minio"

	"github.com/benitopedro13/plexus/workers/internal/storage"
)

// newTestClient starts a real MinIO container (testcontainers, matching
// infra/docker-compose.yml's image — no mocking object storage, mirroring
// dispatch_test.go's real-NATS pattern) and returns a storage.Client wired
// against it via the same MINIO_* env vars storage.New() reads.
func newTestClient(t *testing.T, ctx context.Context) *storage.Client {
	t.Helper()

	ctr, err := miniocontainer.Run(ctx, "minio/minio:RELEASE.2025-09-07T16-13-09Z")
	t.Cleanup(func() {
		if err := testcontainers.TerminateContainer(ctr); err != nil {
			t.Logf("terminate container: %v", err)
		}
	})
	if err != nil {
		t.Fatalf("start MinIO container: %v", err)
	}

	endpoint, err := ctr.ConnectionString(ctx)
	if err != nil {
		t.Fatalf("get connection string: %v", err)
	}

	t.Setenv("MINIO_ENDPOINT", endpoint)
	t.Setenv("MINIO_ACCESS_KEY", ctr.Username)
	t.Setenv("MINIO_SECRET_KEY", ctr.Password)
	t.Setenv("MINIO_BUCKET", "plexus-test")
	t.Setenv("MINIO_USE_SSL", "false")
	t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

	client, err := storage.New(ctx)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	return client
}

func TestClient_UploadDownloadRoundTrip(t *testing.T) {
	ctx := context.Background()
	client := newTestClient(t, ctx)

	want := []byte("plexus round-trip fixture bytes")
	src, err := os.CreateTemp(t.TempDir(), "upload-*.txt")
	if err != nil {
		t.Fatalf("create source file: %v", err)
	}
	if _, err := src.Write(want); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	if err := src.Close(); err != nil {
		t.Fatalf("close source file: %v", err)
	}

	const objectKey = "steps/round-trip.txt"
	if err := client.Upload(ctx, src.Name(), objectKey); err != nil {
		t.Fatalf("Upload: %v", err)
	}

	localPath, cleanup, err := client.Download(ctx, objectKey)
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	defer cleanup()

	got, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("round-tripped bytes mismatch: got %q, want %q", got, want)
	}

	cleanup()
	if _, err := os.Stat(localPath); !os.IsNotExist(err) {
		t.Fatalf("expected cleanup to remove %q, stat err: %v", localPath, err)
	}
}

func TestClient_Download_MissingKey(t *testing.T) {
	ctx := context.Background()
	client := newTestClient(t, ctx)

	if _, _, err := client.Download(ctx, "does-not-exist.bin"); err == nil {
		t.Fatal("expected an error downloading a missing key, got nil")
	}
}

// TestClient_New_BucketAlreadyExists proves New() is idempotent — creating a
// second Client against a bucket the first one already created must not
// error (mirrors output.go's own MkdirAll idempotency).
func TestClient_New_BucketAlreadyExists(t *testing.T) {
	ctx := context.Background()
	_ = newTestClient(t, ctx) // creates the bucket

	if _, err := storage.New(ctx); err != nil {
		t.Fatalf("storage.New against an already-existing bucket: %v", err)
	}
}

// TestClient_Upload_ContentType proves Upload() sets a real Content-Type
// rather than leaving it at MinIO's generic default, so a browser given a
// presigned GET later renders (rather than downloads) previewable output.
func TestClient_Upload_ContentType(t *testing.T) {
	ctx := context.Background()
	client := newTestClient(t, ctx)

	src, err := os.CreateTemp(t.TempDir(), "output-*.png")
	if err != nil {
		t.Fatalf("create source file: %v", err)
	}
	if _, err := src.Write([]byte("not a real png, just bytes")); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	if err := src.Close(); err != nil {
		t.Fatalf("close source file: %v", err)
	}

	const objectKey = "steps/output.png"
	if err := client.Upload(ctx, src.Name(), objectKey); err != nil {
		t.Fatalf("Upload: %v", err)
	}

	// Stat the object directly (not through storage.Client, which has no
	// Stat method) to confirm Upload set a real Content-Type — so a browser
	// given a presigned GET later renders, rather than downloads, output.
	rawClient, err := miniogo.New(os.Getenv("MINIO_ENDPOINT"), &miniogo.Options{
		Creds:  credentials.NewStaticV4(os.Getenv("MINIO_ACCESS_KEY"), os.Getenv("MINIO_SECRET_KEY"), ""),
		Secure: false,
	})
	if err != nil {
		t.Fatalf("create raw minio client: %v", err)
	}

	info, err := rawClient.StatObject(ctx, os.Getenv("MINIO_BUCKET"), objectKey, miniogo.StatObjectOptions{})
	if err != nil {
		t.Fatalf("StatObject: %v", err)
	}
	if info.ContentType != "image/png" {
		t.Fatalf("expected Content-Type image/png, got %q", info.ContentType)
	}
}
