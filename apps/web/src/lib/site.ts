// Canonical production domain per docs/tasks/TASK-deploy-railway.md. Override with
// NEXT_PUBLIC_SITE_URL for any environment that isn't this one (see docs/90-deferred-register.md
// for the current no-staging-environment caveat).
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://plexus.up.railway.app'

export const SITE_NAME = 'Plexus'

export const SITE_DESCRIPTION =
  'Edit photos non-destructively with a live in-browser preview, or convert and compress video and audio -- right in your browser.'
