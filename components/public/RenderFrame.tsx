'use client'

import { useEffect, useRef, useState } from 'react'
import { buildItems, buildRoom, createScene, eyeLevel, applyCameraAspect, disposeGroup, updateWallVisibility } from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import type { SceneModelSource } from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import type { SceneDescription } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { PrepareOptions } from '@/modules/space-planner-for-shop/lib/three/planner-model'

// The room, drawn once, for a camera that never moves.
//
// Everything View3d does for a person - orbit controls, the resize observer, the
// coaching notes, the context-loss recovery - is absent here on purpose. There
// is nobody to coach, nothing to resize, and if the context is lost the render
// has failed and should say so rather than quietly recovering into a second
// photograph of a different moment.
//
// What it adds is the signal. `window.__splRenderReady` goes true only when
// every model that is going to arrive has arrived and the scene has actually
// been painted; `window.__splRenderFailed` says the picture is not coming. The
// worker waits for one or the other and never guesses from a timer - a
// screenshot taken on a timer is how you get a photograph of half a room.

declare global {
  interface Window {
    __splRenderReady?: boolean
    __splRenderFailed?: string
    __splRenderDegraded?: number
  }
}

export type RenderFrameProps = {
  description: SceneDescription
  sources: Array<SceneModelSource & { productId: string }>
  options: PrepareOptions & { maxUniqueModels: number }
}

export function RenderFrame(props: RenderFrameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    let cleanup: (() => void) | null = null

    void (async () => {
      // The renderer is made here rather than through createRenderer() because a
      // still picture wants different answers: the drawing buffer is kept (there
      // is a screenshot coming), and antialiasing is worth its cost exactly once.
      const three = await import('three')
      const renderer = new three.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false })
      renderer.setPixelRatio(1)
      renderer.setSize(window.innerWidth, window.innerHeight, false)
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = three.PCFSoftShadowMap
      renderer.toneMapping = three.ACESFilmicToneMapping
      renderer.outputColorSpace = three.SRGBColorSpace

      const { scene, camera } = createScene()
      applyCameraAspect(camera, window.innerWidth / Math.max(1, window.innerHeight))

      const room = buildRoom(props.description)
      scene.add(room)

      const models = new Map<string, SceneModelSource>()
      for (const source of props.sources) {
        models.set(source.productId, {
          url: source.url,
          cacheKey: source.cacheKey,
          format: source.format,
          yawOffsetDeg: source.yawOffsetDeg,
          noDecimation: source.noDecimation,
        })
      }

      let degraded = 0
      try {
        const result = await buildItems(props.description, models, props.options)
        if (cancelled) {
          disposeGroup(result.group)
          return
        }
        scene.add(result.group)
        degraded = result.degraded.length
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        window.__splRenderFailed = `The room could not be put together: ${message}`
        setFailed(message)
        return
      }

      // Eye level, looking into the room. A plan view photographs as a diagram;
      // the whole point of asking for a picture is to see the place from where
      // you would be standing in it. eyeLevel positions the camera itself.
      eyeLevel(camera, props.description)
      camera.updateProjectionMatrix()
      // Once, rather than per frame as the live view does: the wall between the
      // camera and the room has to get out of the way, or the photograph is of
      // some plaster.
      updateWallVisibility(room, camera)

      // Paint, then wait for the browser to have actually presented it, then
      // paint once more. Reading the buffer in the same task as the last draw is
      // what makes preserveDrawingBuffer honest.
      renderer.render(scene, camera)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      renderer.render(scene, camera)

      if (cancelled) return
      window.__splRenderDegraded = degraded
      window.__splRenderReady = true

      cleanup = () => {
        disposeGroup(room)
        renderer.dispose()
      }
    })()

    return () => {
      cancelled = true
      cleanup?.()
    }
    // Mount only. Nothing here changes: the page is built for one job and thrown
    // away, and re-running would mean two photographs of two moments.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      {failed && <div data-render-failed>{failed}</div>}
    </div>
  )
}
