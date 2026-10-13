import type { components } from '@marketly/web-shared/api';
import type { IconName } from '@marketly/web-shared/ui';

// Notification templates (design: pages/admin/admin-notifications.html and admin-notifications--edit-template.html),
// from the notifications API: the topic × channel matrix with delivery stats, and per-channel templates with versions.

type S = components['schemas'];
export type TopicMatrix = S['notifications.TopicMatrix'];
export type Topic = S['notifications.Topic'];
export type ChannelSetting = S['notifications.ChannelSetting'];
export type Template = S['notifications.Template'];
export type TemplateDetail = S['notifications.TemplateDetail'];
export type TemplateVersion = S['notifications.TemplateVersion'];
export type TemplateContent = S['notifications.TemplateContent'];
export type Channel = ChannelSetting['channel'];

export interface NoticeGroup {
  audience: 'customer' | 'seller' | 'staff';
  title: string;
  icon: IconName;
  sub: string;
}

export const GROUPS: NoticeGroup[] = [
  { audience: 'customer', title: 'Customer notices', icon: 'user-round', sub: 'Order accepted through case replies' },
  { audience: 'seller', title: 'Seller notices', icon: 'store', sub: 'Application through payout results' },
  { audience: 'staff', title: 'Staff notices', icon: 'user-cog', sub: 'Sent to the queue lead and backup' },
];

export const AUDIENCE_LABEL: Record<string, string> = { customer: 'Customer', seller: 'Seller', staff: 'Staff', external: 'External' };
export const CHANNEL_LABEL: Record<Channel, string> = { in_app: 'In-app', email: 'Email', sms: 'SMS', push: 'Push' };

/** Variables shown in a mono span in the preview (references and tracking numbers). */
export const MONO_VARS = ['order.ref', 'link.ref', 'tracking.number', 'return.ref', 'case.ref'];

/** The design's editor: one form for the email and in-app versions of a topic. */
export interface EditorContent {
  subject: string;
  preheader: string;
  body: string;
  /** "Track package → {{link.url}}" */
  button: string;
  inappTitle: string;
  inappBody: string;
  /** The screen the in-app notice opens: its button URL. */
  inappLink: string;
}

const buttonText = (b?: { label: string; url: string } | null) => (b ? `${b.label} → ${b.url}` : '');
export function parseButton(s: string): { label: string; url: string } | null {
  const t = s.trim();
  if (!t) return null;
  const [label, ...rest] = t.split('→');
  return { label: label.trim(), url: rest.join('→').trim() };
}

export function editorContent(email?: TemplateContent | null, inapp?: TemplateContent | null): EditorContent {
  return {
    subject: email?.subject ?? '',
    preheader: email?.preheader ?? '',
    body: email?.body ?? '',
    button: buttonText(email?.button),
    inappTitle: inapp?.title ?? '',
    inappBody: inapp?.body ?? '',
    inappLink: inapp?.button?.url ?? '',
  };
}

export function emailContent(c: EditorContent, base: TemplateContent): TemplateContent {
  return { ...base, subject: c.subject, preheader: c.preheader || null, body: c.body, button: parseButton(c.button) };
}
export function inappContent(c: EditorContent, base: TemplateContent): TemplateContent {
  const label = base.button?.label ?? 'Open';
  return { ...base, title: c.inappTitle, body: c.inappBody, button: c.inappLink.trim() ? { label, url: c.inappLink.trim() } : null };
}

export const EMAIL_FIELDS: Array<keyof EditorContent> = ['subject', 'preheader', 'body', 'button'];
export const INAPP_FIELDS: Array<keyof EditorContent> = ['inappTitle', 'inappBody', 'inappLink'];
export const changed = (a: EditorContent, b: EditorContent, keys: Array<keyof EditorContent>) => keys.some((k) => a[k] !== b[k]);

/** Sample values for the preview from the topic's variable examples ({ "order.ref": "MK-…" }). */
export const sampleOf = (t?: Topic | null): Record<string, string> => Object.fromEntries((t?.variables ?? []).map((v) => [v.name, v.example ?? `{{${v.name}}}`]));
