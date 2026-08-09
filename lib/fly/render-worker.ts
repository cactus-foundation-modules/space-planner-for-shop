import { randomBytes } from 'crypto'
import { getMediaWorkerFlyTokenEnv } from '@/lib/config/env'
import { getMediaWorkerConfig } from '@/lib/media/media-worker-config'
import {
  allocateSharedIpv4,
  createApp,
  createMachine,
  deleteApp,
  destroyMachine,
  type FlyMachine,
  getOrganisations,
  listMachines,
  SplFlyError,
  waitForMachine,
} from '@/modules/space-planner-for-shop/lib/fly/api'
import { clearRenderWorkerApp, getRenderWorker, saveRenderWorker } from '@/modules/space-planner-for-shop/lib/db/render-worker'

// The picture machines: when to make one, how big, and - the part that decides
// whether this feature is affordable - when they die.
//
// Nothing runs between renders. There is no always-on worker, no warm pool and
// no idle machine: a picture is asked for, a machine is made for that one
// picture, and it is destroyed the moment the picture lands. Ten customers
// asking at once get ten machines and ten pictures at the same time, which costs
// exactly what ten one after another would have cost and takes a tenth as long.
//
// Three things have to go wrong at once for a machine to outlive its job:
//
//   1. The callback destroys it the moment the picture is uploaded - the prompt
//      path, and the one that runs almost every time.
//   2. auto_destroy + restart:'no' means a machine whose process exits is gone,
//      not stopped. The worker exits itself after IDLE_MS with nothing to do, so
//      a lost callback still ends in a destroyed machine.
//   3. The nightly sweep destroys anything still standing that no live job
//      claims - the backstop for a machine that wedged before it could exit.

/**
 * The worker image. Pinned per site in the database (so a site can be moved
 * forward without a module release) and defaulted here.
 */
export const DEFAULT_WORKER_IMAGE = 'ghcr.io/cactus-foundation-modules/space-planner-render-worker:v1'

/**
 * Guest size: the biggest Fly sell on the shared-nothing plans, and deliberately
 * the same shape as the video converter's machine (performance-8x, 16GB, lhr).
 *
 * This is not extravagance. The render is software-rasterised - there is no GPU
 * on the far end - so cores ARE the frame rate, and a machine that exists for
 * ninety seconds costs the same as a smaller one that exists for six minutes.
 * Paying for eight cores briefly is cheaper than paying for two for ages, and
 * the customer gets their picture while they still care about it.
 */
const MACHINE_GUEST = { cpu_kind: 'performance', cpus: 8, memory_mb: 16384 } as const

/** Idle seconds before a job machine exits of its own accord - the safety net
 * for a callback that never arrives. Generous enough to cover a slow upload. */
const IDLE_MS = 120_000

/** Regions the setup screen offers. Any Fly region string works; these are the
 * ones with names an owner recognises. */
export const WORKER_REGIONS = ['lhr', 'ams', 'cdg', 'fra', 'iad', 'ord', 'sjc', 'syd'] as const

export type RenderWorkerView = {
  configured: boolean
  /** Where the Fly key came from, so the screen can say "we already have one". */
  tokenSource: 'own' | 'media' | 'env' | null
  appName: string | null
  region: string
  image: string
  /** Set when the site is pointed at a worker somebody else runs. */
  external: boolean
  liveMachines: number
  error: string | null
}

// ---------------------------------------------------------------------------
// The pure parts, kept separate so they can be tested without a network.
// ---------------------------------------------------------------------------

/** spl-render-xxxxxxxx: unique enough for Fly's global app namespace, and a
 * collision just means another go with a fresh one. */
export function appNameCandidate(): string {
  return `spl-render-${randomBytes(4).toString('hex')}`
}

/** A machine is ours to sweep when it is a render machine that no live job
 * claims. Anything a live job still names is left alone however old it looks -
 * a render that takes four minutes is slow, not abandoned. */
export function orphanMachines(machines: FlyMachine[], claimed: Set<string>): FlyMachine[] {
  return machines.filter(
    (machine) => !claimed.has(machine.id) && machine.state !== 'destroyed' && machine.state !== 'destroying',
  )
}

export function machineCreateBody(opts: { region: string; workerToken: string; image: string; jobId: string }): Record<string, unknown> {
  return {
    name: `spl-render-${opts.jobId.slice(0, 8)}-${randomBytes(2).toString('hex')}`,
    region: opts.region,
    config: {
      image: opts.image,
      env: {
        WORKER_TOKEN: opts.workerToken,
        IDLE_MS: String(IDLE_MS),
      },
      guest: { ...MACHINE_GUEST },
      services: [
        {
          protocol: 'tcp',
          internal_port: 8080,
          ports: [{ port: 443, handlers: ['tls', 'http'] }],
        },
      ],
      metadata: { role: 'spl-render' },
      // The machine's exit IS its lifecycle. Restarting it would defeat the
      // whole arrangement: a crashed render would come back for ever.
      restart: { policy: 'no' },
      auto_destroy: true,
    },
  }
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * A Fly key, from whichever of the three places has one.
 *
 * The site's own key wins, then the one the video converter is already using
 * (Media > Video), then the environment. Borrowing is the ordinary case: a site
 * has one Fly account, and asking the owner to paste the same key a second time
 * because a different feature wants it is the kind of thing that makes people
 * give up halfway.
 */
export async function resolveFlyToken(): Promise<{ token: string | null; source: RenderWorkerView['tokenSource'] }> {
  const own = await getRenderWorker()
  if (own.flyToken) return { token: own.flyToken, source: 'own' }

  const media = await getMediaWorkerConfig()
  if (media.fly.token) return { token: media.fly.token, source: 'media' }

  const env = getMediaWorkerFlyTokenEnv()
  if (env) return { token: env, source: 'env' }

  return { token: null, source: null }
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * First-time setup: an app, an inbound address, a worker token. No machine -
 * nothing runs until somebody asks for a picture.
 *
 * `token` is optional: without one this borrows whatever key the site already
 * has. Nothing is saved unless all of it worked, and a half-made app is deleted
 * on the way out, so pressing the button twice after a failure starts clean.
 */
export async function provisionRenderWorker(opts: { token?: string; region?: string; image?: string } = {}): Promise<void> {
  const existing = await getRenderWorker()
  // Idempotent, not an error: a retry from the admin UI (or two tabs both
  // pressing the button) must not orphan the app already running - nothing
  // ever tears down an appName this site has stopped pointing at.
  if (existing.appName && existing.selfProvisioned) return
  const resolved = opts.token ? { token: opts.token, source: 'own' as const } : await resolveFlyToken()
  if (!resolved.token) {
    throw new SplFlyError('There is no Fly.io key on this site yet. Paste one in and try again.')
  }
  const region = opts.region ?? existing.region ?? 'lhr'
  const image = opts.image || existing.image || DEFAULT_WORKER_IMAGE

  const organisations = await getOrganisations(resolved.token).catch((error) => {
    if (error instanceof SplFlyError) {
      throw new SplFlyError(
        `That Fly.io key cannot create anything: ${error.message}. A key tied to a single app can only work on that app - make an organisation key (Fly dashboard > Tokens, or "fly tokens create org") and paste it in below.`,
        error.status,
      )
    }
    throw error
  })
  // An org key names one organisation; a personal key names them all, in which
  // case the personal org is the least surprising home for the app.
  const org = organisations.find((o) => o.type === 'PERSONAL') ?? organisations[0]
  if (!org) {
    throw new SplFlyError(
      'That Fly.io key cannot see any organisation, which usually means it is tied to a single app. Make an organisation key (Fly dashboard > Tokens) and paste it in below.',
    )
  }

  let appName: string | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3 && !appName; attempt += 1) {
    const candidate = appNameCandidate()
    try {
      await createApp(resolved.token, candidate, org.slug)
      appName = candidate
    } catch (error) {
      lastError = error
    }
  }
  if (!appName) throw lastError instanceof Error ? lastError : new SplFlyError('The Fly.io app could not be created.')

  try {
    await allocateSharedIpv4(resolved.token, appName)
  } catch (error) {
    // Half an app is worse than none: take it down so a retry starts clean.
    await deleteApp(resolved.token, appName).catch(() => {})
    throw error
  }

  await saveRenderWorker({
    // Only stored here when the owner typed it in. A borrowed key stays where it
    // lives, so changing it in one place changes it everywhere.
    flyToken: opts.token ?? existing.flyToken,
    appName,
    region,
    workerToken: randomBytes(24).toString('hex'),
    image,
    selfProvisioned: true,
  })
}

/** What the Pictures screen shows. Fly being unreachable is a note on the view,
 * not a failure of the screen. */
export async function getRenderWorkerView(): Promise<RenderWorkerView> {
  const worker = await getRenderWorker()
  const { token, source } = await resolveFlyToken()
  const view: RenderWorkerView = {
    configured: Boolean(worker.appName && worker.workerToken),
    tokenSource: source,
    appName: worker.appName,
    region: worker.region,
    image: worker.image || DEFAULT_WORKER_IMAGE,
    external: Boolean(worker.appName) && !worker.selfProvisioned,
    liveMachines: 0,
    error: null,
  }
  if (!view.configured || !token || !worker.appName) return view
  try {
    const machines = await listMachines(token, worker.appName)
    view.liveMachines = machines.filter((m) => m.state !== 'destroyed' && m.state !== 'destroying').length
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error)
  }
  return view
}

// ---------------------------------------------------------------------------
// Per-job machines
// ---------------------------------------------------------------------------

export type RenderTarget = { machineId: string; url: string; workerToken: string }

/**
 * A machine of this render's own, started and ready to take the job.
 *
 * `ceiling` refuses rather than queues. A queue behind a 60-second route is a
 * timeout wearing a hat, and "we are busy, try again in a minute" is a sentence
 * a customer can act on.
 */
export async function createRenderMachine(jobId: string, ceiling: number): Promise<RenderTarget> {
  const worker = await getRenderWorker()
  const { token } = await resolveFlyToken()
  if (!token || !worker.appName || !worker.workerToken) {
    throw new SplFlyError('The picture service is not set up on this site.')
  }

  if (ceiling > 0) {
    const live = (await listMachines(token, worker.appName)).filter(
      (m) => m.state !== 'destroyed' && m.state !== 'destroying',
    ).length
    if (live >= ceiling) {
      throw new SplFlyError('Quite a few pictures are being made at the moment. Give it a minute and ask again.', 0, { shopperSafe: true })
    }
  }

  const machine = await createMachine(
    token,
    worker.appName,
    machineCreateBody({
      region: worker.region,
      workerToken: worker.workerToken,
      image: worker.image || DEFAULT_WORKER_IMAGE,
      jobId,
    }),
  )
  if (!machine?.id) throw new SplFlyError('Fly.io made a machine but would not say which one.')

  // Wait for it to be up before posting the job. Fly's proxy will hold a request
  // for a machine that is starting, but a first-ever pull of a Chromium image is
  // well past what it will hold for, and a proxy timeout looks to the shopper
  // like the picture service being broken rather than being cold. Thirty seconds
  // here leaves the dispatch its own twenty inside the route's sixty.
  const started = await waitForMachine(token, worker.appName, machine.id, 'started', 30)
  if (!started) {
    await destroyMachine(token, worker.appName, machine.id).catch(() => {})
    throw new SplFlyError('The picture machine took too long to start. Please try again in a moment.', 0, { shopperSafe: true })
  }

  return {
    machineId: machine.id,
    // Fly's proxy honours fly-force-instance-id on the app's public hostname, so
    // the job lands on THIS machine rather than being balanced across whichever
    // renders happen to be running. Sending a job to the wrong machine is how
    // one customer's picture ends up on another customer's plan.
    url: `https://${worker.appName}.fly.dev/render`,
    workerToken: worker.workerToken,
  }
}

/** Put a machine away now rather than in two minutes. Never throws: a failure to
 * tidy up must not fail the picture that just succeeded. */
export async function destroyRenderMachine(machineId: string): Promise<void> {
  if (!machineId) return
  try {
    const worker = await getRenderWorker()
    const { token } = await resolveFlyToken()
    if (!token || !worker.appName) return
    await destroyMachine(token, worker.appName, machineId)
  } catch {
    // The nightly sweep will find it. See the three-layer note at the top.
  }
}

/**
 * Anything still standing that no live job claims. The third layer, and the only
 * one that catches a machine which wedged before it could exit.
 */
export async function sweepOrphanMachines(claimedIds: string[]): Promise<number> {
  const worker = await getRenderWorker()
  const { token } = await resolveFlyToken()
  if (!token || !worker.appName) return 0

  const machines = await listMachines(token, worker.appName).catch(() => [] as FlyMachine[])
  const orphans = orphanMachines(machines, new Set(claimedIds))
  await Promise.allSettled(orphans.map((machine) => destroyMachine(token, worker.appName!, machine.id)))
  return orphans.length
}

/**
 * Takes the whole thing down: machines, then the app, then the local record.
 *
 * Only ever deletes an app this site made. One the owner pointed us at by hand
 * is forgotten rather than destroyed - it may well be doing something else for
 * them, and a settings screen that deletes other people's infrastructure is not
 * a settings screen anybody should trust.
 */
export async function teardownRenderWorker(): Promise<string | null> {
  const worker = await getRenderWorker()
  const { token } = await resolveFlyToken()
  let warning: string | null = null

  if (token && worker.appName) {
    try {
      const machines = await listMachines(token, worker.appName)
      await Promise.allSettled(
        machines
          .filter((m) => m.state !== 'destroyed' && m.state !== 'destroying')
          .map((m) => destroyMachine(token, worker.appName!, m.id)),
      )
      if (worker.selfProvisioned) await deleteApp(token, worker.appName)
    } catch (error) {
      // The local half still gets cleared - an owner whose key has been revoked
      // must still be able to disconnect. What is left at Fly is named, so they
      // can sweep it themselves.
      warning = `Fly.io did not confirm the clean-up (${error instanceof Error ? error.message : String(error)}). Have a look for an app called ${worker.appName} in your Fly dashboard.`
    }
  }

  await clearRenderWorkerApp()
  return warning
}
