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
)

const dispatchDurableName = "worker-dispatch"

func main() {
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
	})
	cancel()
	if err != nil {
		log.Fatalf("create dispatch consumer: %v", err)
	}

	consumeCtx, err := consumer.Consume(func(msg jetstream.Msg) {
		if err := dispatch.Handle(context.Background(), js, msg); err != nil {
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
