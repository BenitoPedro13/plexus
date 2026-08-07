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
	natscontainer "github.com/testcontainers/testcontainers-go/modules/nats"

	"github.com/benitopedro13/plexus/workers/internal/dispatch"
	"github.com/benitopedro13/plexus/workers/internal/processors"
)

// gradient.jpg is a small committed fixture — see
// docs/tasks/TASK-builtin-processors.md.
const fixtureJPEG = "../../testdata/images/gradient.jpg"

func TestMain(m *testing.M) {
	if err := processors.Startup(); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

// testBroker holds a real NATS JetStream instance (testcontainers, matching
// infra/docker-compose.yml's image — no mocking the queue, mirroring the
// orchestrator side's test/support/nats-test-broker.ts) with the stream and
// both consumers Handle() and this test file need.
type testBroker struct {
	js               jetstream.JetStream
	dispatchConsumer jetstream.Consumer
	resultsConsumer  jetstream.Consumer
}

func newTestBroker(t *testing.T, ctx context.Context) *testBroker {
	t.Helper()

	ctr, err := natscontainer.Run(ctx, "nats:2.14.4-alpine")
	t.Cleanup(func() {
		if err := testcontainers.TerminateContainer(ctr); err != nil {
			t.Logf("terminate container: %v", err)
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

	return &testBroker{js: js, dispatchConsumer: dispatchConsumer, resultsConsumer: resultsConsumer}
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
	if err := dispatch.Handle(ctx, b.js, pulled); err != nil {
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
	t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

	in := dispatch.StepDispatchMessage{
		JobID:     "job-1",
		JobStepID: "step-1",
		StepID:    "resize",
		Processor: "image.resize",
		Params:    map[string]interface{}{"width": float64(32), "height": float64(32)},
		InputRef:  fixtureJPEG,
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
	if _, err := os.Stat(out.OutputRef); err != nil {
		t.Fatalf("expected outputRef %q to exist on disk: %v", out.OutputRef, err)
	}
}

func TestHandle_UnknownProcessor(t *testing.T) {
	ctx := context.Background()
	b := newTestBroker(t, ctx)
	t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

	in := dispatch.StepDispatchMessage{
		JobID:     "job-2",
		JobStepID: "step-2",
		StepID:    "watermark",
		Processor: "image.watermark",
		Params:    map[string]interface{}{},
		InputRef:  fixtureJPEG,
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
	t.Setenv("WORKER_STORAGE_DIR", t.TempDir())

	in := dispatch.StepDispatchMessage{
		JobID:     "job-3",
		JobStepID: "step-3",
		StepID:    "resize",
		Processor: "image.resize",
		// Missing height — a real, expected validation failure.
		Params:   map[string]interface{}{"width": float64(32)},
		InputRef: fixtureJPEG,
		Order:    0,
	}
	out := publishAndHandle(t, ctx, b, in)

	if out.Status != dispatch.StepResultFailed {
		t.Fatalf("expected status %q, got %q", dispatch.StepResultFailed, out.Status)
	}
	if out.Error == "" {
		t.Fatal("expected a non-empty error message")
	}

	// No output should have been written under WORKER_STORAGE_DIR.
	dir := os.Getenv("WORKER_STORAGE_DIR")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read storage dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected no output files for a failed step, found: %v", entries)
	}
}
