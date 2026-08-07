// Package dispatch defines the NATS JetStream stream/subject layout and the
// plain-JSON message shapes shared with the orchestrator
// (apps/orchestrator/src/jobs/dispatch-message.ts). Hand-kept in sync across
// the language boundary until proto/ exists — see docs/90-deferred-register.md.
package dispatch

const (
	StreamName      = "PLEXUS_JOBS"
	DispatchSubject = "plexus.jobs.dispatch"
	ResultsSubject  = "plexus.jobs.results"
)

type StepDispatchMessage struct {
	JobID     string                 `json:"jobId"`
	JobStepID string                 `json:"jobStepId"`
	StepID    string                 `json:"stepId"`
	Processor string                 `json:"processor"`
	Params    map[string]interface{} `json:"params"`
	InputRef  string                 `json:"inputRef"`
	Order     int                    `json:"order"`
}

type StepResultStatus string

const (
	StepResultComplete StepResultStatus = "complete"
	StepResultFailed   StepResultStatus = "failed"
)

type StepResultMessage struct {
	JobID     string           `json:"jobId"`
	JobStepID string           `json:"jobStepId"`
	Status    StepResultStatus `json:"status"`
	OutputRef string           `json:"outputRef,omitempty"`
	Error     string           `json:"error,omitempty"`
}
