/**
 * Template rendering (Mustache-style {{variables}} with HTML escaping), validation and footers. Pure.
 */
import type { TemplateContent, TemplateValidation, ValidationIssue } from '../../../spec/notifications.js';
import { topicVariables, variablesIn, type Channel, type TopicDef } from './catalog.js';

const VAR = /\{\{\s*([\w.]+)\s*\}\}/g;

export function lookup(ctx: unknown, path: string): unknown {
  let node: unknown = ctx;
  for (const p of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[p];
  }
  return node;
}

const show = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(show).filter(Boolean).join(', ');
  if (typeof v === 'object') return '';
  return String(v);
};

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain-text render: missing variables become empty */
export const renderText = (template: string | null | undefined, ctx: unknown): string =>
  (template ?? '').replace(VAR, (_, name: string) => show(lookup(ctx, name))).replace(/[ \t]+([.,;:])/g, '$1').trim();

/** Longest email preheader and push body; longer rendered texts end with "…" */
export const PREHEADER_MAX = 90;
export const PUSH_BODY_MAX = 140;

/** Shortens a rendered text (variables already filled in, so a cut never splits a {{variable}}) */
export const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Same text with every variable removed, for sensitive subjects stored in the delivery log */
export const redact = (template: string | null | undefined): string => (template ?? '').replace(VAR, '…').trim();

/** Validation of a version's content against its topic and channel (blocking issues stop publishing) */
export function validateContent(topic: TopicDef, channel: Channel, content: TemplateContent): TemplateValidation {
  const issues: ValidationIssue[] = [];
  const known = new Set(topicVariables(topic).map((v) => v.name));
  const texts: [string, string | null | undefined][] = [
    ['subject', content.subject],
    ['preheader', content.preheader],
    ['title', content.title],
    ['body', content.body],
    ['button.label', content.button?.label],
    ['button.url', content.button?.url],
  ];
  for (const [field, text] of texts) {
    for (const name of variablesIn(text)) {
      if (!known.has(name)) issues.push({ severity: 'blocking', field, message: `Unknown variable {{${name}}}` });
    }
  }
  const used = new Set(variablesIn(...texts.map(([, t]) => t)));
  for (const v of topicVariables(topic)) {
    if (!v.required) continue;
    if (v.name === 'link.url' && channel !== 'email' && channel !== 'sms') continue;
    if (v.name === 'unsubscribe.url' && channel !== 'email') continue;
    if (!used.has(v.name)) issues.push({ severity: 'blocking', field: v.name === 'link.url' ? 'button.url' : 'body', message: `Missing required variable {{${v.name}}}${v.name === 'link.url' ? ': every notice must link to its record' : ''}` });
  }
  if (!content.body?.trim()) issues.push({ severity: 'blocking', field: 'body', message: 'The body is empty' });
  if (channel === 'email' && !content.subject?.trim()) issues.push({ severity: 'blocking', field: 'subject', message: 'Emails need a subject' });
  if ((channel === 'in_app' || channel === 'push') && !content.title?.trim()) issues.push({ severity: 'blocking', field: 'title', message: 'In-app and push notices need a title' });
  if (topic.category !== 'promotional' && content.allowPromotionalContent) {
    issues.push({ severity: 'blocking', field: 'allowPromotionalContent', message: `${topic.category === 'essential' ? 'Essential' : 'Optional'} notices cannot carry promotional content` });
  }
  if (topic.category !== 'promotional') {
    const promo = /\b(coupon|promo code|discount code|\d+\s?% off|limited[- ]time offer|flash sale)\b/i;
    for (const [field, text] of texts) if (text && promo.test(text)) issues.push({ severity: topic.category === 'essential' ? 'blocking' : 'warning', field, message: 'Looks like promotional content; essential notices only say what happened and what to do next' });
  }
  if (content.subject && renderText(content.subject, {}).length > 60) issues.push({ severity: 'warning', field: 'subject', message: 'Keep the subject under 60 characters' });
  if (channel === 'sms' && content.body.length > 160) issues.push({ severity: 'warning', field: 'body', message: 'SMS longer than 160 characters is sent in several parts' });
  if (channel === 'push' && content.body.length > PUSH_BODY_MAX) issues.push({ severity: 'warning', field: 'body', message: `Push bodies are cut after ${PUSH_BODY_MAX} characters` });
  return { ok: !issues.some((i) => i.severity === 'blocking'), issues };
}

export function footerFor(topic: TopicDef): string {
  if (topic.category === 'promotional') return "You're receiving this because you opted in to Marketly promotions. Unsubscribe with one click: {{unsubscribe.url}}";
  if (topic.category === 'optional') return 'You can turn these emails off in your notification settings.';
  if (topic.audience === 'external') return 'Marketly sent you this email about your purchase order or report. Reply to the contact named in it if you have questions.';
  if (topic.audience === 'staff') return 'Staff notice from Marketly Admin Center. Change your email preferences in Admin Center.';
  if (topic.audience === 'seller') return "You can't turn off essential Seller Center notices for the account owner.";
  return "You can't unsubscribe from order updates because they're about your account and orders.";
}

export interface RenderedMessage {
  subject: string | null;
  preheader: string | null;
  title: string | null;
  text: string;
  html: string | null;
  footer: string;
  buttonLabel: string | null;
  buttonUrl: string | null;
  sender: string | null;
}

/** Renders one version for a channel and device (email gets an HTML layout and a plain-text alternative) */
export function render(topic: TopicDef, channel: Channel, content: TemplateContent, ctx: unknown, device: 'desktop' | 'phone' = 'desktop'): RenderedMessage {
  const footer = renderText(footerFor(topic), ctx);
  const subject = content.subject ? renderText(content.subject, ctx) : null;
  const title = content.title ? renderText(content.title, ctx) : null;
  // cut after rendering: cutting the template could split a {{variable}} ("Estimated arrival: {{de…")
  const body = channel === 'push' ? shorten(renderText(content.body, ctx), PUSH_BODY_MAX) : renderText(content.body, ctx);
  const buttonLabel = content.button ? renderText(content.button.label, ctx) : null;
  const buttonUrl = content.button ? renderText(content.button.url, ctx) : null;
  const preheader = content.preheader ? shorten(renderText(content.preheader, ctx), PREHEADER_MAX) : null;
  const text = [title && channel === 'email' ? title : null, body, buttonUrl ? `${buttonLabel ?? 'Open'}: ${buttonUrl}` : null, channel === 'email' ? footer : null].filter(Boolean).join('\n\n');
  const html = channel === 'email' ? emailHtml({ title, body, preheader, buttonLabel, buttonUrl, footer, device }) : null;
  return { subject, preheader, title, text, html, footer, buttonLabel, buttonUrl, sender: content.sender ?? null };
}

function emailHtml(m: { title: string | null; body: string; preheader: string | null; buttonLabel: string | null; buttonUrl: string | null; footer: string; device: 'desktop' | 'phone' }) {
  const width = m.device === 'phone' ? 360 : 600;
  const paragraphs = m.body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const button = m.buttonUrl
    ? `<p style="margin:24px 0"><a href="${escapeHtml(m.buttonUrl)}" style="background:#1f6feb;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(m.buttonLabel ?? 'Open')}</a></p>`
    : '';
  return [
    '<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,sans-serif;color:#1c1e21">',
    m.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(m.preheader)}</div>` : '',
    `<table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="${width}" style="background:#fff;margin:24px 0;padding:24px;border-radius:8px"><tr><td>`,
    '<p style="font-weight:bold;font-size:18px;margin:0 0 24px">Marketly</p>',
    m.title ? `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(m.title)}</h1>` : '',
    paragraphs,
    button,
    `<p style="margin:32px 0 0;font-size:12px;color:#6b7280">${escapeHtml(m.footer)}</p>`,
    '</td></tr></table></td></tr></table></body></html>',
  ].join('');
}
