import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Till — sell your API to agents, keep the receipts",
  description:
    "Till puts an x402 paywall on any GET API, settles on NEAR only after your upstream succeeds, routes payouts through NEAR Intents, and reconciles every payment against every payout in an append-only ledger.",
};

const TRACE = [
  { label: "GET /r/demo", value: "402 Payment Required", tone: "muted" },
  { label: "verify", value: "x402 · near:testnet · exact", tone: "ok" },
  { label: "guards", value: "price · replay · payer · rate", tone: "ok" },
  { label: "upstream", value: "data.seller.test 200", tone: "ok" },
  { label: "settle", value: "42XtdG…TJne confirmed", tone: "ok" },
  { label: "payout", value: "eth/usdc → 0x742d…1f2c", tone: "wait" },
  { label: "ledger", value: "payment_in 1.000000 = payout_out", tone: "ok" },
] as const;

const STEPS = [
  {
    index: "01",
    title: "Verify",
    body: "Till reads the payer's signed x402 payment, checks it against the terms the endpoint advertised, and refuses anything that does not match. Your upstream has not been touched yet.",
  },
  {
    index: "02",
    title: "Guards",
    body: "Replay, price floor, payer blocks, rate limits and the endpoint's own state are checked before any work is done. A guard that cannot decide refuses; it never guesses in your favour.",
  },
  {
    index: "03",
    title: "Upstream",
    body: "Your existing GET endpoint runs exactly as it does today. Till proxies the response back with its status and bytes intact, so no SDK and no rewrite are involved.",
  },
  {
    index: "04",
    title: "Settle",
    body: "Only a 2xx from your upstream is allowed to settle. The NEAR settle transaction is broadcast, written to the ledger, and a failure becomes a recorded discrepancy instead of a silent loss.",
  },
] as const;

const FEATURES = [
  {
    label: "One URL per endpoint",
    body: "Every route gets a stable /r/<slug> paywall. Its terms are the six fields a payer signs against, so the price and the pay-to address cannot drift apart.",
  },
  {
    label: "Your stack, unchanged",
    body: "Till fronts any existing GET API. No billing service, no metering middleware, no changes to the code that already serves your users.",
  },
  {
    label: "Cross-chain payouts",
    body: "Revenue leaves NEAR through NEAR Intents to the chain and 6-decimal stablecoin you choose. Quotes are taken when terms change, not per request.",
  },
  {
    label: "An append-only ledger",
    body: "Money is bigint base units and numeric(78,0). A database trigger blocks UPDATE and DELETE, so the record of what moved cannot be quietly edited.",
  },
  {
    label: "Reconciliation, in plain language",
    body: "Six deterministic rules compare every payment to its payout by transaction hash and raise a named, severity-ranked discrepancy the moment they disagree.",
  },
  {
    label: "A console, not a spreadsheet",
    body: "Endpoints, payments, held payers, open discrepancies, totals by asset and a CSV export — all from a wallet-signed session, with no keys in the browser.",
  },
] as const;

const FAQ = [
  {
    question: "What exactly does Till do?",
    answer:
      "Till puts an x402 paywall in front of an existing GET API. An agent that calls the paywall without payment gets a 402 with the terms. When it pays, Till verifies the payment, runs its guards, calls your upstream, and settles on NEAR only if the upstream returned a 2xx. It then routes the money out through NEAR Intents and reconciles the payment against the payout.",
  },
  {
    question: "Do I have to change my API?",
    answer:
      "No. You give Till the public URL of a GET endpoint. Till proxies it and returns the upstream's status and body, so your application keeps serving the same responses it always did. The work Till adds is the paywall in front of it and the ledger behind it.",
  },
  {
    question: "Does Till hold my money?",
    answer:
      "No. Payments settle to the route the seller configured and payouts leave through NEAR Intents to the seller's own destination address. Till records the movement; it does not take custody of the balance.",
  },
  {
    question: "What happens if my upstream fails after the payer paid?",
    answer:
      "Till settles only after a 2xx, so a failed upstream does not become a charge. A payment that verified but could not be delivered is tracked as an unsettled or failed attempt, and the reconciliation rules surface it rather than leaving it as a missing row.",
  },
  {
    question: "Which networks and assets work today?",
    answer:
      "The paywall runs on NEAR testnet with the x402 exact scheme. Payout assets are 6-decimal stablecoins routed by NEAR Intents. NEAR Intents has no testnet, so the payout leg is mainnet-only: the payout provider defaults to the mock, and a real mainnet payout is gated behind an explicit approval.",
  },
  {
    question: "How does reconciliation actually match things?",
    answer:
      "By transaction hash, never by amount or timing. Each payment's settle transaction is matched to the swap that paid it out, and six pure rules look for the ways that can go wrong: unsettled deliveries, orphaned deposits, stuck swaps, shortfalls, duplicates and stuck states. Anything unmatched becomes an open item with a severity, an age and a suggested action.",
  },
  {
    question: "Is this production-ready?",
    answer:
      "It is a hackathon build, not an audited payment system. The gateway, guards, ledger and reconciliation run for real against Postgres and the test suite is offline and deterministic, but the payout provider defaults to the mock and real mainnet payouts are deliberately disabled. Treat it as a working reference implementation of the flow.",
  },
  {
    question: "How do I sign in, and where do my keys live?",
    answer:
      "You sign a NEP-413 message with your NEAR wallet. Till verifies the signature against your on-chain access keys and sets an HttpOnly session cookie. Your private key never reaches the browser page, the server or the database.",
  },
] as const;

function SectionLabel({ children, index }: { children: string; index: string }) {
  return (
    <p className="eyebrow flex items-center gap-3">
      <span aria-hidden className="h-px w-6 bg-acid" />
      <span className="text-acid">{index}</span>
      <span aria-hidden className="text-faint">
        /
      </span>
      {children}
    </p>
  );
}

export default function LandingPage() {
  return (
    <>
      <section className="border-b border-line">
        <div className="mx-auto grid max-w-[1320px] gap-12 px-5 py-16 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:items-center lg:gap-16 lg:px-8 lg:py-24">
          <div>
            <SectionLabel index="01">NEAR x402 · seller-side settlement</SectionLabel>
            <h1 className="mt-6 max-w-2xl text-[2.7rem] font-semibold leading-[0.98] tracking-[-0.04em] sm:text-6xl lg:text-[4.2rem]">
              Charge agents
              <br />
              by the request.
              <br />
              <span className="text-acid">Prove every payout.</span>
            </h1>
            <p className="mt-7 max-w-xl text-[15px] leading-7 text-muted">
              Till is the merchant console for x402 on NEAR. Point it at a GET endpoint you already
              run, and agents pay per call in stablecoins — while Till verifies the payment, gates
              the work, settles only on success, and reconciles every cent that leaves.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a className="btn btn-primary h-11 px-6" href="/sign-in">
                Connect a NEAR wallet
              </a>
              <a className="btn h-11 px-6" href="#how-it-works">
                See the paid-call order
              </a>
            </div>

            <dl className="mt-12 grid grid-cols-2 gap-x-6 gap-y-6 border-t border-line pt-7 sm:grid-cols-4">
              {[
                { term: "Paid-call order", detail: "verify → guards → upstream → settle" },
                { term: "Reconcile rules", detail: "6 deterministic checks" },
                { term: "Money precision", detail: "bigint · numeric(78,0)" },
                { term: "Ledger writes", detail: "append-only, trigger-enforced" },
              ].map((item) => (
                <div key={item.term}>
                  <dt className="font-mono text-[9px] uppercase tracking-[0.16em] text-faint">
                    {item.term}
                  </dt>
                  <dd className="mt-2 font-mono text-[11px] leading-5 text-bone">{item.detail}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="eyebrow text-bone">Payment trace</span>
              <span className="chip chip-live">
                <span aria-hidden className="h-1.5 w-1.5 bg-mint" />
                Settled
              </span>
            </div>
            <ul className="divide-y divide-line">
              {TRACE.map((row, index) => (
                <li
                  className="grid grid-cols-[24px_minmax(0,90px)_minmax(0,1fr)] items-start gap-3 px-5 py-3"
                  key={row.label}
                >
                  <span className="font-mono text-[9px] leading-5 text-faint">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="font-mono text-[10px] uppercase leading-5 tracking-[0.12em] text-muted">
                    {row.label}
                  </span>
                  <span
                    className={`font-mono text-[11px] leading-5 ${
                      row.tone === "ok"
                        ? "text-mint"
                        : row.tone === "wait"
                          ? "text-amber"
                          : "text-bone"
                    }`}
                  >
                    {row.value}
                  </span>
                </li>
              ))}
            </ul>
            <div className="border-t border-line bg-coal px-5 py-4">
              <p className="font-mono text-[9px] uppercase leading-5 tracking-[0.14em] text-faint">
                Illustrative trace. Addresses shortened; amounts follow the seed data, not a live
                sale.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-line" id="product">
        <div className="mx-auto max-w-[1320px] px-5 py-16 lg:px-8 lg:py-24">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
            <div>
              <SectionLabel index="02">The gap</SectionLabel>
              <h2 className="mt-5 max-w-xl text-3xl font-semibold leading-[1.05] tracking-[-0.03em] sm:text-4xl">
                Taking the money was never the hard part.
              </h2>
              <p className="mt-6 max-w-lg text-sm leading-7 text-muted">
                An agent can send a stablecoin in under a second. Knowing whether the work ran,
                whether the payment cleared, and whether the payout landed is the part that turns
                into support tickets, spreadsheets and money nobody can account for.
              </p>
            </div>
            <div className="grid gap-px border border-line bg-line sm:grid-cols-3">
              {[
                {
                  title: "Did it clear?",
                  body: "A signed payment can be malformed, replayed or for the wrong terms. Till verifies before your code runs, not after.",
                },
                {
                  title: "Did the work happen?",
                  body: "A payment that settles for a 500 is a refund waiting to happen. Till settles only on a 2xx from your upstream.",
                },
                {
                  title: "Did the money arrive?",
                  body: "Cross-chain payouts fail in quiet ways. Till matches each payment to its payout by transaction hash and names the gap.",
                },
              ].map((item) => (
                <div className="bg-panel p-6" key={item.title}>
                  <h3 className="text-[15px] font-semibold text-bone">{item.title}</h3>
                  <p className="mt-3 text-[13px] leading-6 text-muted">{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-line bg-coal" id="how-it-works">
        <div className="mx-auto max-w-[1320px] px-5 py-16 lg:px-8 lg:py-24">
          <div className="flex flex-col justify-between gap-6 border-b border-line pb-8 lg:flex-row lg:items-end">
            <div>
              <SectionLabel index="03">The paid-call order</SectionLabel>
              <h2 className="mt-5 max-w-2xl text-3xl font-semibold leading-[1.05] tracking-[-0.03em] sm:text-4xl">
                Four steps, in one order, every time.
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-6 text-muted">
              The order is a hard rule, not a convention: nothing settles before your upstream has
              answered, and nothing reaches your upstream before the payment has verified.
            </p>
          </div>

          <ol className="mt-10 grid gap-px border border-line bg-line md:grid-cols-2 xl:grid-cols-4">
            {STEPS.map((step) => (
              <li className="bg-panel p-6" key={step.index}>
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-[10px] tracking-[0.16em] text-acid">
                    {step.index}
                  </span>
                  <span aria-hidden className="h-px w-6 bg-line-bright" />
                </div>
                <h3 className="mt-8 text-xl font-semibold tracking-[-0.01em] text-bone">
                  {step.title}
                </h3>
                <p className="mt-3 text-[13px] leading-6 text-muted">{step.body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-6 grid gap-px border border-line bg-line sm:grid-cols-2">
            <div className="bg-ink p-6">
              <p className="eyebrow text-muted">Then · payout</p>
              <p className="mt-3 text-[13px] leading-6 text-muted">
                Revenue leaves through NEAR Intents to the chain and 6-decimal stablecoin the seller
                chose. Quotes are taken when the terms change; a payout never re-prices a payment
                after the fact.
              </p>
            </div>
            <div className="bg-ink p-6">
              <p className="eyebrow text-muted">Finally · reconcile</p>
              <p className="mt-3 text-[13px] leading-6 text-muted">
                Six pure rules compare the payment and its payout by transaction hash. A mismatch
                becomes an open item with a severity, an age and a plain-language next step.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-line">
        <div className="mx-auto max-w-[1320px] px-5 py-16 lg:px-8 lg:py-24">
          <SectionLabel index="04">What you get</SectionLabel>
          <h2 className="mt-5 max-w-2xl text-3xl font-semibold leading-[1.05] tracking-[-0.03em] sm:text-4xl">
            The payment flow, and the books behind it.
          </h2>

          <div className="mt-10 grid gap-px border border-line bg-line md:grid-cols-2 xl:grid-cols-3">
            {FEATURES.map((feature) => (
              <div className="bg-panel p-6" key={feature.label}>
                <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-acid">
                  {feature.label}
                </h3>
                <p className="mt-4 text-[13px] leading-6 text-muted">{feature.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 border border-line px-6 py-5">
            <span className="eyebrow text-faint">Built on</span>
            {[
              "@fastnear/x402",
              "NEAR Testnet",
              "NEAR Intents · 1Click",
              "NEP-413 sign-in",
              "Postgres · numeric(78,0)",
            ].map((item) => (
              <span className="font-mono text-[11px] text-muted" key={item}>
                {item}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-line" id="faq">
        <div className="mx-auto grid max-w-[1320px] gap-10 px-5 py-16 lg:grid-cols-[minmax(0,0.62fr)_minmax(0,1.38fr)] lg:gap-16 lg:px-8 lg:py-24">
          <div>
            <SectionLabel index="05">FAQ</SectionLabel>
            <h2 className="mt-5 text-3xl font-semibold leading-[1.05] tracking-[-0.03em] sm:text-4xl">
              Straight answers, including the limits.
            </h2>
            <p className="mt-6 max-w-sm text-sm leading-6 text-muted">
              What Till does, what it deliberately does not do, and where the hackathon build stops.
            </p>
          </div>

          <div className="border-t border-line">
            {FAQ.map((item, index) => (
              <details
                className="group border-b border-line"
                key={item.question}
                open={index === 0}
              >
                <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-5">
                  <span className="flex gap-4">
                    <span className="mt-0.5 font-mono text-[9px] text-faint">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="text-[15px] font-medium leading-6 text-bone">
                      {item.question}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className="mt-0.5 font-mono text-sm leading-6 text-acid transition-transform duration-150 group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="pb-6 pl-8 pr-8 text-[13px] leading-7 text-muted">{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="mx-auto flex max-w-[1320px] flex-col justify-between gap-8 px-5 py-16 lg:flex-row lg:items-end lg:px-8 lg:py-20">
          <div>
            <SectionLabel index="06">Start</SectionLabel>
            <h2 className="mt-5 max-w-2xl text-3xl font-semibold leading-[1.02] tracking-[-0.03em] sm:text-5xl">
              Put a paywall in front of your API.
            </h2>
            <p className="mt-5 max-w-lg text-sm leading-7 text-muted">
              Sign in with a NEAR wallet, point Till at one GET endpoint, and watch the first paid
              call move from 402 to settled to reconciled.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a className="btn btn-primary h-11 px-6" href="/sign-in">
              Open the console
            </a>
            <a className="btn h-11 px-6" href="#faq">
              Read the FAQ
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
