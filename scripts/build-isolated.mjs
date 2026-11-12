import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-build-"));
const useBun = process.argv.includes("--bun");
const nextBin = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const command = useBun ? "bun" : process.execPath;
const args = useBun ? ["--bun", nextBin, "build", "--webpack"] : [nextBin, "build", "--webpack"];

const child = spawn(command, args, {
  cwd: projectRoot,
  env: { ...process.env, DATA_DIR: dataDir },
  stdio: "inherit",
});

const exitCode = await new Promise((resolve) => {
  child.once("error", (error) => {
    console.error(`[build-isolated] Unable to start ${command}: ${error.message}`);
    resolve(1);
  });
  child.once("exit", (code, signal) => {
    if (signal) console.error(`[build-isolated] Build terminated by ${signal}`);
    resolve(Number.isInteger(code) ? code : 1);
  });
});

const expectedPrefix = `${path.resolve(os.tmpdir())}${path.sep}9router-build-`;
if (path.resolve(dataDir).startsWith(expectedPrefix)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

process.exitCode = exitCode;
