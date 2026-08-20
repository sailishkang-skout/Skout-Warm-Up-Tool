import type { ClassificationEvidence } from "../domain/classification.js";

export const CLASSIFICATION_EVIDENCE_MAX_ITEMS = 8;
export const CLASSIFICATION_EVIDENCE_SNIPPET_CHARS = 160;

const SECRET_PATTERN = /(api[_-]?key|authorization|bearer\s+\S+|password|secret|token)=?\S*/gi;

export function boundEvidenceSnippet(text: string): string {
  const redacted = text.replace(SECRET_PATTERN, "[redacted]");
  const collapsed = redacted.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, CLASSIFICATION_EVIDENCE_SNIPPET_CHARS);
}

export function boundEvidence(items: readonly ClassificationEvidence[]): ClassificationEvidence[] {
  const unique: ClassificationEvidence[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const snippet = boundEvidenceSnippet(item.snippet);
    const ruleId = item.ruleId.trim().slice(0, 80);
    if (snippet.length === 0 || ruleId.length === 0) {
      continue;
    }
    const key = `${ruleId}:${snippet}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ ruleId, snippet });
    if (unique.length >= CLASSIFICATION_EVIDENCE_MAX_ITEMS) {
      break;
    }
  }
  return unique;
}
