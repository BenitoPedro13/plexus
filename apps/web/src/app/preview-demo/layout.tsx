import type { Metadata } from 'next'

// Dev-only renderer smoke-test harness (see page.tsx's own comment) -- noindex here is
// belt-and-suspenders with robots.ts's disallow, for the case where this page is reached
// via a direct external link rather than a site crawl.
export const metadata: Metadata = {
  title: 'Preview Renderer Demo',
  robots: {
    index: false,
    follow: false,
  },
}

export default function PreviewDemoLayout({ children }: LayoutProps<'/preview-demo'>) {
  return children
}
