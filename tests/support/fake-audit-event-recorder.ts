import type {
  AuditEventRecorder,
  RecordAuditEventInput,
} from "../../src/modules/audit/application/audit-event-recorder.js";

export interface FakeAuditEventRecorder extends AuditEventRecorder {
  readonly events: RecordAuditEventInput[];
}

/** Captures recorded events in memory instead of writing to a database — for asserting audit behavior in unit tests. */
export function createFakeAuditEventRecorder(): FakeAuditEventRecorder {
  const events: RecordAuditEventInput[] = [];
  return {
    events,
    async record(input: RecordAuditEventInput): Promise<void> {
      events.push(input);
    },
  };
}
