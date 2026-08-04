import { describe, expect, it } from 'vitest'
import { appNameCandidate, machineCreateBody, orphanMachines } from '@/modules/space-planner-for-shop/lib/fly/render-worker'
import type { FlyMachine } from '@/modules/space-planner-for-shop/lib/fly/api'

// The decisions, without a network.
//
// Two of these three are about money. A machine the sweep declines to destroy is
// one somebody pays for until they notice, and a machine created without
// auto_destroy is one that survives its own job - so both are pinned here rather
// than left to a code review to keep noticing.

const machine = (id: string, state: string): FlyMachine => ({ id, state, region: 'lhr' })

describe('appNameCandidate', () => {
  it('is a legal Fly app name', () => {
    expect(appNameCandidate()).toMatch(/^spl-render-[0-9a-f]{8}$/)
  })

  it('does not repeat itself', () => {
    const names = new Set(Array.from({ length: 50 }, () => appNameCandidate()))
    expect(names.size).toBe(50)
  })
})

describe('orphanMachines', () => {
  it('leaves a machine a live job still claims, however long it has been going', () => {
    const machines = [machine('a', 'started'), machine('b', 'started')]
    expect(orphanMachines(machines, new Set(['a'])).map((m) => m.id)).toEqual(['b'])
  })

  it('sweeps a machine nothing claims, whatever state it wedged in', () => {
    const machines = [machine('a', 'started'), machine('b', 'stopped'), machine('c', 'failed')]
    expect(orphanMachines(machines, new Set()).map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not try to destroy what Fly has already destroyed', () => {
    const machines = [machine('a', 'destroyed'), machine('b', 'destroying')]
    expect(orphanMachines(machines, new Set())).toEqual([])
  })
})

describe('machineCreateBody', () => {
  const body = machineCreateBody({ region: 'lhr', workerToken: 'tok', image: 'img:v1', jobId: 'abcdef1234' })
  const config = (body as { config: Record<string, unknown> }).config

  it('asks for the same guest as the video converter', () => {
    expect(config.guest).toEqual({ cpu_kind: 'performance', cpus: 8, memory_mb: 16384 })
  })

  it('dies when its process does, rather than coming back for ever', () => {
    expect(config.auto_destroy).toBe(true)
    expect(config.restart).toEqual({ policy: 'no' })
  })

  it('carries the service block, or Fly would never route the job to it', () => {
    expect(config.services).toHaveLength(1)
  })

  it('gives the worker its token and an idle clock to exit on', () => {
    expect(config.env).toMatchObject({ WORKER_TOKEN: 'tok' })
    expect(Number((config.env as Record<string, string>).IDLE_MS)).toBeGreaterThan(0)
  })
})
