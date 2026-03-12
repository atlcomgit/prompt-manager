import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJsonPath = resolve(process.cwd(), "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

const version = String(packageJson.version || "").trim();
if (!version) {
  throw new Error("package.json version is missing");
}

const commands = packageJson?.contributes?.commands;
if (!Array.isArray(commands)) {
  throw new Error("package.json contributes.commands is missing");
}

const aboutCommand = commands.find(
  (command) => command?.command === "promptManager.showAbout",
);
if (!aboutCommand) {
  throw new Error("promptManager.showAbout command is missing");
}

const expectedTitle = `About ${version}`;
if (aboutCommand.title === expectedTitle) {
  process.exit(0);
}

aboutCommand.title = expectedTitle;
writeFileSync(
  packageJsonPath,
  `${JSON.stringify(packageJson, null, 2)}\n`,
  "utf8",
);
