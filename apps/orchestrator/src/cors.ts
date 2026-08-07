import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

// The orchestrator was never called cross-origin from a browser until
// TASK-apply-to-batch.md's editor Apply-to-Batch flow (apps/web) started
// hitting it directly -- /export (TASK-editor-export.md) happened to always
// run same-origin or was never verified from a real browser either. No auth
// exists yet (spec Open Question), so nothing here is credentialed: origin
// reflection (the `true` default) is safe today and is *not* the same as
// wildcard "*" with credentials, which browsers refuse anyway. Tighten via
// CORS_ORIGIN once an auth approach is decided -- see D-40 in
// docs/90-deferred-register.md.
export function corsOptions(): CorsOptions {
  const raw = process.env.CORS_ORIGIN;
  return { origin: raw ? raw.split(',').map((origin) => origin.trim()) : true };
}
