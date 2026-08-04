'use client'

import { useEffect, useRef, useState } from 'react'
import type { Group, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import { buildItems, buildRoom, createRenderer, createScene, disposeGroup, eyeLevel, frameRoom } from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import type { SceneDescription } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { PrepareOptions } from '@/modules/space-planner-for-shop/lib/three/planner-model'

// The 3D view.
//
// Loaded only when somebody asks for it, so the planner's own page and any page
// carrying the teaser block pay nothing for three.js until the shopper switches
// to this tab. The 2D plan is the primary surface; this one is for believing it.
//
// Two failure modes are handled here rather than left to chance, because p3d has
// neither and the planner cannot inherit what does not exist: no WebGL at all,
// and a lost context. Losing the context restores the scene from the PLAN, never
// from the GPU - the number one silent killer on integrated graphics is a
// restore that tries to read back state that went with the context.

export type View3dProps = {
  description: SceneDescription
  models: Map<string, { url: string; cacheKey: string; format: string }>
  options: PrepareOptions & { maxUniqueModels: number }
  view: 'orbit' | 'eye'
}

export function View3d(props: View3dProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<{ scene: Scene; camera: PerspectiveCamera; renderer: WebGLRenderer; room?: Group; items?: Group } | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [degraded, setDegraded] = useState(0)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const renderer = createRenderer(canvas)
    if (!renderer) {
      setUnsupported(true)
      setBusy(false)
      return
    }
    const { scene, camera } = createScene()
    stateRef.current = { scene, camera, renderer }

    let running = true
    const draw = () => {
      if (!running) return
      renderer.render(scene, camera)
      requestAnimationFrame(draw)
    }
    draw()

    const resize = () => {
      const wrap = wrapRef.current
      if (!wrap) return
      renderer.setSize(wrap.clientWidth, wrap.clientHeight, false)
      camera.aspect = wrap.clientWidth / Math.max(1, wrap.clientHeight)
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    if (wrapRef.current) observer.observe(wrapRef.current)

    const onLost = (event: Event) => {
      event.preventDefault()
      setBusy(true)
    }
    const onRestored = () => {
      // Rebuild from the plan. Nothing is read back off the context, because
      // there is nothing left on it to read.
      setBusy(true)
      stateRef.current = { scene, camera, renderer }
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    return () => {
      running = false
      observer.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      renderer.dispose()
      stateRef.current = null
    }
  }, [])

  useEffect(() => {
    const state = stateRef.current
    if (!state) return
    let cancelled = false
    setBusy(true)

    if (state.room) {
      state.scene.remove(state.room)
      disposeGroup(state.room)
    }
    const room = buildRoom(props.description)
    state.scene.add(room)
    state.room = room

    void (async () => {
      const result = await buildItems(props.description, props.models, props.options)
      if (cancelled) {
        disposeGroup(result.group)
        return
      }
      const current = stateRef.current
      if (!current) return
      if (current.items) {
        current.scene.remove(current.items)
        disposeGroup(current.items)
      }
      current.scene.add(result.group)
      current.items = result.group
      setDegraded(result.degraded.length)
      setBusy(false)
    })()

    return () => {
      cancelled = true
    }
  }, [props.description, props.models, props.options])

  useEffect(() => {
    const state = stateRef.current
    if (!state) return
    if (props.view === 'eye') eyeLevel(state.camera, props.description)
    else frameRoom(state.camera, props.description)
  }, [props.view, props.description])

  if (unsupported) {
    return (
      <div style={{ padding: 'var(--space-4)', display: 'grid', gap: '0.5rem', placeContent: 'center', textAlign: 'center' }}>
        <strong>The 3D view needs a newer device</strong>
        <span className="spl-note">
          Everything else carries on working - the plan, the sizes and the item list are all here on the flat view.
        </span>
      </div>
    )
  }

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas ref={canvasRef} aria-label="Three-dimensional view of the room. The item list beside it describes everything in here." />
      {busy && (
        <div className="spl-coach" role="status">
          Putting the room together…
        </div>
      )}
      {!busy && degraded > 0 && (
        <div className="spl-coach">
          {degraded === 1 ? 'One item is' : `${degraded} items are`} showing as a plain block - its picture would not load. The size is still right.
        </div>
      )}
    </div>
  )
}
