/**
 * T-010a scripted-local runner harness — CLI entrypoint.
 *
 * Usage:
 *   node dist-validation/runner.js smoke         # Run §22 smoke suite (stop on first must-pass fail)
 *   node dist-validation/runner.js rc            # Run smoke rows in RC mode (continue through fails)
 *   node dist-validation/runner.js row <ID>      # Run a single row by ID
 *   node dist-validation/runner.js --help
 *
 * This slice: the helper is not yet implemented, so all scripted-local rows
 * skip with reason "helper-not-available". Manual rows skip with reason "manual".
 * Exit 0 when all rows are skipped or passed; exit 1 on any fail or error.
 */

import * as fs from "fs";
import * as path from "path";
import { probeSocket } from "./transport";
import { SMOKE_ROWS, SmokeRow, rowById } from "./rows";
import { RowReport, RowStatus, SkipReason, SuiteReport, SuiteKind, Verdict } from "./types";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function usage(): void {
  process.stdout.write(
    [
      "",
      "cove-screen-recorder validation runner (T-010a)",
      "",
      "Usage:",
      "  node dist-validation/runner.js smoke          Run §22 smoke suite",
      "  node dist-validation/runner.js rc             Run smoke rows in RC mode",
      "  node dist-validation/runner.js row <ID>       Run a single row by ID",
      "  node dist-validation/runner.js --help         Show this message",
      "",
      "This slice: all scripted-local rows skip with 'helper-not-available'",
      "until the v2 helper IPC socket is present at",
      "  $XDG_RUNTIME_DIR/cove-screen-recorder/engine.sock",
      "",
      "Exit codes:",
      "  0  All rows passed or skipped",
      "  1  One or more rows failed or errored",
      "  2  Bad arguments",
      "",
    ].join("\n"),
  );
}

type CliMode =
  | { kind: "smoke" }
  | { kind: "rc" }
  | { kind: "row"; id: string }
  | { kind: "help" };

function parseArgs(argv: string[]): CliMode | null {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    return { kind: "help" };
  }
  if (args[0] === "smoke") return { kind: "smoke" };
  if (args[0] === "rc") return { kind: "rc" };
  if (args[0] === "row") {
    if (!args[1]) {
      process.stderr.write("Error: 'row' requires a row ID argument\n");
      return null;
    }
    return { kind: "row", id: args[1] };
  }
  process.stderr.write(`Error: unknown command '${args[0]}'\n`);
  return null;
}

// ---------------------------------------------------------------------------
// Row execution
// ---------------------------------------------------------------------------

function makeSkipReport(row: SmokeRow, reason: SkipReason, message?: string): RowReport {
  return {
    id: row.id,
    title: row.title,
    classification: row.classification,
    tier: row.tier,
    ownerOnFail: row.ownerOnFail,
    linkedSourceCase: row.linkedSourceCase,
    status: "skip" as RowStatus,
    skipReason: reason,
    ...(message !== undefined ? { message } : {}),
  };
}

async function executeRow(row: SmokeRow, helperAvailable: boolean): Promise<RowReport> {
  switch (row.classification) {
    case "manual":
      return makeSkipReport(row, "manual", "Operator-driven; record outcome via --ingest flag (not yet implemented).");

    case "future-ci":
      return makeSkipReport(row, "future-ci", "Deferred; requires hardware not in the current workstation.");

    case "scripted-local":
      if (!helperAvailable) {
        return makeSkipReport(
          row,
          "helper-not-available",
          "v2 helper IPC socket absent — start cove-replay-engine before running scripted-local rows.",
        );
      }
      // Placeholder: real execution is wired in T-010c.
      return makeSkipReport(
        row,
        "helper-not-available",
        "Helper socket detected but row execution not yet implemented (T-010c).",
      );
  }
}

// ---------------------------------------------------------------------------
// Suite runner
// ---------------------------------------------------------------------------

function verdictFromCounts(
  totalPass: number,
  totalFail: number,
  _totalSkip: number,
  totalError: number,
): Verdict {
  if (totalFail > 0 || totalError > 0) return "fail";
  if (totalPass > 0) return "pass";
  return "skip";
}

async function runSuite(rows: SmokeRow[], kind: SuiteKind): Promise<SuiteReport> {
  const startedAt = new Date().toISOString();
  const { available: helperAvailable } = await probeSocket();

  if (!helperAvailable) {
    process.stderr.write(
      "[runner] Helper socket not found — all scripted-local rows will skip.\n",
    );
  }

  const results: RowReport[] = [];
  let stoppedEarly = false;
  let stoppedAtRow: string | undefined;

  for (const row of rows) {
    const report = await executeRow(row, helperAvailable);
    results.push(report);

    const isFail = report.status === "fail" || report.status === "error";

    // Smoke: stop on first must-pass red (N-008 §22).
    if (kind === "smoke" && isFail && row.tier === "must-pass") {
      stoppedEarly = true;
      stoppedAtRow = row.id;
      break;
    }
  }

  const completedAt = new Date().toISOString();

  let totalPass = 0;
  let totalFail = 0;
  let totalSkip = 0;
  let totalError = 0;

  for (const r of results) {
    if (r.status === "pass") totalPass++;
    else if (r.status === "fail") totalFail++;
    else if (r.status === "skip") totalSkip++;
    else if (r.status === "error") totalError++;
  }

  return {
    schema: "cove-validation-report/v1",
    suite: kind,
    startedAt,
    completedAt,
    rows: results,
    totalPass,
    totalFail,
    totalSkip,
    totalError,
    verdict: verdictFromCounts(totalPass, totalFail, totalSkip, totalError),
    ...(stoppedEarly ? { stoppedEarly, stoppedAtRow } : {}),
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printSummary(report: SuiteReport): void {
  const pad = (s: string, n: number) => s.padEnd(n);
  process.stdout.write(
    [
      "",
      `Suite: ${report.suite}  |  Verdict: ${report.verdict.toUpperCase()}  |  ${report.startedAt}`,
      `  pass=${report.totalPass}  fail=${report.totalFail}  skip=${report.totalSkip}  error=${report.totalError}`,
      "",
      pad("ID", 16) + pad("Status", 10) + pad("Class", 16) + "Reason / Message",
      "-".repeat(80),
    ].join("\n") + "\n",
  );

  for (const row of report.rows) {
    const reason = row.skipReason ?? "";
    process.stdout.write(
      pad(row.id, 16) + pad(row.status, 10) + pad(row.classification, 16) + reason + "\n",
    );
  }

  if (report.stoppedEarly) {
    process.stdout.write(`\nStopped early at ${report.stoppedAtRow ?? "?"} (first must-pass red).\n`);
  }
  process.stdout.write("\n");
}

function writeReportFile(report: SuiteReport, outPath: string): void {
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  process.stderr.write(`[runner] Report written to ${outPath}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = parseArgs(process.argv);

  if (mode === null) {
    usage();
    process.exit(2);
  }

  if (mode.kind === "help") {
    usage();
    process.exit(0);
  }

  let rows: SmokeRow[];
  let suiteKind: SuiteKind;

  switch (mode.kind) {
    case "smoke":
      rows = SMOKE_ROWS;
      suiteKind = "smoke";
      break;

    case "rc":
      rows = SMOKE_ROWS;
      suiteKind = "rc";
      break;

    case "row": {
      const found = rowById(mode.id);
      if (!found) {
        process.stderr.write(`Error: unknown row ID '${mode.id}'\n`);
        process.stderr.write(
          `Known IDs: ${SMOKE_ROWS.map((r) => r.id).join(", ")}\n`,
        );
        process.exit(2);
        return;
      }
      rows = [found];
      suiteKind = "smoke";
      break;
    }
  }

  const report = await runSuite(rows, suiteKind);
  printSummary(report);

  const outFile = path.join(
    process.cwd(),
    `validation-report-${report.suite}-${Date.now()}.json`,
  );
  writeReportFile(report, outFile);

  process.exit(report.verdict === "fail" || report.verdict === "error" ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`[runner] Fatal error: ${String(err)}\n`);
  process.exit(1);
});
