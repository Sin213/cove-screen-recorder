import * as fs from "fs";
import * as path from "path";

let currentRunTimestamp: string | null = null;

export function resolveEvidenceRoot(): string {
  return path.resolve("validation-artifacts/smoke");
}

export function initRunTimestamp(): string {
  currentRunTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return currentRunTimestamp;
}

export function getRunDir(): string {
  if (!currentRunTimestamp)
    throw new Error("Call initRunTimestamp() before getRunDir()");
  return path.join(resolveEvidenceRoot(), currentRunTimestamp);
}

export function createRowEvidenceDir(rowId: string): string {
  const dir = path.join(getRunDir(), rowId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeEvidence(
  dir: string,
  filename: string,
  content: string | Buffer,
): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(
    filePath,
    content,
    typeof content === "string" ? "utf8" : undefined,
  );
  return filePath;
}

export function writeJsonEvidence(
  dir: string,
  filename: string,
  data: unknown,
): string {
  return writeEvidence(dir, filename, JSON.stringify(data, null, 2));
}
