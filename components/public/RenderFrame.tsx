'use client'

import { useEffect, useRef, useState } from 'react'
import type { Group } from 'three'
import {
  applyCamera,
  applyCameraAspect,
  buildItems,
  buildRoom,
  createScene,
  disposeGroup,
  dressForRender,
  eyeLevel,
  updateWallVisibility,
} from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import type { SceneModelSource } from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import type { SceneDescription } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { PrepareOptions } from '@/modules/space-planner-for-shop/lib/three/planner-model'
import type { SavedCamera } from '@/modules/space-planner-for-shop/lib/types'

// The room, drawn once, properly, for a camera that never moves.
//
// Everything View3d does for a person - orbit controls, the resize observer, the
// coaching notes, the context-loss recovery - is absent here on purpose. There
// is nobody to coach, nothing to resize, and if the context is lost the render
// has failed and should say so rather than quietly recovering into a second
// photograph of a different moment.
//
// What it adds is quality and the signal.
//
// Quality, because for a long time this file was the live preview at a larger
// size and nothing else: it switched the shadow map on over a scene where no
// light cast and no mesh received, so the flag did nothing, and it inherited a
// three-lamp rig with no environment, which is what makes a standard material
// read as matte plastic. dressForRender is where that is put right, and it is
// called from here and nowhere else - the shopper's view is a thing being
// dragged about on a phone and wants none of it.
//
// The signal, because `window.__splRenderReady` goes true only when every model
// that is going to arrive has arrived and the scene has actually been painted;
// `window.__splRenderFailed` says the picture is not coming. The worker waits for
// one or the other and never guesses from a timer - a screenshot taken on a timer
// is how you get a photograph of half a room.

declare global {
  interface Window {
    __splRenderReady?: boolean
    __splRenderFailed?: string
    __splRenderDegraded?: number
  }
}

export type RenderFrameProps = {
  description: SceneDescription
  /**
   * `context` is '' or absent for a base model, and the add-on combination tag
   * (e.g. a desk-with-screens variant) otherwise - see plannerModelKey in
   * lib/model-resolver. Needed here, and not just on `description`'s own nodes,
   * because two sources for the SAME product (its base model and a combined
   * variant) are both real and must not collide on productId alone below.
   */
  sources: Array<SceneModelSource & { productId: string; context?: string }>
  options: PrepareOptions & { maxUniqueModels: number }
  /**
   * Where the shopper was standing when they asked for this. Null falls back to
   * the canned standpoint at the end of the room's longest wall, which is what
   * every picture used to be taken from whether it suited the room or not.
   */
  camera: SavedCamera | null
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
      const width = Math.max(2, window.innerWidth)
      const height = Math.max(2, window.innerHeight)

      const renderer = new three.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false })
      renderer.setPixelRatio(1)
      renderer.setSize(width, height, false)
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = three.PCFSoftShadowMap
      renderer.toneMapping = three.ACESFilmicToneMapping
      renderer.outputColorSpace = three.SRGBColorSpace

      const { scene, camera } = createScene()
      applyCameraAspect(camera, width / height)

      const room = buildRoom(props.description)
      scene.add(room)

      // Installed the moment there is anything to release, and replaced as more
      // is built. It used to be assigned on the very last line, so every early
      // return below - a cancelled build, a model that would not load, an
      // unsupported context - left the renderer and the room group behind. One
      // page in a throwaway browser, so it cost nothing in production, and two
      // renderers on every dev mount in Strict Mode.
      cleanup = () => {
        disposeGroup(room)
        renderer.dispose()
      }

      const models = new Map<string, SceneModelSource>()
      for (const source of props.sources) {
        // Composite for a combined-model variant, bare id for the base - the same
        // key SpacePlanner's live view and scene-plan's node lookups use. Keyed on
        // productId alone, a desk placed both plain and with screens had its two
        // sources collide here and one silently overwrote the other.
        const key = source.context ? `${source.productId}@@${source.context}` : source.productId
        models.set(key, {
          url: source.url,
          cacheKey: source.cacheKey,
          format: source.format,
          yawOffsetDeg: source.yawOffsetDeg,
          noDecimation: source.noDecimation,
          fabricKey: source.fabricKey,
          slots: source.slots,
          realMetres: source.realMetres,
          realAxis: source.realAxis,
        })
      }

      let degraded = 0
      let items: Group
      try {
        const result = await buildItems(props.description, models, props.options)
        if (cancelled) {
          disposeGroup(result.group)
          return
        }
        scene.add(result.group)
        items = result.group
        degraded = result.degraded.length
        cleanup = () => {
          disposeGroup(items)
          disposeGroup(room)
          renderer.dispose()
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        window.__splRenderFailed = `The room could not be put together: ${message}`
        setFailed(message)
        return
      }

      // Where the shopper was standing, or the canned standpoint if they never
      // said. eyeLevel positions the camera itself and hands back the target.
      if (props.camera) applyCamera(camera, props.camera)
      else eyeLevel(camera, props.description)
      camera.updateProjectionMatrix()
      // Once, rather than per frame as the live view does: the wall between the
      // camera and the room has to get out of the way, or the photograph is of
      // some plaster. It runs BEFORE the lighting is dressed, because a wall that
      // has been hidden is also a wall that stops casting - which is the missing
      // fourth wall every architectural render is drawn with anyway.
      updateWallVisibility(room, camera)

      const undress = dressForRender({ renderer, scene, description: props.description, groups: [room, items] })

      // Ambient occlusion, on a composer built here rather than in planner-scene
      // so the shopper's 3D view never downloads forty kilobytes of
      // post-processing it has no use for.
      //
      // A failure here is not a failed picture. If the composer will not build on
      // this machine the room still gets photographed, just without the contact
      // shadows - which is worth strictly more than an error page.
      let renderFrame = () => renderer.render(scene, camera)
      let disposeComposer: (() => void) | null = null
      try {
        const [{ EffectComposer }, { RenderPass }, { GTAOPass }, { OutputPass }] = await Promise.all([
          import('three/examples/jsm/postprocessing/EffectComposer.js'),
          import('three/examples/jsm/postprocessing/RenderPass.js'),
          import('three/examples/jsm/postprocessing/GTAOPass.js'),
          import('three/examples/jsm/postprocessing/OutputPass.js'),
        ])
        if (cancelled) return

        const composer = new EffectComposer(renderer)
        composer.setPixelRatio(1)
        composer.setSize(width, height)
        composer.addPass(new RenderPass(scene, camera))

        const gtao = new GTAOPass(scene, camera, width, height)
        // The world is metres, so the radius is one too: a quarter of a metre is
        // the scale of the darkening where a chair leg meets the floor, which is
        // the whole reason this pass is here. Anything much larger starts
        // shading the room rather than the contacts.
        gtao.updateGtaoMaterial({ radius: 0.25, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, screenSpaceRadius: false })
        gtao.blendIntensity = 0.85
        composer.addPass(gtao)

        // Tone mapping and colour space happen HERE, not on the canvas. A
        // composer's intermediate targets are linear and untoned, so without this
        // the picture comes out flat and washed - and it would have been the ACES
        // curve the preview has, which is the one thing this whole exercise is
        // trying to stop happening.
        composer.addPass(new OutputPass())

        renderFrame = () => composer.render()
        disposeComposer = () => composer.dispose()
      } catch {
        // No composer. The plain renderer above still draws the room, with the
        // environment and the shadows, which is the bulk of the difference.
      }

      // Paint, then wait for the browser to have actually presented it, then
      // paint once more. Reading the buffer in the same task as the last draw is
      // what makes preserveDrawingBuffer honest.
      renderFrame()
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      renderFrame()

      if (cancelled) return
      window.__splRenderDegraded = degraded
      window.__splRenderReady = true

      cleanup = () => {
        disposeComposer?.()
        undress()
        disposeGroup(items)
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 2147483647, background: '#000' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      {failed && <div data-render-failed style={{ color: '#fff' }}>{failed}</div>}
    </div>
  )
}
