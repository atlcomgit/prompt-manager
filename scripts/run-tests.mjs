import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const testsDirectory = path.resolve("out-tests/tests");
const extraArgs = process.argv.slice(2);

const testFiles = fs
  .readdirSync(testsDirectory)
  .filter((fileName) => fileName.endsWith(".test.js"))
  .sort((left, right) => left.localeCompare(right, "en"))
  .map((fileName) => path.join(testsDirectory, fileName));

const result = spawnSync(
  process.execPath,
  ["--test", ...extraArgs, ...testFiles],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
