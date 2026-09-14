import Link from "next/link";
import { AI_USE_FEEDBACK_PATH, AI_USE_METHODOLOGY_PATH } from "@/lib/ai-use-note";

/**
 * The AI-use disclosure, the same wording everywhere (lib/ai-use-note.ts).
 * Small gray text, no card: a credit line, not a banner.
 */
export default function AiUseNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs text-neutral-500 leading-relaxed max-w-3xl ${className}`}>
      Rows are extracted from OGE filings by automated parsing (Claude PDF
      reading, text-layer and OCR cross-checks) and reviewed by a mix of
      software and human checks; the status on each row says which. Open the
      source PDF to confirm any row, and{" "}
      <Link href={AI_USE_FEEDBACK_PATH} className="underline decoration-dotted underline-offset-2 hover:text-neutral-900">
        tell us if something is wrong
      </Link>
      .{" "}
      <Link href={AI_USE_METHODOLOGY_PATH} className="underline decoration-dotted underline-offset-2 hover:text-neutral-900">
        How rows are checked
      </Link>
      .
    </p>
  );
}
