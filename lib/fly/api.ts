// The Fly.io API, reduced to the seven things the picture service needs.
//
// Two APIs, because Fly has two: the Machines REST API (apps and machines) and
// the GraphQL API (IP addresses, which the REST API does not cover). Both take
// the same bearer token.
//
// This is a thin translation and nothing else. Which machine to make, how big,
// and when to destroy it lives in render-worker.ts, where it can be tested
// without a network.
//
// Yes, google-reviews-for-shop has a file that looks like this one. Modules do
// not reach into each other - a shared copy would make this module refuse to
// install without that one, over eighty lines of fetch.

const MACHINES_API = 'https://api.machines.dev/v1'
const GRAPHQL_API = 'https://api.fly.io/graphql'

/** Something Fly said no to. `status` is the HTTP status, or 0 for a GraphQL
 * error, which arrives as a 200 with regrets inside. */
export class SplFlyError extends Error {
  readonly status: number
  /**
   * Whether this message may be shown to a shopper.
   *
   * Most of these name our hosting provider, quote its API back, or instruct the
   * site owner to paste in a key - none of which means anything to somebody who
   * came here to buy a desk, and all of which reads as the shop being broken.
   * A couple describe a WAIT rather than a fault ("give it a minute"), and those
   * are worth saying in their own words because asking again genuinely works.
   */
  readonly shopperSafe: boolean
  constructor(message: string, status = 0, opts: { shopperSafe?: boolean } = {}) {
    super(message)
    this.name = 'SplFlyError'
    this.status = status
    this.shopperSafe = opts.shopperSafe ?? false
  }
}

export type FlyMachine = {
  id: string
  name?: string
  state: string
  region: string
}

async function rest<T>(token: string, method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${MACHINES_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new SplFlyError(`Fly.io could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const detail =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : text.slice(0, 200) || res.statusText
    throw new SplFlyError(`Fly said no (${res.status}): ${detail}`, res.status)
  }
  return data as T
}

async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  let res: Response
  try {
    res = await fetch(GRAPHQL_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new SplFlyError(`Fly.io could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  }
  const payload = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null
  if (!res.ok || !payload || payload.errors?.length) {
    const detail = payload?.errors?.[0]?.message ?? `HTTP ${res.status}`
    throw new SplFlyError(`Fly said no: ${detail}`, res.ok ? 0 : res.status)
  }
  return payload.data as T
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export async function createApp(token: string, appName: string, orgSlug: string): Promise<void> {
  await rest(token, 'POST', '/apps', { app_name: appName, org_slug: orgSlug })
}

export async function deleteApp(token: string, appName: string): Promise<void> {
  try {
    await rest(token, 'DELETE', `/apps/${encodeURIComponent(appName)}?force=true`)
  } catch (error) {
    if (error instanceof SplFlyError && error.status === 404) return
    throw error
  }
}

/**
 * The organisations this token may create apps in.
 *
 * Also the capability test: an app-scoped deploy token - which is what a lot of
 * people have lying about, and quite possibly what the video converter is using -
 * can list machines all day and cannot create an app. Finding that out here, with
 * a sentence about it, beats finding it out halfway through provisioning.
 */
export async function getOrganisations(token: string): Promise<{ slug: string; type: string }[]> {
  const data = await graphql<{ organizations: { nodes: { slug: string; type: string }[] } }>(
    token,
    `query { organizations { nodes { slug type } } }`,
    {},
  )
  return data.organizations?.nodes ?? []
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

export async function listMachines(token: string, appName: string): Promise<FlyMachine[]> {
  const data = await rest<FlyMachine[]>(token, 'GET', `/apps/${encodeURIComponent(appName)}/machines`)
  return Array.isArray(data) ? data : []
}

export async function createMachine(token: string, appName: string, body: Record<string, unknown>): Promise<FlyMachine> {
  return rest<FlyMachine>(token, 'POST', `/apps/${encodeURIComponent(appName)}/machines`, body)
}

/** True when the machine reached the state inside the timeout, false when the
 * wait timed out (Fly answers 408). Anything else throws. */
export async function waitForMachine(
  token: string,
  appName: string,
  machineId: string,
  state: string,
  timeoutSeconds: number,
): Promise<boolean> {
  try {
    await rest(
      token,
      'GET',
      `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/wait?state=${state}&timeout=${Math.max(1, Math.floor(timeoutSeconds))}`,
      undefined,
      // The local abort must outlast the wait Fly itself is asked to hold, or a
      // merely slow (not stuck) start races its own client timeout and throws
      // here instead of returning false for the caller's friendly-message path.
      (timeoutSeconds + 10) * 1000,
    )
    return true
  } catch (error) {
    if (error instanceof SplFlyError && error.status === 408) return false
    throw error
  }
}

/** Destroy a machine. Idempotent - one already gone is a success, because the
 * only thing worse than a machine that will not die is a clean-up that gives up
 * on the rest of the list because of it. */
export async function destroyMachine(token: string, appName: string, machineId: string): Promise<void> {
  try {
    await rest(token, 'DELETE', `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}?force=true`)
  } catch (error) {
    if (error instanceof SplFlyError && error.status === 404) return
    throw error
  }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * A shared inbound IPv4, so <app>.fly.dev answers at all. Free, and shared with
 * every other Fly app that has one - which is fine, because Fly routes on the
 * hostname. There is deliberately no egress address here: unlike the reviews
 * scraper, nothing on the far end of a render cares what address it came from.
 */
export async function allocateSharedIpv4(token: string, appName: string): Promise<void> {
  await graphql(
    token,
    `mutation($input: AllocateIPAddressInput!) {
      allocateIpAddress(input: $input) { app { sharedIpAddress } }
    }`,
    { input: { appId: appName, type: 'shared_v4' } },
  )
}
