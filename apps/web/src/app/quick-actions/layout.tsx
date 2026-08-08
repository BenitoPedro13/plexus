import type { Metadata } from 'next'

// page.tsx is 'use client' and can't export metadata itself -- this thin Server Component
// layout is the only way to give the route its own <title> (see TASK-seo-og-metadata.md).
export const metadata: Metadata = {
  title: 'Quick Actions',
}

export default function QuickActionsLayout({ children }: LayoutProps<'/quick-actions'>) {
  return children
}
