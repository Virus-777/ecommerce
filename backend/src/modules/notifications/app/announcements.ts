/**
 * Announcements (live topics, 2026-10-20): messages from Marketly staff to sellers, sent from Admin › Notifications.
 * Each one is kept in the announcements collection (the Admin Center lists them, newest first) and sent as the
 * essential topic seller.announcement to the chosen sellers, or to every active seller (approved or restricted).
 *
 * The sends run inside the request, 50 seller workspaces per batch (each batch one transaction of notices and
 * deliveries, like broadcasts). That is fine for a marketplace of a few hundred sellers; emails are dispatched as
 * each batch commits, and the notifications.dispatch job picks up any that wait.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { Page } from '../../../spec/common.js';
import type { Announcement, AnnouncementInput, AnnouncementLink, NoticeLink } from '../../../spec/notifications.js';
import type { AnnouncementRow } from '../ports.js';
import type { By } from './admin.js';
import { actorOfText, actorText, type Core } from './core.js';
import type { Sender } from './sender.js';

export const ANNOUNCEMENT_TOPIC = 'seller.announcement';
/** Seller workspaces per send (one transaction each) */
const BATCH = 50;
const LIMITS = { title: 120, body: 2000, sellers: 500, linkId: 200, linkLabel: 40 } as const;

type Issue = { path: string; message: string };

export function announcementOf(r: AnnouncementRow): Announcement {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    audience: r.audience,
    sellerCount: r.seller_count,
    link: (r.link as AnnouncementLink | null) ?? null,
    sentBy: actorOfText(r.sent_by),
    sentAt: r.sent_at.toISOString(),
  };
}

export class Announcements {
  constructor(
    private readonly core: Core,
    private readonly sender: Sender,
  ) {}

  async list(page: PageRequest): Promise<Page<Announcement>> {
    const res = await this.core.repo.listAnnouncements(page);
    return { ...res, items: res.items.map(announcementOf) };
  }

  async send(input: AnnouncementInput, by: By): Promise<{ announcement: Announcement }> {
    const issues: Issue[] = [];
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title) issues.push({ path: 'title', message: 'Add a title' });
    else if (title.length > LIMITS.title) issues.push({ path: 'title', message: `At most ${LIMITS.title} characters` });
    if (!body) issues.push({ path: 'body', message: 'Add the message' });
    else if (body.length > LIMITS.body) issues.push({ path: 'body', message: `At most ${LIMITS.body} characters` });
    const link = this.#link(input.link ?? null, issues);
    const chosen = input.sellerIds ? [...new Set(input.sellerIds)] : null;
    if (chosen && (chosen.length < 1 || chosen.length > LIMITS.sellers)) issues.push({ path: 'sellerIds', message: `Choose 1 to ${LIMITS.sellers} sellers, or leave it out to send to every active seller` });
    if (issues.length) throw new AppError('VALIDATION_FAILED', issues[0]!.message, { issues });

    // the chosen sellers must exist (the Official Store is no seller workspace); "all" is read now, when it is sent
    const sellerIds = chosen ? await this.#known(chosen) : await this.core.activeSellerIds();

    const id = newId();
    const row = await this.core.repo.insertAnnouncement({
      id,
      title,
      body,
      audience: chosen ? 'chosen' : 'all',
      seller_ids: chosen ? sellerIds : [],
      seller_count: sellerIds.length,
      link: (link ?? null) as never,
      sent_by: actorText(by.actor),
      sent_at: this.core.now(),
    });

    const noticeLink: NoticeLink = link
      ? { kind: 'announcement', id: link.id, screen: link.screen, label: link.label ?? 'Read more' }
      : { kind: 'announcement', id, screen: 'seller/notifications', label: 'Read more' };
    for (let i = 0; i < sellerIds.length; i += BATCH) {
      await this.sender.send({
        topic: ANNOUNCEMENT_TOPIC,
        targets: sellerIds.slice(i, i + BATCH).map((sellerId) => ({ kind: 'seller' as const, sellerId })),
        link: noticeLink,
        context: { announcement: { title, body } },
        dedupeKey: `announcement:${id}`,
      });
    }

    await this.core.audit(
      {
        action: 'notifications.announcement.send',
        actionLabel: chosen ? `Sent an announcement to ${sellerIds.length} seller${sellerIds.length === 1 ? '' : 's'}` : 'Sent an announcement to every active seller',
        category: 'other',
        target: { type: 'notification_announcement', id, label: title, screen: 'admin/notifications' },
        after: { title, audience: row.audience, sellerCount: row.seller_count, ...(chosen ? { sellerIds } : {}), link },
      },
      by,
    );
    return { announcement: announcementOf(row) };
  }

  /** A link into Seller Center (screen + id, like every NoticeLink) */
  #link(l: AnnouncementLink | null, issues: Issue[]): AnnouncementLink | null {
    if (!l) return null;
    const screen = l.screen.trim();
    const id = l.id.trim();
    const label = l.label?.trim() || null;
    if (!/^seller\/[a-z0-9][a-z0-9/-]*$/.test(screen)) issues.push({ path: 'link.screen', message: 'Use a Seller Center screen id, e.g. seller/help' });
    if (!id || id.length > LIMITS.linkId) issues.push({ path: 'link.id', message: `1 to ${LIMITS.linkId} characters` });
    if (label && label.length > LIMITS.linkLabel) issues.push({ path: 'link.label', message: `At most ${LIMITS.linkLabel} characters` });
    return { screen, id, ...(label ? { label } : {}) };
  }

  /** The chosen ids, refused when one is not a known seller (sellers off: taken as given) */
  async #known(ids: string[]): Promise<string[]> {
    const api = this.core.sellers;
    if (!api) return ids;
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += 100) for (const s of await api.getSellers(ids.slice(i, i + 100))) found.add(s.id);
    const unknown = ids.filter((id) => !found.has(id));
    if (unknown.length) {
      throw new AppError('VALIDATION_FAILED', unknown.length === 1 ? 'One of the chosen sellers was not found' : `${unknown.length} of the chosen sellers were not found`, {
        issues: unknown.slice(0, 20).map((id) => ({ path: `sellerIds[${ids.indexOf(id)}]`, message: `No seller ${id}` })),
      });
    }
    return ids;
  }
}
