#!/usr/bin/env node
import { homedir } from "node:os";
import { runCli } from "./packages/cli/index.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
  homeFolder: homedir(),
});
