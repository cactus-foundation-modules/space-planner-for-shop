import type { EmailTemplateDef } from '@/lib/email/registry'

// This module's two emails, declared for core's single email editor
// (Settings > Emails). Core owns the wording, the on/off switch, the wrapper
// design and the sending; this file is only the defaults.
//
// Two, not five. A planner that emails somebody every time they move a desk is a
// planner they unsubscribe from.
//
// `items` is a small HTML table the module builds, with its own escaping already
// applied to every product name in it - hence rawTags. Everything else that
// could carry typed text is escaped by core on the way in, as normal.
//
// Both templates print the plan's address as visible text as well as linking it.
// Core builds the plain-text alternative by stripping the tags out of the
// template and only then filling in the values, so a url that lives in an href
// is stripped along with the tag it sits in - a plain-text reader was getting
// "Open your plan" with nothing to open. The visible copy survives the strip,
// which is the only version of this a template can fix from its own side.

export const spacePlannerEmailTemplates: EmailTemplateDef[] = [
  {
    key: 'space-planner.plan-emailed',
    label: 'Your layout (to the shopper)',
    subject: 'Your layout from {{siteName}} - {{planName}}',
    bodyHtml:
      '<p>Here is the layout you put together at {{siteName}}.</p>' +
      '<p><strong>{{roomName}} - {{planName}}</strong><br>{{itemCount}} items, {{total}}</p>' +
      '<p><a href="{{planUrl}}">Open your layout</a></p>' +
      '<p style="color:#666;font-size:13px">Or paste this into your browser: {{planUrl}}</p>' +
      '{{items}}' +
      '<p style="color:#666;font-size:13px">{{disclaimer}}</p>',
    mergeTags: ['siteName', 'roomName', 'planName', 'itemCount', 'total', 'planUrl', 'items', 'disclaimer'],
    requiredTags: ['planUrl'],
    rawTags: ['items'],
    // The shopper pressed the button and is owed the result, so this one is not
    // something a preference switch may quietly swallow.
    transactional: true,
  },
  {
    key: 'space-planner.render-done',
    label: 'Your space picture is ready (to the shopper)',
    subject: 'Your picture of {{planName}} is ready',
    bodyHtml:
      '<p>The picture of your layout has finished.</p>' +
      '<p><a href="{{planUrl}}">Have a look</a></p>' +
      '<p style="color:#666;font-size:13px">Or paste this into your browser: {{planUrl}}</p>' +
      '{{#if stale}}<p>You have moved things around since you asked for it, so it shows the space as it was on {{renderedFor}}.</p>{{/if}}',
    // `stale` is a flag rather than wording, but it still has to be declared or
    // the editor does not offer it and the preview cannot exercise the branch.
    mergeTags: ['siteName', 'planName', 'planUrl', 'renderedFor', 'stale'],
    requiredTags: ['planUrl'],
    rawTags: [],
    // Unprompted, arriving minutes later. It gets a notification category so a
    // member can switch it off - and that single declaration is what lights up
    // the member Notifications tab, which core hides entirely until some module
    // contributes one.
    transactional: false,
  },
]
