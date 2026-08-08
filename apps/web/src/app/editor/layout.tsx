import type { Metadata } from 'next'

// page.tsx is 'use client' and can't export metadata itself -- this thin Server Component
// layout is the only way to give the route its own <title> (see TASK-seo-og-metadata.md).
export const metadata: Metadata = {
  title: 'Editor',
}

export default function EditorLayout({ children }: LayoutProps<'/editor'>) {
  return children
}
