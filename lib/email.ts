import { prisma } from '@/lib/db/prisma'
import { sendTemplateEmail } from '@/lib/email/index'
import { getSiteUrl } from '@/lib/config/env'
import type { Bom } from '@/modules/space-planner-for-shop/lib/bom'

// Sending. Core owns the copy, the wrapper and the on/off switch; this file only
// works out the merge variables and honours the member's own preference.
//
// It does the preference check itself rather than going through core's
// sendMemberEmail, because that helper's key parameter is a closed union of
// core's own template keys - a module key does not type-check against it. The
// check is the same one, done in the same place in the sequence.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The item table that goes in the body. Escaped here, declared as a raw tag there. */
export function renderBomTable(bom: Bom): string {
  if (bom.lines.length === 0) return ''
  const rows = bom.lines
    .map(
      (line) =>
        `<tr><td style="padding:6px 12px 6px 0">${escapeHtml(line.name)}${line.approximate ? ' <span style="color:#888">(approx. size)</span>' : ''}</td>` +
        `<td style="padding:6px 12px 6px 0;text-align:right">${line.quantity}</td>` +
        `<td style="padding:6px 0;text-align:right">${escapeHtml(line.lineTotalFormatted)}</td></tr>`,
    )
    .join('')
  return (
    `<table style="border-collapse:collapse;width:100%;margin:16px 0">` +
    `<thead><tr><th align="left" style="padding:6px 12px 6px 0">Item</th><th align="right" style="padding:6px 12px 6px 0">Qty</th><th align="right" style="padding:6px 0">Total</th></tr></thead>` +
    `<tbody>${rows}</tbody>` +
    `<tfoot><tr><td colspan="2" style="padding:8px 12px 0 0;text-align:right"><strong>Total</strong></td><td style="padding:8px 0 0;text-align:right"><strong>${escapeHtml(bom.totalFormatted)}</strong></td></tr></tfoot>` +
    `</table>`
  )
}

async function memberWantsCategory(memberId: string, category: string): Promise<boolean> {
  const pref = await prisma.memberNotificationPreference.findUnique({
    where: { memberId_channel_category: { memberId, channel: 'EMAIL', category } },
  })
  return pref ? pref.enabled : true
}

export async function sendPlanEmail(input: {
  to: string
  siteName: string
  roomName: string
  planName: string
  planPath: string
  bom: Bom
}): Promise<boolean> {
  return sendTemplateEmail(input.to, 'space-planner.plan-emailed', {
    siteName: input.siteName,
    roomName: input.roomName,
    planName: input.planName,
    itemCount: String(input.bom.itemCount),
    total: input.bom.totalFormatted,
    planUrl: `${getSiteUrl()}${input.planPath}`,
    items: renderBomTable(input.bom),
    disclaimer: input.bom.disclaimer,
  })
}

export async function sendRenderDoneEmail(input: {
  to: string
  memberId: string
  siteName: string
  planName: string
  planPath: string
  stale: boolean
  renderedFor: string
}): Promise<boolean> {
  if (!(await memberWantsCategory(input.memberId, 'space-planner.render'))) return false
  return sendTemplateEmail(input.to, 'space-planner.render-done', {
    siteName: input.siteName,
    planName: input.planName,
    planUrl: `${getSiteUrl()}${input.planPath}`,
    // Literally 'true' or the template's {{#if stale}} block never survives -
    // core's conditional compares against that exact string, so 'yes' meant the
    // "this is how the room was on the fourth" line has never once been sent.
    stale: input.stale ? 'true' : '',
    renderedFor: input.renderedFor,
  })
}
