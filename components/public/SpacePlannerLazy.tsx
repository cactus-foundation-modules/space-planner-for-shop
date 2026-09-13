'use client'

// The planner, behind a lazy edge.
//
// WHAT THIS IS FOR. Module public pages hang off core's catch-all, and core's
// public page route reaches every module's pages through a table of lazy
// `() => import(...)` loaders. Next follows those loaders when it collects a
// route's client components, and a client component it finds there is bundled
// into the chunk group of that route - which, for the catch-all, is nearly every
// page on the site:
//
//   app/(public)/[slug]/page.tsx
//     -> lib/modules/router.public.ts
//     -> import() app/public/space-planner/render/[id]/page.tsx
//     -> components/public/RenderFrame.tsx
//     -> lib/three/planner-scene.ts
//     -> three (a STATIC import)
//
// So a product page, a category and an info page all carried the whole planner
// UI and three.js as eager `<script async>` tags. Measured on deskwell.co.uk in
// September 2026: the planner's own chunk (34 KB gzip), a second chunk holding
// its scene code and stylesheet string (34 KB gzip, shared with other code), and
// two three.js chunks (99 KB and 76 KB gzip) on every page. None of them renders
// the planner.
//
// A `dynamic()` is a real split: what sits behind it becomes a chunk of its own,
// loaded when the component renders. The pages import this wrapper and its twin,
// RenderFrameLazy, instead, so what every page carries is a few lines, and the
// planner loads on the planner.
//
// Deliberately no `ssr: false`: both still render on the server exactly as
// before, and without a `loading` fallback next/dynamic adds no Suspense boundary
// of its own, so the markup is the same markup. What changes is when the
// JavaScript arrives, not whether the HTML does.

import dynamic from 'next/dynamic'
import type { SpacePlannerProps } from '@/modules/space-planner-for-shop/components/public/SpacePlanner'

export const SpacePlannerLazy = dynamic<SpacePlannerProps>(
  () => import('@/modules/space-planner-for-shop/components/public/SpacePlanner').then((m) => m.SpacePlanner),
)
