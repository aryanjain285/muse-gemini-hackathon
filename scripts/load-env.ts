/**
 * Minimal .env loader for standalone scripts. Next injects .env.local
 * automatically inside the app; scripts run outside that, so they call this.
 * No dependency, and it never overwrites a variable already set in the shell.
 */
import fs from "node:fs";
import path from "node:path";

const FILES = [".env.local", ".env"];

export function config(cwd = process.cwd()): void {
  for (const name of FILES) {
    const file = path.join(cwd, name);
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export default config;
