# Workers

Standalone worker process entrypoints (separate from the API process) that
consume BullMQ queues defined in `modules/scheduling`. Each worker file wires a
queue to the domain-module handler that owns the job's business logic (e.g. the
warmup-send worker delegates to `modules/warmup/application`), and is
independently restartable/scalable from the API.

**Target stage**: first worker lands in Stage 8 (warmup engine).
