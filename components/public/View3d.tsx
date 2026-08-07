'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Group, Scene, WebGLRenderer } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  applyCamera,
  applyCameraAspect,
  buildItems,
  buildRoom,
  clampEyeHeight,
  createCamera,
  createRenderer,
  createScene,
  disposeGroup,
  eyeLevel,
  frameRoom,
  readCamera,
  setEyeHeight,
  updateWallVisibility,
} from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import type { PlannerCamera, SceneModelSource } from '@/modules/space-planner-for-shop/lib/three/planner-scene'
import type { SceneDescription } from '@/modules/space-planner-for-shop/lib/scene/scene-plan'
import type { PrepareOptions } from '@/modules/space-planner-for-shop/lib/three/planner-model'
import {
  EYE_HEIGHT_MIN_M,
  EYE_HEIGHT_SEATED_M,
  EYE_HEIGHT_STANDING_M,
} from '@/modules/space-planner-for-shop/lib/types'
import type { SavedCamera } from '@/modules/space-planner-for-shop/lib/types'
import { formatLength } from '@/modules/space-planner-for-shop/lib/units'

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
  /**
   * Items whose plan size was a guess and whose mesh has now been measured -
   * the footprint actually drawn, so the flat plan can adopt it. See
   * BuildItemsResult['measured'].
   */
  onMeasuredSizes?: (measured: Array<{ itemId: string; productId: string; widthMm: number; depthMm: number; heightMm: number }>) => void
  /**
   * Hands the parent a way to read where the camera is standing, so a viewpoint
   * can be saved or photographed. Null on unmount, like registerCapture.
   */
  registerCameraProbe?: (probe: (() => SavedCamera | null) | null) => void
  /**
   * A viewpoint to jump to. The nonce is what makes "take me back to that view"
   * work twice: the camera has usually been dragged away in between, so the pose
   * is unchanged and re-applying it has to be triggered by something other than
   * the pose itself.
   */
  restore?: { camera: SavedCamera; nonce: number } | null
  /** Which units to label the eye-height control in. */
  units: 'metric' | 'imperial'
}

/** How far one notch of Alt+scroll moves the eye, in metres. */
const WHEEL_METRES = 0.0016
/** How far one press of Page Up or Page Down moves it. */
const KEY_STEP_M = 0.1
/** How long the how-to-drive note stays up before it gets out of the way. */
const HINT_LIFE_MS = 7000

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
function makeControls(camera: PlannerCamera, canvas: HTMLCanvasElement, onStart?: () => void, onEnd?: () => void): OrbitControls {
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
  if (onEnd) controls.addEventListener('end', onEnd)
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
  const controlEndRef = useRef<(() => void) | null>(null)
  // The mount effect never re-runs, so anything it reads about the scene has to
  // come through a ref or it frames a room that has since been redrawn.
  const descriptionRef = useRef(props.description)
  useEffect(() => {
    descriptionRef.current = props.description
  }, [props.description])
  // Through a ref so a new callback identity does not rebuild the scene.
  const onMeasuredRef = useRef(props.onMeasuredSizes)
  useEffect(() => {
    onMeasuredRef.current = props.onMeasuredSizes
  }, [props.onMeasuredSizes])
  const [unsupported, setUnsupported] = useState(false)
  const [degraded, setDegraded] = useState(0)
  const [busy, setBusy] = useState(true)
  const [hinted, setHinted] = useState(false)
  /** Bumped when the GPU hands the context back, to make the scene build again. */
  const [restores, setRestores] = useState(0)
  /**
   * Where the eye is, in metres, for the slider to show.
   *
   * Mirrored into React rather than read off the camera at paint time, because
   * the camera moves sixty times a second and the label does not need to. It is
   * pushed back the other way whenever a drag finishes, since orbiting up and
   * down is itself a change of height and a slider that ignored that would be
   * lying within about two seconds of the shopper touching anything.
   */
  const [eyeHeightM, setEyeHeightM] = useState(EYE_HEIGHT_STANDING_M)

  const notifyBusy = props.onBusyChange
  useEffect(() => {
    notifyBusy?.(busy)
  }, [busy, notifyBusy])

  // The note takes itself away after a few seconds.
  //
  // Until now the only thing that cleared it was touching the view, which is
  // fine on a desktop where it sits in one corner, and no use at all on a phone
  // where it lies across the room: somebody who has not yet worked out that they
  // can drag was reading the instructions on top of the very thing they were
  // being told to drag.
  useEffect(() => {
    if (busy || hinted) return
    const timer = setTimeout(() => setHinted(true), HINT_LIFE_MS)
    return () => clearTimeout(timer)
  }, [busy, hinted])

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
    // Orbiting up and down IS a change of eye height, so the slider is told about
    // it. On 'end' rather than 'change': the latter fires on every damped frame,
    // and a React state write per frame is how a smooth drag becomes a stuttering
    // one on the phones this tool is mostly used on.
    const onControlEnd = () => {
      const current = stateRef.current
      if (current) setEyeHeightM(current.camera.position.y)
    }
    const { scene, camera } = createScene()
    const controls = makeControls(camera, canvas, onControlStart, onControlEnd)
    stateRef.current = { scene, camera, renderer, controls }
    controlStartRef.current = onControlStart
    controlEndRef.current = onControlEnd

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
      if (result.measured.length > 0) onMeasuredRef.current?.(result.measured)
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
    state.controls = makeControls(camera, canvas, controlStartRef.current ?? undefined, controlEndRef.current ?? undefined)
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

  /**
   * Move the eye, from wherever the instruction came from.
   *
   * Bound once and never rebound. All three ways in - the slider, the wheel and
   * the keyboard - fire far faster than React commits, and each needs the height
   * the LAST one produced rather than the one that was on screen when the handler
   * was created. Reading the rig and the room out of refs is what makes that
   * true; there is deliberately nothing from the render in here.
   */
  const nudgeHeight = useCallback((metres: number) => {
    const state = stateRef.current
    if (!state) return
    movedRef.current = true
    setHinted(true)
    const settled = setEyeHeight(state.camera, state.controls.target, metres, descriptionRef.current)
    state.controls.update()
    setEyeHeightM(settled)
  }, [])

  // Alt (or Option) and the wheel, for anybody who would rather not go near the
  // slider. Bound to the WRAPPER in the capture phase on purpose: OrbitControls
  // owns the wheel on the canvas and treats it as zoom, so this has to see the
  // event first and stop it getting there. A listener added to the canvas
  // alongside theirs would be a coin toss decided by registration order.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheel = (event: WheelEvent) => {
      if (!event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      const state = stateRef.current
      if (!state) return
      nudgeHeight(state.camera.position.y - event.deltaY * WHEEL_METRES)
    }
    wrap.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => wrap.removeEventListener('wheel', onWheel, { capture: true })
  }, [nudgeHeight])

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

  // Where the camera is standing, for saving a viewpoint or photographing one.
  // Null before the scene exists, which the parent shows as a disabled button
  // rather than saving a pose that describes nothing.
  useEffect(() => {
    const register = props.registerCameraProbe
    if (!register) return
    register(() => {
      const state = stateRef.current
      if (!state) return null
      return readCamera(state.camera, state.controls.target)
    })
    return () => register(null)
  }, [props.registerCameraProbe])

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
    setEyeHeightM(state.camera.position.y)
    // props.description is read for its geometry only, and re-running on every
    // item change is exactly what this effect exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [props.view, roomSignature])

  // A saved viewpoint, put back.
  //
  // Declared AFTER the projection effect deliberately. Restoring a view that was
  // saved flat while the live camera is a perspective one means the parent flips
  // its perspective toggle in the same click, and that effect replaces the camera
  // and re-frames the room. Both run in the one commit, in source order, so this
  // one lands on the new camera and has the last word - which is the whole job.
  const restoreNonce = props.restore?.nonce ?? -1
  useEffect(() => {
    const state = stateRef.current
    const saved = props.restore?.camera
    if (!state || !saved || restoreNonce < 0) return
    const target = applyCamera(state.camera, saved)
    state.controls.target.copy(target)
    state.controls.update()
    movedRef.current = true
    setHinted(true)
    setEyeHeightM(state.camera.position.y)
    // Keyed on the nonce alone: the pose is stable across repeat visits to the
    // same view, so depending on it would restore the first time and do nothing
    // ever after.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [restoreNonce])

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

  const ceilingM = Math.max(EYE_HEIGHT_MIN_M + 0.2, props.description.ceilingM - 0.15)
  const shownHeight = clampEyeHeight(eyeHeightM, props.description)

  return (
    <div
      ref={wrapRef}
      style={{ position: 'absolute', inset: 0 }}
      tabIndex={-1}
      onKeyDown={(event) => {
        // Page Up and Page Down, because the arrow keys are already orbit and
        // nobody expects a page key to do anything else inside a 3D view.
        if (event.key !== 'PageUp' && event.key !== 'PageDown') return
        event.preventDefault()
        const state = stateRef.current
        if (!state) return
        nudgeHeight(state.camera.position.y + (event.key === 'PageUp' ? KEY_STEP_M : -KEY_STEP_M))
      }}
    >
      <canvas ref={canvasRef} aria-label="Three-dimensional view of the room. The item list beside it describes everything in here." />

      {/* Eye height.
          Visible, and a slider, rather than a modifier key alone. A key nobody
          is told about is a feature nobody has, this tool is used on phones
          where there is no keyboard to hold anything down on, and a person
          changing their eye height wants to know what height they have got to -
          which a wheel gesture cannot tell them and a labelled control can. The
          key and the wheel are still there for anyone who finds them. */}
      {!unsupported && (
        <div className="spl-eye">
          <label className="spl-eye-label" htmlFor="spl-eye-height">Eye height</label>
          <input
            id="spl-eye-height"
            className="spl-eye-range"
            type="range"
            min={EYE_HEIGHT_MIN_M}
            max={ceilingM}
            step={0.05}
            value={shownHeight}
            list="spl-eye-notches"
            aria-valuetext={formatLength(Math.round(shownHeight * 1000), props.units)}
            onChange={(event) => nudgeHeight(Number(event.target.value))}
          />
          <datalist id="spl-eye-notches">
            <option value={EYE_HEIGHT_SEATED_M} label="Sitting" />
            <option value={EYE_HEIGHT_STANDING_M} label="Standing" />
          </datalist>
          <span className="spl-eye-value">{formatLength(Math.round(shownHeight * 1000), props.units)}</span>
          <div className="spl-eye-presets">
            <button type="button" className="spl-eye-preset" onClick={() => nudgeHeight(EYE_HEIGHT_SEATED_M)}>
              Sitting
            </button>
            <button type="button" className="spl-eye-preset" onClick={() => nudgeHeight(EYE_HEIGHT_STANDING_M)}>
              Standing
            </button>
          </div>
        </div>
      )}

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
      {/* Two versions of the same note, picked by CSS rather than by measuring
          the browser, so it is the same on the server as it is here.
          The long one is a desktop note: it names the wheel, the right-drag and
          the Alt key, none of which a phone has. On a phone the stage is about
          190px tall, and three lines of instructions across the bottom of it is
          most of the room the note is describing. */}
      {!busy && degraded === 0 && !hinted && (
        <div className="spl-coach spl-hint">
          <span className="spl-hint-touch">Drag to look, pinch to zoom, two fingers to slide.</span>
          <span className="spl-hint-pointer">
            Drag to look around, pinch or scroll to zoom, two fingers or right-drag to slide. Hold Alt and scroll to
            change your height.
          </span>
        </div>
      )}
    </div>
  )
}
