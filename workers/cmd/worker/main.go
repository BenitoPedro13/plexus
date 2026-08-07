package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/benitopedro13/plexus/workers/internal/dispatch"
	"github.com/benitopedro13/plexus/workers/internal/processors"
	"github.com/benitopedro13/plexus/workers/internal/storage"
)

const dispatchDurableName = "worker-dispatch"

func main() {
	if err := processors.Startup(); err != nil {
		log.Fatalf("start libvips: %v", err)
	}
	defer processors.Shutdown()

	if err := processors.CheckAvailable(); err != nil {
		log.Fatalf("check ffmpeg: %v", err)
	}

	storageCtx, storageCancel := context.WithTimeout(context.Background(), 30*time.Second)
	store, err := storage.New(storageCtx)
	storageCancel()
	if err != nil {
		log.Fatalf("connect to object storage: %v", err)
	}

	url := os.Getenv("NATS_URL")
	if url == "" {
		url = nats.DefaultURL
	}

	nc, err := nats.Connect(url)
	if err != nil {
		log.Fatalf("connect to NATS: %v", err)
	}
	defer func() {
		if err := nc.Drain(); err != nil {
			log.Printf("drain NATS connection: %v", err)
		}
	}()

	js, err := jetstream.New(nc)
	if err != nil {
		log.Fatalf("create JetStream context: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	// Self-registers this worker's durable pull consumer, idempotently —
	// the stream itself is created by the orchestrator (see
	// docs/tasks/TASK-nats-job-dispatch.md §1).
	consumer, err := js.CreateOrUpdateConsumer(ctx, dispatch.StreamName, jetstream.ConsumerConfig{
		Durable:       dispatchDurableName,
		AckPolicy:     jetstream.AckExplicitPolicy,
		DeliverPolicy: jetstream.DeliverAllPolicy,
		FilterSubject: dispatch.DispatchSubject,
		// Defense-in-depth alongside dispatch.Handle's InProgress() heartbeat
		// (docs/tasks/TASK-worker-ack-heartbeat.md): a longer base window
		// means a brief heartbeat hiccup doesn't immediately look like a dead
		// worker. MaxDeliver stays unlimited (default) deliberately -- a
		// worker that actually crashes mid-job must still have its job
		// picked up by another replica (spec's "no lost jobs" guarantee).
		AckWait: 2 * time.Minute,
	})
	cancel()
	if err != nil {
		log.Fatalf("create dispatch consumer: %v", err)
	}

	consumeCtx, err := consumer.Consume(func(msg jetstream.Msg) {
		if err := dispatch.Handle(context.Background(), js, store, msg); err != nil {
			log.Printf("handle dispatch message: %v", err)
		}
	})
	if err != nil {
		log.Fatalf("start consuming: %v", err)
	}
	defer consumeCtx.Stop()

	log.Println("worker started, consuming", dispatch.DispatchSubject)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("worker shutting down")
}
