package dispatch_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/testcontainers/testcontainers-go"
	natscontainer "github.com/testcontainers/testcontainers-go/modules/nats"

	"github.com/benitopedro13/plexus/workers/internal/dispatch"
)

// Real NATS (JetStream enabled) via testcontainers, matching
// infra/docker-compose.yml's image — no mocking the queue, mirroring the
// orchestrator side's test/support/nats-test-broker.ts.
func TestHandle_RoundTrip(t *testing.T) {
	ctx := context.Background()

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

	in := dispatch.StepDispatchMessage{
		JobID:     "job-1",
		JobStepID: "step-1",
		StepID:    "resize",
		Processor: "image.resize",
		Params:    map[string]interface{}{"width": float64(800)},
		InputRef:  "/tmp/in.jpg",
		Order:     0,
	}
	payload, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal dispatch message: %v", err)
	}
	if _, err := js.Publish(ctx, dispatch.DispatchSubject, payload); err != nil {
		t.Fatalf("publish dispatch message: %v", err)
	}

	pulled, err := dispatchConsumer.Next(jetstream.FetchMaxWait(5 * time.Second))
	if err != nil {
		t.Fatalf("pull dispatch message: %v", err)
	}

	// Handle() acks the dispatch message as its last step (see
	// handler.go) — returning nil here means that ack was sent
	// successfully, so it won't be redelivered.
	if err := dispatch.Handle(ctx, js, pulled); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	resultMsg, err := resultsConsumer.Next(jetstream.FetchMaxWait(5 * time.Second))
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

	if out.JobID != in.JobID || out.JobStepID != in.JobStepID {
		t.Fatalf("result identifies wrong job/step: %+v", out)
	}
	if out.Status != dispatch.StepResultComplete {
		t.Fatalf("expected status %q, got %q", dispatch.StepResultComplete, out.Status)
	}
	if out.OutputRef != in.InputRef {
		t.Fatalf("expected outputRef %q (stub echoes inputRef), got %q", in.InputRef, out.OutputRef)
	}
}
