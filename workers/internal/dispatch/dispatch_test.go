package dispatch_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/testcontainers/testcontainers-go"
	miniocontainer "github.com/testcontainers/testcontainers-go/modules/minio"
	natscontainer "github.com/testcontainers/testcontainers-go/modules/nats"

	"github.com/benitopedro13/plexus/workers/internal/dispatch"
	"github.com/benitopedro13/plexus/workers/internal/processors"
	"github.com/benitopedro13/plexus/workers/internal/storage"
)

// gradient.jpg / tiny.mp4 are small committed fixtures — see
// docs/tasks/TASK-builtin-processors.md and
// docs/tasks/TASK-video-audio-processors.md.
const (
	fixtureJPEG = "../../testdata/images/gradient.jpg"
	fixtureMP4  = "../../testdata/media/tiny.mp4"
)

func TestMain(m *testing.M) {
	if err := processors.Startup(); err != nil {
		panic(err)
	}
	if err := processors.CheckAvailable(); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

// testBroker holds a real NATS JetStream instance (testcontainers, matching
// infra/docker-compose.yml's image — no mocking the queue, mirroring the
// orchestrator side's test/support/nats-test-broker.ts) with the stream and
// both consumers Handle() and this test file need, plus a real MinIO-backed
// storage.Client (same no-mocking rule applied to object storage — see
// docs/tasks/TASK-presigned-upload.md §6).
type testBroker struct {
	js               jetstream.JetStream
	dispatchConsumer jetstream.Consumer
	resultsConsumer  jetstream.Consumer
	store            *storage.Client
}

func newTestBroker(t *testing.T, ctx context.Context) *testBroker {
	t.Helper()

	ctr, err := natscontainer.Run(ctx, "nats:2.14.4-alpine")
	t.Cleanup(func() {
		if err := testcontainers.TerminateContainer(ctr); err != nil {
			t.Logf("terminate NATS container: %v", err)
		}
	})
	if err != nil {
		t.Fatalf("start NATS container: %v", err)
	}

	url, err := ctr.ConnectionString(ctx)
	if err != nil {
		t.Fatalf("get connection string: %v", err)
	}

	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect to NATS: %v", err)
	}
	t.Cleanup(func() {
		if err := nc.Drain(); err != nil {
			t.Logf("drain connection: %v", err)
		}
	})

	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatalf("create JetStream context: %v", err)
	}

	if _, err := js.CreateStream(ctx, jetstream.StreamConfig{
		Name:      dispatch.StreamName,
		Subjects:  []string{"plexus.jobs.>"},
		Retention: jetstream.WorkQueuePolicy,
	}); err != nil {
		t.Fatalf("create stream: %v", err)
	}

	resultsConsumer, err := js.CreateOrUpdateConsumer(ctx, dispatch.StreamName, jetstream.ConsumerConfig{
		Durable:       "test-results-consumer",
		AckPolicy:     jetstream.AckExplicitPolicy,
		DeliverPolicy: jetstream.DeliverAllPolicy,
		FilterSubject: dispatch.ResultsSubject,
	})
	if err != nil {
		t.Fatalf("create results consumer: %v", err)
	}

	dispatchConsumer, err := js.CreateOrUpdateConsumer(ctx, dispatch.StreamName, jetstream.ConsumerConfig{
		Durable:       "test-dispatch-consumer",
		AckPolicy:     jetstream.AckExplicitPolicy,
		DeliverPolicy: jetstream.DeliverAllPolicy,
		FilterSubject: dispatch.DispatchSubject,
	})
	if err != nil {
		t.Fatalf("create dispatch consumer: %v", err)
	}

	store := newTestStore(t, ctx)

	return &testBroker{js: js, dispatchConsumer: dispatchConsumer, resultsConsumer: resultsConsumer, store: store}
}

// newTestStore starts a real MinIO container and returns a storage.Client
// wired against it, mirroring internal/storage/storage_test.go's own
// newTestClient helper (kept separate per-package, matching how NATS
// container setup is already duplicated per test file in this repo rather
// than shared via a common testutil package).
func newTestStore(t *testing.T, ctx context.Context) *storage.Client {
	t.Helper()

	ctr, err := miniocontainer.Run(ctx, "minio/minio:RELEASE.2025-09-07T16-13-09Z")
	t.Cleanup(func() {
		if err := testcontainers.TerminateContainer(ctr); err != nil {
			t.Logf("terminate MinIO container: %v", err)
		}
	})
	if err != nil {
		t.Fatalf("start MinIO container: %v", err)
	}

	endpoint, err := ctr.ConnectionString(ctx)
	if err != nil {
		t.Fatalf("get MinIO connection string: %v", err)
	}

	t.Setenv("MINIO_ENDPOINT", endpoint)
	t.Setenv("MINIO_ACCESS_KEY", ctr.Username)
	t.Setenv("MINIO_SECRET_KEY", ctr.Password)
	t.Setenv("MINIO_BUCKET", "plexus-test")
	t.Setenv("MINIO_USE_SSL", "false")
	t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

	store, err := storage.New(ctx)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	return store
}

// seedInput uploads the local fixture at localPath under objectKey and
// returns objectKey, standing in for a client having already presigned and
// uploaded the file (TASK-presigned-upload.md's upload flow, not exercised
// here — this test is scoped to dispatch.Handle, not the orchestrator's
// presign endpoint).
func seedInput(t *testing.T, ctx context.Context, store *storage.Client, localPath, objectKey string) string {
	t.Helper()
	if err := store.Upload(ctx, localPath, objectKey); err != nil {
		t.Fatalf("seed input %q as %q: %v", localPath, objectKey, err)
	}
	return objectKey
}

// publishAndHandle publishes in, pulls it back, and runs it through
// Handle(), returning the published StepResultMessage.
func publishAndHandle(t *testing.T, ctx context.Context, b *testBroker, in dispatch.StepDispatchMessage) dispatch.StepResultMessage {
	t.Helper()

	payload, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal dispatch message: %v", err)
	}
	if _, err := b.js.Publish(ctx, dispatch.DispatchSubject, payload); err != nil {
		t.Fatalf("publish dispatch message: %v", err)
	}

	pulled, err := b.dispatchConsumer.Next(jetstream.FetchMaxWait(5 * time.Second))
	if err != nil {
		t.Fatalf("pull dispatch message: %v", err)
	}

	// Handle() acks the dispatch message as its last step (see
	// handler.go) — returning nil here means that ack was sent
	// successfully, so it won't be redelivered.
	if err := dispatch.Handle(ctx, b.js, b.store, pulled); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	resultMsg, err := b.resultsConsumer.Next(jetstream.FetchMaxWait(5 * time.Second))
	if err != nil {
		t.Fatalf("pull result message: %v", err)
	}
	if err := resultMsg.Ack(); err != nil {
		t.Fatalf("ack result message: %v", err)
	}

	var out dispatch.StepResultMessage
	if err := json.Unmarshal(resultMsg.Data(), &out); err != nil {
		t.Fatalf("unmarshal result message: %v", err)
	}
	return out
}

func TestHandle_RoundTrip(t *testing.T) {
	ctx := context.Background()
	b := newTestBroker(t, ctx)
	inputKey := seedInput(t, ctx, b.store, fixtureJPEG, "uploads/gradient.jpg")

	in := dispatch.StepDispatchMessage{
		JobID:     "job-1",
		JobStepID: "step-1",
		StepID:    "resize",
		Processor: "image.resize",
		Params:    map[string]interface{}{"width": float64(32), "height": float64(32)},
		InputRef:  inputKey,
		Order:     0,
	}
	out := publishAndHandle(t, ctx, b, in)

	if out.JobID != in.JobID || out.JobStepID != in.JobStepID {
		t.Fatalf("result identifies wrong job/step: %+v", out)
	}
	if out.Status != dispatch.StepResultComplete {
		t.Fatalf("expected status %q, got %q (error: %s)", dispatch.StepResultComplete, out.Status, out.Error)
	}
	if out.OutputRef == "" {
		t.Fatal("expected a non-empty outputRef")
	}

	localOut, cleanup, err := b.store.Download(ctx, out.OutputRef)
	if err != nil {
		t.Fatalf("expected outputRef %q to be a fetchable object: %v", out.OutputRef, err)
	}
	defer cleanup()
	if _, err := os.Stat(localOut); err != nil {
		t.Fatalf("downloaded outputRef %q does not exist locally: %v", out.OutputRef, err)
	}
}

// TestHandle_VideoTranscode proves the dispatch/registry wiring reaches the
// ffmpeg-backed processors the same way it reaches the govips-backed image
// ones (TestHandle_RoundTrip above) — per-processor logic itself is covered
// by the table tests in internal/processors, not duplicated here for all
// four new ids.
func TestHandle_VideoTranscode(t *testing.T) {
	ctx := context.Background()
	b := newTestBroker(t, ctx)
	inputKey := seedInput(t, ctx, b.store, fixtureMP4, "uploads/tiny.mp4")

	in := dispatch.StepDispatchMessage{
		JobID:     "job-4",
		JobStepID: "step-4",
		StepID:    "transcode",
		Processor: "video.transcode",
		Params:    map[string]interface{}{"format": "mp4"},
		InputRef:  inputKey,
		Order:     0,
	}
	out := publishAndHandle(t, ctx, b, in)

	if out.Status != dispatch.StepResultComplete {
		t.Fatalf("expected status %q, got %q (error: %s)", dispatch.StepResultComplete, out.Status, out.Error)
	}
	if out.OutputRef == "" {
		t.Fatal("expected a non-empty outputRef")
	}

	localOut, cleanup, err := b.store.Download(ctx, out.OutputRef)
	if err != nil {
		t.Fatalf("expected outputRef %q to be a fetchable object: %v", out.OutputRef, err)
	}
	defer cleanup()
	if _, err := os.Stat(localOut); err != nil {
		t.Fatalf("downloaded outputRef %q does not exist locally: %v", out.OutputRef, err)
	}
}

func TestHandle_UnknownProcessor(t *testing.T) {
	ctx := context.Background()
	b := newTestBroker(t, ctx)
	inputKey := seedInput(t, ctx, b.store, fixtureJPEG, "uploads/gradient.jpg")

	in := dispatch.StepDispatchMessage{
		JobID:     "job-2",
		JobStepID: "step-2",
		StepID:    "watermark",
		Processor: "image.watermark",
		Params:    map[string]interface{}{},
		InputRef:  inputKey,
		Order:     0,
	}
	out := publishAndHandle(t, ctx, b, in)

	if out.Status != dispatch.StepResultFailed {
		t.Fatalf("expected status %q, got %q", dispatch.StepResultFailed, out.Status)
	}
	if out.Error == "" {
		t.Fatal("expected a non-empty error message")
	}
}

func TestHandle_ProcessorValidationError(t *testing.T) {
	ctx := context.Background()
	b := newTestBroker(t, ctx)
	inputKey := seedInput(t, ctx, b.store, fixtureJPEG, "uploads/gradient.jpg")

	in := dispatch.StepDispatchMessage{
		JobID:     "job-3",
		JobStepID: "step-3",
		StepID:    "resize",
		Processor: "image.resize",
		// Missing height — a real, expected validation failure.
		Params:   map[string]interface{}{"width": float64(32)},
		InputRef: inputKey,
		Order:    0,
	}
	out := publishAndHandle(t, ctx, b, in)

	if out.Status != dispatch.StepResultFailed {
		t.Fatalf("expected status %q, got %q", dispatch.StepResultFailed, out.Status)
	}
	if out.Error == "" {
		t.Fatal("expected a non-empty error message")
	}

	// No output should have been uploaded for a failed step.
	if _, _, err := b.store.Download(ctx, "steps/step-3.png"); err == nil {
		t.Fatal("expected no output object to exist for a failed step")
	}
}

// TestHandle_DownloadFailure proves a missing input object fails the step
// cleanly (StepResultFailed with a real error) rather than the processor
// panicking on a nonexistent local path — this is the failure mode object
// storage introduces that didn't exist when InputRef was always a path
// already on the worker's own disk.
func TestHandle_DownloadFailure(t *testing.T) {
	ctx := context.Background()
	b := newTestBroker(t, ctx)

	in := dispatch.StepDispatchMessage{
		JobID:     "job-5",
		JobStepID: "step-5",
		StepID:    "resize",
		Processor: "image.resize",
		Params:    map[string]interface{}{"width": float64(32), "height": float64(32)},
		InputRef:  "uploads/does-not-exist.jpg",
		Order:     0,
	}
	out := publishAndHandle(t, ctx, b, in)

	if out.Status != dispatch.StepResultFailed {
		t.Fatalf("expected status %q, got %q", dispatch.StepResultFailed, out.Status)
	}
	if out.Error == "" {
		t.Fatal("expected a non-empty error message")
	}
}
