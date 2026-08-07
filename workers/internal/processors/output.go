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

// outputPath returns <WORKER_STORAGE_DIR>/<jobStepID>.<ext>, creating the
// directory if needed. Shared by writeOutput (govips processors, which
// export to an in-memory []byte first) and the ffmpeg-backed processors
// (which pass this path to ffmpeg as its output argument and let the
// subprocess write the file directly).
func outputPath(jobStepID, ext string) (string, error) {
	dir := os.Getenv(storageDirEnv)
	if dir == "" {
		dir = defaultStorageDir
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create output dir %q: %w", dir, err)
	}

	return filepath.Join(dir, fmt.Sprintf("%s.%s", jobStepID, ext)), nil
}

// writeOutput writes data to <WORKER_STORAGE_DIR>/<jobStepID>.<ext> and
// returns that path as the step's outputRef.
func writeOutput(jobStepID, ext string, data []byte) (string, error) {
	path, err := outputPath(jobStepID, ext)
	if err != nil {
		return "", err
	}

	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", fmt.Errorf("write output %q: %w", path, err)
	}

	return path, nil
}
