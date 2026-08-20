export interface AiClassificationRequest {
  readonly systemPrompt: string;
  readonly userPayload: string;
}

/**
 * HTTP/model boundary only. Returns parsed JSON (or throws). Never decides
 * labels — `ConversationClassifier` validates.
 */
export interface AiClassifierProvider {
  readonly model: string;
  classifyRaw(request: AiClassificationRequest): Promise<unknown>;
}
