package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// Handle is a stub executor: it proves the dispatch/result transport and
// message contract without doing any real image/video processing. It
// always reports "complete" regardless of processor/params, discarding a
// dispatch message rather than reprocessing it forever if it isn't valid
// JSON. Real ffmpeg/libvips execution is the next task
// (docs/tasks/TASK-nats-job-dispatch.md, "Explicitly out of scope").
//
// Factored out of cmd/worker/main.go so it can be exercised directly
// against a real NATS instance in dispatch_test.go, independent of the
// process wiring (signal handling, consumer setup) in main().
func Handle(ctx context.Context, js jetstream.JetStream, msg jetstream.Msg) error {
	var in StepDispatchMessage
	if err := json.Unmarshal(msg.Data(), &in); err != nil {
		if termErr := msg.Term(); termErr != nil {
			return fmt.Errorf("discard unparsable dispatch message: %w (term failed: %v)", err, termErr)
		}
		return fmt.Errorf("discard unparsable dispatch message: %w", err)
	}

	log.Printf("processing job=%s step=%s processor=%s (stub, no-op)", in.JobID, in.StepID, in.Processor)

	out := StepResultMessage{
		JobID:     in.JobID,
		JobStepID: in.JobStepID,
		Status:    StepResultComplete,
		OutputRef: in.InputRef,
	}

	payload, err := json.Marshal(out)
	if err != nil {
		return fmt.Errorf("marshal result for step %s: %w", in.JobStepID, err)
	}

	publishCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if _, err := js.Publish(publishCtx, ResultsSubject, payload); err != nil {
		return fmt.Errorf("publish result for step %s: %w", in.JobStepID, err)
	}

	if err := msg.Ack(); err != nil {
		return fmt.Errorf("ack dispatch message for step %s: %w", in.JobStepID, err)
	}

	return nil
}
