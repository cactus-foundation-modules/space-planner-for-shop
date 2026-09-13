'use client'

// The render worker's frame, behind a lazy edge.
//
// Same reason as SpacePlannerLazy, and the one that mattered more: RenderFrame
// imports lib/three/planner-scene, and that imports three STATICALLY. Imported
// directly by the render page, it put three.js into the chunk group of core's
// public catch-all route - every product, category and info page on the site -
// because Next follows the catch-all's lazy page loaders when it collects client
// components. Behind `dynamic()` it is a chunk of its own, fetched by the one
// headless browser that ever opens this page.
//
// Server rendering is left on so the page's markup is unchanged; see
// SpacePlannerLazy for why that adds no Suspense boundary.

import dynamic from 'next/dynamic'
import type { RenderFrameProps } from '@/modules/space-planner-for-shop/components/public/RenderFrame'

export const RenderFrameLazy = dynamic<RenderFrameProps>(
  () => import('@/modules/space-planner-for-shop/components/public/RenderFrame').then((m) => m.RenderFrame),
)
