// Hands a just-dropped/chosen File from the home page to whichever tool
// route it belongs in (/editor or /quick-actions), without a real file
// upload round-trip or serialization -- a File object can't survive
// sessionStorage, but it does survive a client-side (no full reload)
// App Router navigation as plain in-memory module state. Read once and
// cleared, so a direct visit to /editor or /quick-actions (no pending file
// set) or a hard refresh both correctly fall through to that page's own
// empty-state dropzone instead of silently reusing a stale file.
// See docs/tasks/TASK-home-page.md.
let pendingFile: File | null = null

export function setPendingFile(file: File): void {
  pendingFile = file
}

export function takePendingFile(): File | null {
  const file = pendingFile
  pendingFile = null
  return file
}
