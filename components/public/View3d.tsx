'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Group, Scene, WebGLRenderer } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { applyCameraAspect, buildItems, buildRoom, createCamera, createRenderer, createScene, disposeGroup, eyeLevel, frameRoom, updateWallVisibility } from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import type { PlannerCamera, SceneModelSource } from '@/modules/space-planner-for-shop/lib/three/planner-scene'
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
  models: Map<string, SceneModelSource>
  options: PrepareOptions & { maxUniqueModels: number }
  view: 'orbit' | 'eye'
  /** False draws it flat, the way a drawing is drawn. See CameraKind. */
  perspective?: boolean
  /**
   * Hands the parent a way to take a picture of whatever is on screen, for the
   * PDF export. Called with null on unmount so nothing holds a dead context.
   */
  registerCapture?: (capture: (() => string | null) | null) => void
  /** Whether the room is still being put together, for anything waiting on it. */
  onBusyChange?: (busy: boolean) => void
}

type SceneState = {
  scene: Scene
  camera: PlannerCamera
  renderer: WebGLRenderer
  controls: OrbitControls
  room?: Group
  items?: Group
}

/**
 * One orbit rig, made the same way whichever camera it is driving.
 *
 * Pulled out because switching between perspective and orthographic means a NEW
 * set of controls: OrbitControls binds to the camera it was constructed with and
 * there is no supported way to hand it another one.
 */
function makeControls(camera: PlannerCamera, canvas: HTMLCanvasElement, onStart?: () => void): OrbitControls {
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.screenSpacePanning = false
  // Stop short of the horizon: below it the camera goes under the floor and the
  // room turns inside out, which reads as a rendering fault rather than as a
  // camera the shopper drove there.
  controls.maxPolarAngle = Math.PI * 0.495
  controls.minDistance = 0.6
  controls.maxDistance = 120
  if (onStart) controls.addEventListener('start', onStart)
  return controls
}

export function View3d(props: View3dProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<SceneState | null>(null)
  const movedRef = useRef(false)
  /** The mount effect's resize, so a camera swap can reuse it rather than repeat it. */
  const resizeRef = useRef<(() => void) | null>(null)
  const controlStartRef = useRef<(() => void) | null>(null)
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
  /** Bumped when the GPU hands the context back, to make the scene build again. */
  const [restores, setRestores] = useState(0)

  const notifyBusy = props.onBusyChange
  useEffect(() => {
    notifyBusy?.(busy)
  }, [busy, notifyBusy])

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
    const onControlStart = () => {
      movedRef.current = true
      setHinted(true)
    }
    const { scene, camera } = createScene()
    const controls = makeControls(camera, canvas, onControlStart)
    stateRef.current = { scene, camera, renderer, controls }
    controlStartRef.current = onControlStart

    let running = true
    // Everything below reads the camera and controls out of the ref rather than
    // out of this closure, because both are replaced when the projection is
    // switched - a loop rendering the camera it was born with would keep drawing
    // the old one for ever.
    const draw = () => {
      if (!running) return
      const current = stateRef.current
      if (current) {
        current.controls.update()
        if (current.room) updateWallVisibility(current.room, current.camera)
        current.renderer.render(current.scene, current.camera)
      }
      requestAnimationFrame(draw)
    }
    draw()

    const resize = () => {
      const wrap = wrapRef.current
      const current = stateRef.current
      if (!wrap || !current || wrap.clientWidth < 2 || wrap.clientHeight < 2) return
      current.renderer.setSize(wrap.clientWidth, wrap.clientHeight, false)
      applyCameraAspect(current.camera, wrap.clientWidth / Math.max(1, wrap.clientHeight))
      // A rotated phone changes the aspect ratio, and a framing worked out for
      // the old one is wrong. Somebody who has driven the camera themselves is
      // left alone; nobody else has a viewpoint worth protecting.
      if (!movedRef.current) {
        current.controls.target.copy(frameRoom(current.camera, descriptionRef.current))
        current.controls.update()
      }
    }
    resizeRef.current = resize
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
      //
      // The rebuild has to be ASKED for. This used to set the busy flag and
      // replace the scene handles, which rebuilt nothing at all - so the view
      // sat behind "putting the room together" for ever over a perfectly good
      // context, and dropped its grip on the room and item groups on the way
      // past, so the next build added a second copy of both.
      setRestores((count) => count + 1)
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
  }, [props.description, props.models, props.options, restores])

  // Perspective on or off. The camera is replaced rather than adjusted - the two
  // are different classes - and the controls with it, because OrbitControls
  // binds to one camera for life. The renderer, the scene and everything in it
  // carry straight on, so this costs a reframe and nothing else.
  useEffect(() => {
    const state = stateRef.current
    const canvas = canvasRef.current
    if (!state || !canvas) return
    const wanted = props.perspective === false ? 'orthographic' : 'perspective'
    const current = (state.camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera ? 'perspective' : 'orthographic'
    if (wanted === current) return

    state.controls.dispose()
    const camera = createCamera(wanted)
    state.camera = camera
    state.controls = makeControls(camera, canvas, controlStartRef.current ?? undefined)
    // A switch of projection is a new view of the room, so it gets framed as
    // one: whatever the shopper had driven the old camera to does not translate.
    movedRef.current = false
    resizeRef.current?.()
    state.controls.target.copy(frameRoom(camera, props.description))
    state.controls.update()
    // props.description is read for its geometry only - see the framing effect
    // below, which exists for exactly this reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [props.perspective])

  // A way to photograph the view, for the PDF export. Handed up rather than
  // exposed as a ref, so the parent never touches the WebGL context itself.
  useEffect(() => {
    const register = props.registerCapture
    if (!register) return
    register(() => {
      const state = stateRef.current
      const canvas = canvasRef.current
      if (!state || !canvas) return null
      // Rendered immediately before reading. The renderer is made without
      // preserveDrawingBuffer - keeping one costs memory on every frame for the
      // sake of a button nobody presses most days - so the buffer is only
      // guaranteed to hold anything within the same task as the draw that filled
      // it.
      state.renderer.render(state.scene, state.camera)
      try {
        return canvas.toDataURL('image/png')
      } catch {
        // A tainted canvas: some model or product photo came from an origin that
        // did not allow it to be read back. The export carries on without the
        // picture rather than failing.
        return null
      }
    })
    return () => register(null)
  }, [props.registerCapture])

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
