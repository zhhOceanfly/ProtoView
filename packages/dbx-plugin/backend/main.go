// ProtoView DBX sidecar launcher: relay Host stdio to the Node JSON-RPC worker.
// Requires Node.js >= 18 on PATH at runtime.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func main() {
	script, err := locateSidecarScript()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[protoview-dbx] %v\n", err)
		os.Exit(1)
	}
	node, err := lookPathNode()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[protoview-dbx] Node.js not found on PATH (need >= 18): %v\n", err)
		os.Exit(1)
	}

	cmd := exec.Command(node, script)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "[protoview-dbx] sidecar failed: %v\n", err)
		os.Exit(1)
	}
}

func lookPathNode() (string, error) {
	candidates := []string{"node"}
	if runtime.GOOS == "windows" {
		candidates = []string{"node.exe", "node"}
	}
	var last error
	for _, name := range candidates {
		path, err := exec.LookPath(name)
		if err == nil {
			return path, nil
		}
		last = err
	}
	return "", last
}

func locateSidecarScript() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("resolve executable symlink: %w", err)
	}

	// Packaged layout: <plugin>/bin/<binary> → <plugin>/runtime/sidecar.js
	candidates := []string{
		filepath.Join(filepath.Dir(exe), "..", "runtime", "sidecar.js"),
		filepath.Join(filepath.Dir(exe), "runtime", "sidecar.js"),
		filepath.Join(filepath.Dir(exe), "..", "..", "runtime", "sidecar.js"),
	}
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if st, err := os.Stat(abs); err == nil && !st.IsDir() {
			return abs, nil
		}
	}
	return "", fmt.Errorf("runtime/sidecar.js not found next to %s", exe)
}
