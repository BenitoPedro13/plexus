package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/benitopedro13/plexus/workers/internal/processors"
)

// Handle dispatches a StepDispatchMessage to the registered built-in
// processor (workers/internal/processors) and publishes the result. An
// unparsable message is Term()'d — it's malformed, not a valid job the
// orchestrator is waiting on. An unknown processor id or a processor
// validation/execution error both produce a normal StepResultFailed, since
// the orchestrator's job state machine is already listening for that status
// (apps/orchestrator/src/jobs/job-result-handler.ts) — silently dropping
// either would strand the job in RUNNING forever.
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

	log.Printf("processing job=%s step=%s processor=%s", in.JobID, in.StepID, in.Processor)

	out := StepResultMessage{
		JobID:     in.JobID,
		JobStepID: in.JobStepID,
	}

	fn, ok := processors.Lookup(in.Processor)
	if !ok {
		out.Status = StepResultFailed
		out.Error = fmt.Sprintf("unknown processor: %s", in.Processor)
	} else if outputRef, err := fn(ctx, in.JobStepID, in.InputRef, in.Params); err != nil {
		out.Status = StepResultFailed
		out.Error = err.Error()
	} else {
		out.Status = StepResultComplete
		out.OutputRef = outputRef
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
