import { createHash } from "node:crypto";
import type { ClassificationMessageView } from "./classification-context.js";

export function computeClassificationInputHash(input: {
  readonly classifierVersion: string;
  readonly taxonomyVersion?: string;
  readonly current: ClassificationMessageView;
  readonly recent: readonly ClassificationMessageView[];
}): string {
  const canonical = JSON.stringify({
    classifierVersion: input.classifierVersion,
    ...(input.taxonomyVersion ? { taxonomyVersion: input.taxonomyVersion } : {}),
    current: input.current,
    recent: input.recent,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
