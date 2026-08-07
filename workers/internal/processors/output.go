package processors

import (
	"fmt"
	"os"
	"path/filepath"
)

// storageDirEnv names the env var pointing at the local directory processors
// write output files into. Stand-in for real object storage — see D-11 in
// docs/90-deferred-register.md.
const storageDirEnv = "WORKER_STORAGE_DIR"

const defaultStorageDir = "./data/worker-output"

// writeOutput writes data to <WORKER_STORAGE_DIR>/<jobStepID>.<ext> and
// returns that path as the step's outputRef.
func writeOutput(jobStepID, ext string, data []byte) (string, error) {
	dir := os.Getenv(storageDirEnv)
	if dir == "" {
		dir = defaultStorageDir
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create output dir %q: %w", dir, err)
	}

	path := filepath.Join(dir, fmt.Sprintf("%s.%s", jobStepID, ext))
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", fmt.Errorf("write output %q: %w", path, err)
	}

	return path, nil
}
