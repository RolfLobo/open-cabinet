import type { Metadata } from "next";
import Link from "next/link";
import { askaiEnabled } from "@/lib/askai-access";
import { getPublishedRows } from "@/lib/published-rows";
import { GLOBAL_PER_DAY, PER_IP_PER_HOUR } from "@/lib/ask/limits";
import AskTheData from "../components/ask-the-data";

/**
 * /askai: the "Ask the data" box. Public since Sept. 17, 2026, but kept
 * off the nav and out of search indexes on purpose: it is linked from the
 * homepage only, so the people who find it are people who read the site.
 * The page explains, in plain words, what the box does with a question and
 * what it will not do, because a reader of a journalism site should never
 * have to guess where a number came from.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Ask the data",
  description: "Ask a question about executive-branch stock trades disclosed to the Office of Government Ethics. Code counts the rows; the AI only reads the question.",
  robots: { index: false, follow: false },
};

export default async function AskaiPage() {
  if (!askaiEnabled()) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <Badge />
        <h1 className="font-[family-name:var(--font-source-serif)] text-4xl text-neutral-900 mb-4">Ask the data</h1>
        <p className="text-neutral-600">The question box is turned off right now. Try again later.</p>
        <p className="mt-4 text-sm text-neutral-600">
          You can still <Link href="/all" className="underline hover:text-neutral-900">browse every trade</Link> or find a name in the{" "}
          <Link href="/#directory" className="underline hover:text-neutral-900">officials directory</Link>.
        </p>
      </div>
    );
  }

  const published = await getPublishedRows();

  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <div className="mb-6">
        <Badge />
        <p className="text-sm text-neutral-600 leading-relaxed max-w-2xl">
          An experimental feature. An AI model reads your question and turns it into a query; code runs the query
          over checked rows from 278-T and annual reports and writes every number and sentence you see. The AI writes nothing a reader sees.
          Check the &ldquo;Interpreted as&rdquo; line on each answer, and open the linked filing before you cite a figure.
        </p>
      </div>

      <AskTheData checkedCount={published.summary.checked} parsedCount={published.summary.parsed} />

      <details className="mt-6 border-t border-neutral-200 pt-4 text-sm text-neutral-600 leading-relaxed">
        <summary className="cursor-pointer font-medium text-neutral-800">How Ask works, what it covers and what gets logged</summary>
        <div className="mt-4 space-y-3">
          <p>An AI model interprets your question. Code checks that interpretation and calculates the answer from disclosure records that have completed the site’s verification process. Check the “Interpreted as” line to make sure it matches what you meant.</p>
          <p>The box covers transactions disclosed on OGE Form 278-T periodic transaction reports and in the transactions section of annual and termination reports. When an answer mixes the two, it says how many rows came from annual reports; only 278-T rows carry a late-filing flag, so late shares count 278-T rows alone. Company questions match rows with a resolved ticker symbol; most annual-report rows print no symbol, so answers about a company lean on 278-T rows. These records report transactions and dollar ranges. They do not establish current holdings, profit, motive or legality. Each question stands alone; Ask does not remember earlier questions.</p>
          <p>Questions, their interpretations and outcomes are logged for review, along with a hashed address used for rate limiting. No account is created. Do not enter personal information.</p>
          <p>This is an experimental feature and can misread a question. Answers are for informational and journalism purposes only and are not investment advice. Every figure traces to a filing you can open yourself.</p>
          <p>Limits: {PER_IP_PER_HOUR} requests per hour per address and {GLOBAL_PER_DAY} new question translations per day across the site.</p>
          <p>Read the <Link href="/methodology" className="underline hover:text-neutral-900">data methodology</Link> for how records are checked.</p>
        </div>
      </details>
    </div>
  );
}

function Badge() {
  return (
    <span className="inline-block border border-amber-700 text-amber-800 text-[11px] uppercase tracking-wider px-2 py-0.5 mb-3">
      Experimental
    </span>
  );
}
