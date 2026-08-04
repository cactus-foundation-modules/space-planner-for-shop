'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Group, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildItems, buildRoom, createRenderer, createScene, disposeGroup, eyeLevel, frameRoom, updateWallVisibility } from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import type { SceneDescription } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { PrepareOptions } from '@/modules/space-planner-for-shop/lib/three/planner-model'

// The 3D view.
//
// Loaded only when somebody asks for it, so the planner's own page and any page
// carrying the teaser block pay nothing for three.js until the shopper switches
// to this tab. The 2D plan is the primary surface; this one is for believing it.
//
// It is a view you can move. A fixed camera looks like a rendering bug - people
// try to drag it, nothing happens, and they conclude the tool is broken - so
// orbit, pan and zoom are here from the start. OrbitControls ships inside the
// three package the site already carries, so this costs no new dependency.
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

type SceneState = {
  scene: Scene
  camera: PerspectiveCamera
  renderer: WebGLRenderer
  controls: OrbitControls
  room?: Group
  items?: Group
}

export function View3d(props: View3dProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<SceneState | null>(null)
  const movedRef = useRef(false)
  // The mount effect never re-runs, so anything it reads about the scene has to
  // come through a ref or it frames a room that has since been redrawn.
  const descriptionRef = useRef(props.description)
  useEffect(() => {
    descriptionRef.current = props.description
  }, [props.description])
  const [unsupported, setUnsupported] = useState(false)
  const [degraded, setDegraded] = useState(0)
  const [busy, setBusy] = useState(true)
  const [hinted, setHinted] = useState(false)

  // The room, as against what is standing in it. Reframing the camera every time
  // somebody nudges a chair would throw their viewpoint away on every keystroke,
  // so the camera only answers to this.
  const roomSignature = useMemo(
    () =>
      JSON.stringify([
        props.description.floor.outline,
        props.description.ceilingM,
        props.description.obstructions.map((obstruction) => obstruction.outline),
      ]),
    [props.description],
  )

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
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.screenSpacePanning = false
    // Stop short of the horizon: below it the camera goes under the floor and
    // the room turns inside out, which reads as a rendering fault rather than as
    // a camera the shopper drove there.
    controls.maxPolarAngle = Math.PI * 0.495
    controls.minDistance = 0.6
    controls.maxDistance = 120
    controls.addEventListener('start', () => {
      movedRef.current = true
      setHinted(true)
    })
    stateRef.current = { scene, camera, renderer, controls }

    let running = true
    const draw = () => {
      if (!running) return
      controls.update()
      const room = stateRef.current?.room
      if (room) updateWallVisibility(room, camera)
      renderer.render(scene, camera)
      requestAnimationFrame(draw)
    }
    draw()

    const resize = () => {
      const wrap = wrapRef.current
      if (!wrap || wrap.clientWidth < 2 || wrap.clientHeight < 2) return
      renderer.setSize(wrap.clientWidth, wrap.clientHeight, false)
      camera.aspect = wrap.clientWidth / Math.max(1, wrap.clientHeight)
      camera.updateProjectionMatrix()
      // A rotated phone changes the aspect ratio, and a framing worked out for
      // the old one is wrong. Somebody who has driven the camera themselves is
      // left alone; nobody else has a viewpoint worth protecting.
      if (!movedRef.current) {
        controls.target.copy(frameRoom(camera, descriptionRef.current))
        controls.update()
      }
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
      stateRef.current = { scene, camera, renderer, controls }
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    return () => {
      running = false
      observer.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      controls.dispose()
      renderer.dispose()
      stateRef.current = null
    }
    // Mount only: the description is read through a ref, and re-running this
    // would tear down the WebGL context on every drag.
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

  // Camera. Switching view is always obeyed; a change of room re-frames because
  // the old viewpoint no longer describes anywhere. Moving the furniture does
  // neither, which is the whole point of keying this on the room signature.
  useEffect(() => {
    const state = stateRef.current
    if (!state) return
    const target = props.view === 'eye' ? eyeLevel(state.camera, props.description) : frameRoom(state.camera, props.description)
    state.controls.target.copy(target)
    state.controls.update()
    movedRef.current = false
    // props.description is read for its geometry only, and re-running on every
    // item change is exactly what this effect exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [props.view, roomSignature])

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
      {!busy && degraded === 0 && !hinted && (
        <div className="spl-coach">Drag to look around, pinch or scroll to zoom, two fingers or right-drag to slide.</div>
      )}
    </div>
  )
}
