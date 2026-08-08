// Package storage wraps MinIO's own Go SDK (minio-go/v7 — chosen over the
// generic aws-sdk-go-v2/service/s3 per docs/tasks/TASK-presigned-upload.md's
// Porquê: live research surfaced current, documented SignatureDoesNotMatch
// failures running the AWS SDK v3 presigner against MinIO) so the Go worker
// can read a step's input object and write its output object instead of
// assuming a shared local filesystem. See D-3/D-11 in
// docs/90-deferred-register.md.
package storage

import (
	"context"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const (
	endpointEnv  = "MINIO_ENDPOINT"
	accessKeyEnv = "MINIO_ACCESS_KEY"
	secretKeyEnv = "MINIO_SECRET_KEY"
	bucketEnv    = "MINIO_BUCKET"
	useSSLEnv    = "MINIO_USE_SSL"
	// pathStyleEnv mirrors apps/orchestrator/src/upload/upload.service.ts's
	// MINIO_PATH_STYLE: unset/true keeps the client default (path-style,
	// matches self-hosted MinIO in infra/docker-compose.yml); "false" switches
	// to virtual-host-style, required by Railway's managed Bucket — see
	// docs/tasks/TASK-deploy-railway.md.
	pathStyleEnv = "MINIO_PATH_STYLE"

	// stagingDirEnv is the same WORKER_STORAGE_DIR every built-in processor
	// already reads/writes through (workers/internal/processors/output.go) —
	// Download() stages the fetched object here rather than under the OS
	// temp dir so it stays on the same volume as processor output in
	// containerized deploys.
	stagingDirEnv     = "WORKER_STORAGE_DIR"
	defaultStagingDir = "./data/worker-output"
)

// Client wraps a MinIO client bound to one bucket.
type Client struct {
	mc     *minio.Client
	bucket string
}

// New constructs a Client from the MINIO_* env vars (see .env.example) and
// ensures the configured bucket exists, creating it if not — mirrors
// output.go's own os.MkdirAll "create the directory if it doesn't exist"
// behaviour, just against a bucket instead of a directory.
func New(ctx context.Context) (*Client, error) {
	endpoint := os.Getenv(endpointEnv)
	if endpoint == "" {
		return nil, fmt.Errorf("%s is not set", endpointEnv)
	}
	bucket := os.Getenv(bucketEnv)
	if bucket == "" {
		return nil, fmt.Errorf("%s is not set", bucketEnv)
	}

	lookup := minio.BucketLookupPath
	if os.Getenv(pathStyleEnv) == "false" {
		lookup = minio.BucketLookupDNS
	}
	mc, err := minio.New(endpoint, &minio.Options{
		Creds:        credentials.NewStaticV4(os.Getenv(accessKeyEnv), os.Getenv(secretKeyEnv), ""),
		Secure:       os.Getenv(useSSLEnv) == "true",
		BucketLookup: lookup,
	})
	if err != nil {
		return nil, fmt.Errorf("create minio client for %q: %w", endpoint, err)
	}

	exists, err := mc.BucketExists(ctx, bucket)
	if err != nil {
		return nil, fmt.Errorf("check bucket %q exists: %w", bucket, err)
	}
	if !exists {
		if err := mc.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("create bucket %q: %w", bucket, err)
		}
	}

	return &Client{mc: mc, bucket: bucket}, nil
}

// Download fetches objectKey into a temp file under WORKER_STORAGE_DIR and
// returns its local path. Callers must invoke cleanup (typically via defer)
// to remove the temp file once the caller is done with it.
func (c *Client) Download(ctx context.Context, objectKey string) (localPath string, cleanup func(), err error) {
	dir := os.Getenv(stagingDirEnv)
	if dir == "" {
		dir = defaultStagingDir
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", nil, fmt.Errorf("create staging dir %q: %w", dir, err)
	}

	obj, err := c.mc.GetObject(ctx, c.bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return "", nil, fmt.Errorf("get object %q: %w", objectKey, err)
	}
	defer func() { _ = obj.Close() }()

	// GetObject itself never fails for a missing key — minio-go's Object is
	// a lazy HTTP stream, so the 404 only surfaces on the first Stat/Read.
	// Stat() up front so a missing object fails clearly, before a temp file
	// is created for it.
	if _, err := obj.Stat(); err != nil {
		return "", nil, fmt.Errorf("stat object %q: %w", objectKey, err)
	}

	tmp, err := os.CreateTemp(dir, "download-*"+filepath.Ext(objectKey))
	if err != nil {
		return "", nil, fmt.Errorf("create temp file: %w", err)
	}
	cleanup = func() { _ = os.Remove(tmp.Name()) }

	if _, err := io.Copy(tmp, obj); err != nil {
		_ = tmp.Close()
		cleanup()
		return "", nil, fmt.Errorf("download object %q: %w", objectKey, err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("close temp file for object %q: %w", objectKey, err)
	}

	return tmp.Name(), cleanup, nil
}

// Upload puts the file at localPath into the bucket under objectKey.
func (c *Client) Upload(ctx context.Context, localPath, objectKey string) error {
	contentType := mime.TypeByExtension(filepath.Ext(localPath))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	if _, err := c.mc.FPutObject(ctx, c.bucket, objectKey, localPath, minio.PutObjectOptions{
		ContentType: contentType,
	}); err != nil {
		return fmt.Errorf("upload %q as object %q: %w", localPath, objectKey, err)
	}

	return nil
}
