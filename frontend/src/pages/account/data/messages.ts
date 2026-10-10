// Shopper message threads (order conversations with sellers and Marketly Support).
import type { IconName, Tone } from '@/ui';

export type Entry =
  | { kind: 'sys'; text: string }
  | { kind: 'msg'; me?: boolean; text: string; by: string; at: string; file?: string };

export interface Thread {
  id: string;
  name: string;
  /** Logo tile: initials + tint, or an icon for Marketly Support. */
  initials?: string;
  icon?: IconName;
  tint: string;
  verified?: boolean;
  official?: boolean;
  meta: string;
  time: string;
  subject: string;
  preview: string;
  unread: boolean;
  about: { label: string; ref: string; extra?: string; product: string; icon: IconName; tint: string; status: string; tone: Tone };
  entries: Entry[];
}

export const THREADS: Thread[] = [
  {
    id: 'casaverde', name: 'Casa Verde Home', initials: 'CV', tint: '1', verified: true, meta: 'Usually replies within 4 hours · Sacramento, CA',
    time: '9:20 AM', subject: 'MK-260914-48213 · Linen duvet cover', preview: "The Sage color restock arrives tomorrow. We'll ship Saturday.", unread: true,
    about: { label: 'About order', ref: 'MK-260914-48213', extra: 'Package 3 of 3', product: 'Mosswood Washed Linen Duvet Cover, Queen', icon: 'bed-double', tint: '1', status: 'Delayed', tone: 'warning' },
    entries: [
      { kind: 'sys', text: 'Mon, Oct 5' },
      { kind: 'msg', me: true, text: "Hi, my duvet cover was due Sep 22 and still hasn't shipped. Can you tell me when it will?", by: 'You', at: '10:14 AM' },
      { kind: 'msg', text: 'Hi Jordan, sorry for the wait. Our supplier was late with the Sage color. We expect it this week.', by: 'Marisol, Casa Verde Home', at: '1:02 PM' },
      { kind: 'sys', text: 'Marketly Support joined from case CS-261005-3381 · Oct 7' },
      { kind: 'sys', text: 'Today' },
      { kind: 'msg', text: "The Sage color restock arrives tomorrow. We'll ship Saturday, Oct 10 with UPS and you'll get tracking right away.", by: 'Marisol, Casa Verde Home', at: '9:20 AM', file: 'restock-confirmation.pdf' },
    ],
  },
  {
    id: 'support', name: 'Marketly Support', icon: 'life-buoy', tint: 'brand', official: true, meta: 'Replies within 1 business day · Case CS-261005-3381',
    time: 'Yesterday', subject: 'Case CS-261005-3381 · Duvet delayed', preview: 'We asked Casa Verde to ship by Oct 10 and will check back Friday.', unread: true,
    about: { label: 'About case', ref: 'CS-261005-3381', extra: 'Order MK-260914-48213', product: 'Mosswood Washed Linen Duvet Cover, Queen', icon: 'bed-double', tint: '1', status: 'Waiting on seller', tone: 'warning' },
    entries: [
      { kind: 'sys', text: 'Mon, Oct 5' },
      { kind: 'msg', me: true, text: "My duvet cover is two weeks late and the seller hasn't given me a date.", by: 'You', at: '4:40 PM' },
      { kind: 'sys', text: 'Yesterday' },
      { kind: 'msg', text: 'We asked Casa Verde to ship by Oct 10 and will check back Friday. If it hasn’t shipped by then, we’ll cancel it for a full refund or arrange a replacement.', by: 'Isabel C., Marketly Support', at: '11:05 AM' },
    ],
  },
  {
    id: 'pixelport', name: 'Pixel & Port', initials: 'PP', tint: '6', verified: true, meta: 'Usually replies within 2 hours · Austin, TX',
    time: 'Oct 6', subject: 'MK-260914-48213 · Portable SSD', preview: 'Shipped today with USPS Priority. Tracking is on your order page.', unread: false,
    about: { label: 'About order', ref: 'MK-260914-48213', extra: 'Package 2 of 3', product: 'Kestrel 1 TB Portable SSD, USB 3.2', icon: 'hard-drive', tint: '6', status: 'In transit', tone: 'info' },
    entries: [
      { kind: 'sys', text: 'Tue, Oct 6' },
      { kind: 'msg', text: 'Shipped today with USPS Priority. Tracking is on your order page.', by: 'Dev, Pixel & Port', at: '11:30 AM' },
    ],
  },
  {
    id: 'northwind', name: 'Northwind Audio', initials: 'NA', tint: '2', verified: true, meta: 'Usually replies within 6 hours · Portland, OR',
    time: 'Oct 7', subject: 'RT-261007-0533 · Pocket speaker', preview: "Thanks, we're checking the photos and will reply by Friday.", unread: false,
    about: { label: 'About return', ref: 'RT-261007-0533', product: 'Halden Pocket Bluetooth Speaker', icon: 'speaker', tint: '2', status: 'Requested', tone: 'info' },
    entries: [
      { kind: 'sys', text: 'Wed, Oct 7' },
      { kind: 'msg', me: true, text: 'The speaker crackles at any volume above half. Photos and a short video are attached to the return.', by: 'You', at: '8:52 AM' },
      { kind: 'msg', text: "Thanks, we're checking the photos and will reply by Friday.", by: 'Sam, Northwind Audio', at: '2:15 PM' },
    ],
  },
  {
    id: 'official', name: 'Marketly Official', initials: 'M', tint: 'brand', official: true, meta: 'Official Store · Replies within 1 business day',
    time: 'Sep 22', subject: 'RT-260921-0457 · Pour-over set', preview: 'Sorry about the chipped cup. Your return is approved.', unread: false,
    about: { label: 'About return', ref: 'RT-260921-0457', product: 'Mosswood Ceramic Pour-over Coffee Set', icon: 'coffee', tint: '3', status: 'Approved', tone: 'success' },
    entries: [
      { kind: 'sys', text: 'Mon, Sep 21' },
      { kind: 'msg', me: true, text: 'One of the cups arrived chipped. I opened a return with photos.', by: 'You', at: '6:05 PM' },
      { kind: 'sys', text: 'Tue, Sep 22' },
      { kind: 'msg', text: 'Sorry about the chipped cup. Your return is approved.', by: 'Marketly Official', at: '9:30 AM' },
    ],
  },
];
