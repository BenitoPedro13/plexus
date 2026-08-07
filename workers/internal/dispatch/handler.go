package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/benitopedro13/plexus/workers/internal/processors"
	"github.com/benitopedro13/plexus/workers/internal/storage"
)

// heartbeatInterval is how often Handle tells JetStream a message is still
// being worked on, via msg.InProgress(). Must stay comfortably under the
// worker-dispatch consumer's AckWait (cmd/worker/main.go) so a missed tick
// or two never risks a false redelivery. A var, not a const, so
// SetHeartbeatIntervalForTest can shorten it for tests that need to cross a
// short AckWait window without waiting on production-length timers.
var heartbeatInterval = 10 * time.Second

// SetHeartbeatIntervalForTest overrides heartbeatInterval for the life of a
// test; the returned restore func puts the production value back. Not for
// production use.
func SetHeartbeatIntervalForTest(d time.Duration) (restore func()) {
	prev := heartbeatInterval
	heartbeatInterval = d
	return func() { heartbeatInterval = prev }
}

// Handle dispatches a StepDispatchMessage to the registered built-in
// processor (workers/internal/processors) and publishes the result. An
// unparsable message is Term()'d — it's malformed, not a valid job the
// orchestrator is waiting on. An unknown processor id, a download/upload
// failure, or a processor validation/execution error all produce a normal
// StepResultFailed, since the orchestrator's job state machine is already
// listening for that status (apps/orchestrator/src/jobs/job-result-handler.ts)
// — silently dropping any of them would strand the job in RUNNING forever.
//
// Factored out of cmd/worker/main.go so it can be exercised directly
// against a real NATS instance in dispatch_test.go, independent of the
// process wiring (signal handling, consumer setup) in main().
func Handle(ctx context.Context, js jetstream.JetStream, store *storage.Client, msg jetstream.Msg) error {
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

	stopHeartbeat := startHeartbeat(msg, in.JobStepID)
	outputRef, err := runStep(ctx, store, in)
	stopHeartbeat()

	if err != nil {
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

// startHeartbeat periodically calls msg.InProgress() until the returned stop
// function is called, so JetStream's AckWait deadline never elapses while a
// processor is still legitimately running (ffmpeg/libvips operations can
// take minutes — see docs/tasks/TASK-worker-ack-heartbeat.md). Without this,
// a step that outlives AckWait gets redelivered and reprocessed concurrently
// with the still-running original, wasting CPU on duplicate work rather than
// producing a lost job. A missed InProgress() call is logged, not fatal —
// the next tick self-heals it.
func startHeartbeat(msg jetstream.Msg, jobStepID string) (stop func()) {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := msg.InProgress(); err != nil {
					log.Printf("heartbeat for step %s: %v", jobStepID, err)
				}
			case <-done:
				return
			}
		}
	}()
	return func() { close(done) }
}

// runStep downloads in.InputRef (an object-storage key) to a local temp
// file, runs the registered processor against that local copy exactly as
// before object storage existed, uploads the processor's local output back
// to object storage under a fresh key, and returns that key. Processors
// themselves are unmodified — this confines the storage I/O to one boundary
// layer, the same shape TASK-editor-export.md used for render.RunRecipe.
func runStep(ctx context.Context, store *storage.Client, in StepDispatchMessage) (outputRef string, err error) {
	fn, ok := processors.Lookup(in.Processor)
	if !ok {
		return "", fmt.Errorf("unknown processor: %s", in.Processor)
	}

	localIn, cleanupIn, err := store.Download(ctx, in.InputRef)
	if err != nil {
		return "", fmt.Errorf("download input %q: %w", in.InputRef, err)
	}
	defer cleanupIn()

	localOut, err := fn(ctx, in.JobStepID, localIn, in.Params)
	if err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(localOut) }()

	objectKey := fmt.Sprintf("steps/%s%s", in.JobStepID, filepath.Ext(localOut))
	if err := store.Upload(ctx, localOut, objectKey); err != nil {
		return "", fmt.Errorf("upload output %q: %w", localOut, err)
	}

	return objectKey, nil
}
