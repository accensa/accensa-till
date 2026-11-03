import {
  DEFAULT_SIMULATE_CONFIG,
  SCENARIOS,
  SIMULATIONS,
  type SimulationName,
  driveScenario,
} from "../apps/api/src/payouts/mock/scenarios.ts";

/**
 * Scripted failures against the mock provider (D2): succeed, refund, fail,
 * stall, and an empty-account payer. The demo and every reconciliation rule test
 * drive their "money moved without an audit trail" cases from here, so a failure
 * mode can be shown on demand instead of waiting for one to happen.
 *
 * Each simulated outcome must be labelled as simulated on screen and in the
 * README (DQ-2) — the line between mocked and real is the thing a judge is most
 * likely to be misled by.
 *
 * `pnpm simulate [succeed|refund|fail|stall|empty-payer]...` with no arguments
 * runs all four payout outcomes. Exits non-zero when a scenario does not produce
 * what it said it would, so the demo cannot pass by omission.
 */

function base(amount: bigint | null): string {
  return amount === null ? "none" : amount.toString();
}

function names(argv: readonly string[]): readonly SimulationName[] {
  if (argv.length === 0) {
    return Object.keys(SCENARIOS) as readonly SimulationName[];
  }
  return argv.map((argument): SimulationName => {
    if (!(SIMULATIONS as readonly string[]).includes(argument)) {
      throw new Error(
        `unknown simulation "${argument}", expected one of: ${SIMULATIONS.join(", ")}`,
      );
    }
    return argument as SimulationName;
  });
}

async function main(argv: readonly string[]): Promise<number> {
  console.log(
    `SIMULATED run — PAYOUT_PROVIDER=mock, no network, no keys, ${DEFAULT_SIMULATE_CONFIG.stuckWindowSeconds}s stuck window (DQ-2)`,
  );
  let failures = 0;
  for (const name of names(argv)) {
    try {
      const driven = await driveScenario(name);
      const status = driven.lastStatus;
      console.log(`\n${name}: ${driven.scenario.label}`);
      console.log(
        `  route    ${driven.route.depositAddress} quote=${driven.route.quoteRef ?? "none"}`,
      );
      console.log(
        `  states   ${driven.trajectory.join(" -> ")} (terminal=${driven.swapRow.terminalAt !== null})`,
      );
      // Amounts print in base units at 6 decimals: scripts/ sits outside every
      // workspace package, so @till/core's formatter does not resolve from here,
      // and a demo must not reach for a float to make a number look pretty.
      console.log(
        `  amounts  in=${base(status.amountIn)} out=${base(status.amountOut)} refunded=${base(status.refundedAmount)}`,
      );
      console.log(
        `  origin   ${status.originTxHash ?? "none"}  raw.simulated=${String(
          // The payload persisted into swaps.raw, so a mocked row stays marked.
          (status.raw as { readonly simulated?: boolean }).simulated,
        )}`,
      );
      for (const finding of driven.findings) {
        console.log(`  finding  ${finding.code} (${finding.severity}) ${finding.explanation}`);
      }
      if (driven.findings.length === 0) {
        console.log("  finding  none — the payout reconciles clean");
      }
      if (driven.ok) {
        console.log("  result   as scripted");
      } else {
        failures += 1;
        for (const problem of driven.problems) {
          console.error(`  result   ${problem}`);
        }
      }
    } catch (error) {
      failures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      // Not `scenarioFor(name).label`: the call that failed may be the one that
      // reads the label, and a report must not throw on its way to reporting.
      console.error(`\n${name}: did not run\n  result   ${reason}`);
    }
  }
  console.log(
    failures === 0
      ? "\nall scripted outcomes reached their stated end"
      : `\n${failures} scripted outcome(s) did not behave as stated`,
  );
  return failures === 0 ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
