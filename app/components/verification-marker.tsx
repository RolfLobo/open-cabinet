import { SHORT_LABEL, type RowVerification } from "@/lib/row-verification";
import { NOT_YET_CHECKED_EXPLAINER } from "@/lib/ai-use-note";

export default function VerificationMarker({
  verification,
}: {
  verification: RowVerification | null;
}) {
  return (
    <details className="mt-1 text-xs text-neutral-600">
      <summary
        className={`cursor-pointer ${verification?.score === 0 ? "font-semibold text-amber-900" : ""}`}
        title={verification?.note ?? "No verification record is available for this row"}
      >
        {verification ? SHORT_LABEL[verification.state] : "Not yet checked"}
      </summary>
      <p className="mt-1 max-w-sm leading-relaxed">
        {verification?.note ?? "No verification record is available for this row"}
        {(!verification || verification.state === "single_read") && (
          <span className="block text-neutral-400">({NOT_YET_CHECKED_EXPLAINER})</span>
        )}
      </p>
    </details>
  );
}
