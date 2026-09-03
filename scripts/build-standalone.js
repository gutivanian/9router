#!/usr/bin/env node
// Runs `npm run build` with HOME/USERPROFILE/APPDATA/LOCALAPPDATA redirected to
// an empty scratch directory.
//
// Why: Next.js's file tracer (`@vercel/nft`, used for `output: "standalone"`)
// treats `os.homedir()`-derived paths passed to fs calls (e.g. the CLI-tool
// auto-import routes reading `~/.config/<tool>/...`) as dynamic and eagerly
// expands them into a recursive glob over the real home directory to be safe.
// On Windows this walks into paths the OS refuses to enumerate at all — npm's
// own cache logs, `AppData\Local\Microsoft\WindowsApps` (App Execution
// Aliases) — and the build fails with EACCES/EPERM partway through.
// Pointing homedir at a throwaway empty folder sidesteps it entirely; the
// app never actually reads from these vars at *runtime*, only the tracer
// touches them at build time.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const appDir = path.resolve(__dirname, "..");
const buildHomeDir = path.join(os.tmpdir(), "9router-build-home");

fs.mkdirSync(path.join(buildHomeDir, "AppData", "Roaming"), { recursive: true });
fs.mkdirSync(path.join(buildHomeDir, "AppData", "Local"), { recursive: true });

console.log(`[build-standalone] Using scratch HOME: ${buildHomeDir}`);

try {
  execSync("npm run build", {
    stdio: "inherit",
    cwd: appDir,
    env: {
      ...process.env,
      HOME: buildHomeDir,
      USERPROFILE: buildHomeDir,
      APPDATA: path.join(buildHomeDir, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(buildHomeDir, "AppData", "Local"),
    },
  });
} catch {
  process.exit(1);
}
