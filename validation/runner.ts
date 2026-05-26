/**
 * T-010a scripted-local runner harness — CLI entrypoint.
 *
 * Usage:
 *   node dist-validation/runner.js smoke         # Run §22 smoke suite (stop on first must-pass fail)
 *   node dist-validation/runner.js rc            # Run smoke rows in RC mode (continue through fails)
 *   node dist-validation/runner.js row <ID>      # Run a single row by ID
 *   node dist-validation/runner.js --help
 *
 * Automated rows: VAL-PKG-001, VAL-PROC-001, VAL-PROC-007
 * Not-implemented rows: scripted-local rows requiring capture/replay/export stubs
 * Manual rows: operator-driven, skipped with reason "manual"
 */

import * as fs from "fs";
import * as path from "path";
import { resolveSocketPath } from "./transport";
import { SMOKE_ROWS, SmokeRow, rowById } from "./rows";
import {
  RowReport,
  RowStatus,
  SkipReason,
  SuiteReport,
  SuiteKind,
  Verdict,
} from "./types";
import { RpcClient } from "./rpc-client";
import {
  driveValPkg001,
  driveValProc001,
  driveValProc007,
  driveValCap003,
  driveValCap004,
  driveValProc002,
  driveValProc003,
  driveValEnc001,
  driveValSeg001,
  driveValSeg003,
  driveValExp001,
  driveValExp010,
  driveValExp012,
  driveValReg002,
  driveValUi003,
  driveNotImplemented,
  NOT_IMPLEMENTED_REASONS,
  DriverContext,
} from "./drivers";
import { initRunTimestamp, getRunDir } from "./evidence";

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
      "Automated rows (helper must be running or runner will spawn one):",
      "  VAL-PKG-001   engine.health + engine.version probe",
      "  VAL-PROC-001  process cleanup after IDLE shutdown",
      "  VAL-PROC-007  pactl absence in helper process tree",
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

function makeSkipReport(
  row: SmokeRow,
  reason: SkipReason,
  message?: string,
): RowReport {
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

const SELF_SPAWNING_ROW_IDS = new Set([
  "VAL-EXP-001",
  "VAL-EXP-010",
  "VAL-EXP-012",
  "VAL-REG-002",
  "VAL-PROC-001",
  "VAL-PROC-007",
  "VAL-CAP-003",
  "VAL-CAP-004",
  "VAL-CAP-013",
  "VAL-CAP-014",
  "VAL-CAP-016",
  "VAL-PROC-002",
  "VAL-PROC-003",
  "VAL-ENC-001",
  "VAL-SEG-001",
  "VAL-SEG-003",
  "VAL-UI-003",
]);

async function dispatchScriptedLocal(
  row: SmokeRow,
  ctx: DriverContext,
): Promise<RowReport> {
  switch (row.id) {
    case "VAL-PKG-001":
      return driveValPkg001(row, ctx);
    case "VAL-EXP-001":
      return driveValExp001(row, ctx);
    case "VAL-EXP-010":
      return driveValExp010(row, ctx);
    case "VAL-EXP-012":
      return driveValExp012(row, ctx);
    case "VAL-REG-002":
      return driveValReg002(row, ctx);
    case "VAL-CAP-003":
      return driveValCap003(row, ctx);
    case "VAL-CAP-004":
      return driveValCap004(row, ctx);
    case "VAL-CAP-013":
      return driveValCap004(row, ctx);
    case "VAL-CAP-014":
      return driveValCap004(row, ctx);
    case "VAL-CAP-016":
      return driveValCap004(row, ctx);
    case "VAL-PROC-001":
      return driveValProc001(row, ctx);
    case "VAL-PROC-002":
      return driveValProc002(row, ctx);
    case "VAL-PROC-003":
      return driveValProc003(row, ctx);
    case "VAL-PROC-007":
      return driveValProc007(row, ctx);
    case "VAL-ENC-001":
      return driveValEnc001(row, ctx);
    case "VAL-SEG-001":
      return driveValSeg001(row, ctx);
    case "VAL-SEG-003":
      return driveValSeg003(row, ctx);
    case "VAL-UI-003":
      return driveValUi003(row, ctx);
    default: {
      const reason = NOT_IMPLEMENTED_REASONS[row.id];
      if (reason) {
        return driveNotImplemented(row, reason);
      }
      return driveNotImplemented(row, "No driver implemented for this row");
    }
  }
}

async function executeRow(
  row: SmokeRow,
  helperAvailable: boolean,
  ctx: DriverContext,
): Promise<RowReport> {
  switch (row.classification) {
    case "manual":
      return makeSkipReport(
        row,
        "manual",
        "Operator-driven; record outcome via --ingest flag (not yet implemented).",
      );

    case "future-ci":
      return makeSkipReport(
        row,
        "future-ci",
        "Deferred; requires hardware not in the current workstation.",
      );

    case "scripted-local":
      if (!helperAvailable && !SELF_SPAWNING_ROW_IDS.has(row.id)) {
        return makeSkipReport(
          row,
          "helper-not-available",
          "v2 helper IPC socket absent — start cove-replay-engine before running scripted-local rows.",
        );
      }
      return dispatchScriptedLocal(row, ctx);
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

async function runSuite(
  rows: SmokeRow[],
  kind: SuiteKind,
): Promise<SuiteReport> {
  const startedAt = new Date().toISOString();
  initRunTimestamp();
  const socketPath = resolveSocketPath();

  let rpc: RpcClient | null = null;
  let helperAvailable = false;

  try {
    rpc = await RpcClient.connect(socketPath, 5_000);
    helperAvailable = true;
    process.stderr.write(
      `[runner] Connected to helper at ${socketPath}\n`,
    );
  } catch {
    process.stderr.write(
      "[runner] Helper socket not found — all scripted-local rows will skip.\n",
    );
  }

  const ctx: DriverContext = {
    rpc,
    socketPath: resolveSocketPath(),
  };

  const results: RowReport[] = [];
  let stoppedEarly = false;
  let stoppedAtRow: string | undefined;

  for (const row of rows) {
    const report = await executeRow(row, helperAvailable, ctx);
    results.push(report);

    const label = `${report.id}: ${report.status}`;
    const detail = report.skipReason
      ? ` (${report.skipReason})`
      : report.message
        ? ` — ${report.message}`
        : "";
    process.stderr.write(`[runner] ${label}${detail}\n`);

    const isFail = report.status === "fail" || report.status === "error";

    if (kind === "smoke" && isFail && row.tier === "must-pass") {
      stoppedEarly = true;
      stoppedAtRow = row.id;
      break;
    }
  }

  if (rpc) rpc.close();

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
      pad("ID", 16) +
        pad("Status", 10) +
        pad("Class", 16) +
        "Reason / Message",
      "-".repeat(80),
    ].join("\n") + "\n",
  );

  for (const row of report.rows) {
    const detail = row.skipReason ?? row.message ?? "";
    process.stdout.write(
      pad(row.id, 16) +
        pad(row.status, 10) +
        pad(row.classification, 16) +
        detail +
        "\n",
    );
  }

  if (report.stoppedEarly) {
    process.stdout.write(
      `\nStopped early at ${report.stoppedAtRow ?? "?"} (first must-pass red).\n`,
    );
  }
  process.stdout.write("\n");
}

function writeReportFile(report: SuiteReport, outPath: string): void {
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  process.stderr.write(`[runner] Report written to ${outPath}\n`);

  try {
    const evidenceReport = path.join(getRunDir(), "report.json");
    fs.mkdirSync(path.dirname(evidenceReport), { recursive: true });
    fs.writeFileSync(
      evidenceReport,
      JSON.stringify(report, null, 2),
      "utf8",
    );
    process.stderr.write(`[runner] Evidence report: ${evidenceReport}\n`);
  } catch {
    // evidence dir write is best-effort
  }
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
      rows = SMOKE_ROWS.filter((r) => r.smokeOrder <= 20);
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

  process.exit(
    report.verdict === "fail" || report.verdict === "error" ? 1 : 0,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[runner] Fatal error: ${String(err)}\n`);
  process.exit(1);
});
