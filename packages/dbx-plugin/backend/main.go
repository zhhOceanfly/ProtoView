// ApiMan (ProtoView) DBX sidecar launcher: relay Host stdio to the Node JSON-RPC worker.
// Requires Node.js >= 18 on PATH at runtime (declared via host.binary).
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

const minNodeMajor = 18

func main() {
	script, err := locateSidecarScript()
	if err != nil {
		fail("%v", err)
	}
	node, err := ensureNode()
	if err != nil {
		fail("%v", err)
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
		fail("failed to start Node sidecar (%s %s): %v", node, script, err)
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[apiman-dbx] "+format+"\n", args...)
	os.Exit(1)
}

func ensureNode() (string, error) {
	node, err := lookPathNode()
	if err != nil {
		return "", fmt.Errorf(
			"Node.js >= %d is required but was not found on PATH.\n"+
				"  Install Node.js LTS from https://nodejs.org/ then fully restart DBX.\n"+
				"  ApiMan's sidecar is a Go launcher that runs runtime/sidecar.js via `node` (host.binary).\n"+
				"  LookPath error: %v",
			minNodeMajor, err,
		)
	}

	out, err := exec.Command(node, "-v").CombinedOutput()
	versionText := strings.TrimSpace(string(out))
	if err != nil {
		return "", fmt.Errorf(
			"found %q but `node -v` failed (%v).\nOutput: %s\nInstall a working Node.js >= %d from https://nodejs.org/",
			node, err, versionText, minNodeMajor,
		)
	}
	major, ok := parseNodeMajor(versionText)
	if !ok {
		return "", fmt.Errorf("could not parse Node version from %q (path %s)", versionText, node)
	}
	if major < minNodeMajor {
		return "", fmt.Errorf(
			"Node.js %s is too old (need >= %d). Path: %s\nUpgrade from https://nodejs.org/ then restart DBX.",
			versionText, minNodeMajor, node,
		)
	}
	return node, nil
}

func parseNodeMajor(versionText string) (int, bool) {
	// Accept v18.0.0 / 18.0.0
	re := regexp.MustCompile(`v?(\d+)\.`)
	m := re.FindStringSubmatch(versionText)
	if len(m) < 2 {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false
	}
	return n, true
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
	return "", fmt.Errorf(
		"runtime/sidecar.js not found next to %s.\nThe plugin package may be incomplete; reinstall ApiMan from the store or a .dbxp.",
		exe,
	)
}
