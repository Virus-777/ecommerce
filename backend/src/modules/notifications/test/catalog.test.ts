/**
 * Topic catalogue and template rendering (pure: no app boot).
 */
import { describe, expect, it } from 'vitest';
import { TOPICS, defaultContent, sampleContext, topicDef } from '../domain/catalog.js';
import { PREHEADER_MAX, PUSH_BODY_MAX, render } from '../domain/templates.js';

describe('topic icons', () => {
  it('uses current Lucide names, never the old aliases the apps do not know', () => {
    // old name → current name (lucide-react 1.x)
    const renamed = ['alert-triangle', 'alert-octagon', 'x-circle', 'check-circle', 'help-circle', 'arrow-up-circle', 'minus-circle', 'pause-circle', 'play-circle', 'edit', 'file-question', 'trash-2'];
    for (const t of TOPICS) expect(renamed, t.key).not.toContain(t.icon);
    expect(topicDef('customer.shipment.exception')!.icon).toBe('triangle-alert');
    expect(topicDef('customer.order.item_cancelled')!.icon).toBe('circle-x');
  });
});

describe('previews are cut after rendering', () => {
  const dispatched = topicDef('customer.shipment.dispatched')!;
  const ctx = {
    package: { items: 'Aurora Desk Lamp (Black) × 1, Linen Throw Pillow (Sand) × 2, Walnut Cutting Board × 1' },
    order: { ref: 'MK-261009-48213' },
    delivery: { estimate: 'Oct 11–Oct 13' },
  };

  it('never leaves a half placeholder in the email preheader', () => {
    const m = render(dispatched, 'email', defaultContent(dispatched, 'email', {}), ctx);
    expect(m.preheader).not.toContain('{{');
    expect(m.preheader!.length).toBeLessThanOrEqual(PREHEADER_MAX);
    expect(m.preheader!.startsWith('Aurora Desk Lamp (Black) × 1')).toBe(true);
    expect(m.preheader!.endsWith('…')).toBe(true);
  });

  it('never leaves a half placeholder in a push body', () => {
    const m = render(dispatched, 'push', defaultContent(dispatched, 'push', {}), ctx);
    expect(m.text).not.toContain('{{');
    expect(m.text.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
    // a short rendered body is not cut
    const short = render(dispatched, 'push', defaultContent(dispatched, 'push', {}), { ...ctx, package: { items: 'Lamp × 1' } });
    expect(short.text).toBe('Lamp × 1 from order MK-261009-48213 has been dispatched. Estimated arrival: Oct 11–Oct 13.');
  });

  it('keeps every default preview free of half placeholders with the sample variables', () => {
    for (const t of TOPICS) {
      if (t.supports.includes('email')) expect(render(t, 'email', defaultContent(t, 'email', {}), sampleContext(t)).preheader, t.key).not.toMatch(/\{\{|\}\}/);
      if (t.supports.includes('push')) expect(render(t, 'push', defaultContent(t, 'push', {}), sampleContext(t)).text, t.key).not.toMatch(/\{\{|\}\}/);
    }
  });
});
