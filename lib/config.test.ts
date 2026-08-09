import { describe, expect, it } from 'vitest'
import { SPL_CONFIG_DEFAULTS, SplConfigSchema } from '@/modules/space-planner-for-shop/lib/config'

// Two settings were offered to owners that nothing anywhere read.
//
// `glbExportEnabled` was the worse of the pair, because it was presented as the
// control over whether customers could take the 3D models away - a promise it
// could not have kept even with a reader, since the planner downloads the models
// into the browser in order to draw them. `roomIdleFlagMonths` merely governed
// nothing: `listIdleRooms` has no caller.
//
// The point of this file is that they stay gone. A schema key is cheap to add
// back by accident, and a switch that appears to do something is worse than no
// switch at all.

describe('settings that were removed', () => {
  it('does not offer a 3D-model download switch', () => {
    expect(SPL_CONFIG_DEFAULTS).not.toHaveProperty('glbExportEnabled')
  })

  it('does not offer an idle-space flag', () => {
    expect(SPL_CONFIG_DEFAULTS).not.toHaveProperty('roomIdleFlagMonths')
  })

  it('drops both from a settings blob saved before they went', () => {
    // A live site has these two in its stored JSON. Parsing has to survive that
    // and hand back a config without them, rather than refusing and dropping the
    // owner's other settings back to the defaults.
    const parsed = SplConfigSchema.parse({
      glbExportEnabled: true,
      roomIdleFlagMonths: 6,
      maxRoomsPerMember: 40,
    })
    expect(parsed).not.toHaveProperty('glbExportEnabled')
    expect(parsed).not.toHaveProperty('roomIdleFlagMonths')
    expect(parsed.maxRoomsPerMember).toBe(40)
  })
})
