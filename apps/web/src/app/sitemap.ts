import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/site'

// /jobs (per-browser localStorage state) and /preview-demo (dev harness, disallowed in
// robots.ts) are deliberately excluded -- neither has evergreen content to index.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: 'monthly', priority: 1 },
    { url: `${SITE_URL}/editor`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/quick-actions`, changeFrequency: 'monthly', priority: 0.6 },
  ]
}
