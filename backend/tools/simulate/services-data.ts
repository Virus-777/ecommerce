/**
 * Sample providers and services for the app's request and booking pages (services module): the Phones department's
 * OS install and Post-sale services tabs, Welfare services and Booking. Written through the Admin Center API, and only
 * what is missing (a category, provider or service with the same slug is kept as it is), so it is safe to run again.
 * Used by the simulator (flows/departments.ts) and tools/seed-departments.ts. The texts and prices are samples.
 */
import type { AdminCall } from './departments-data.js';

const usd = (dollars: number) => ({ amount: Math.round(dollars * 100), currency: 'USD' });
const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

type Area = 'os_install' | 'post_sale' | 'welfare' | 'booking';
const week = (from: string, to: string, sat?: [string, string], sun?: [string, string]) => ({
  timeZone: 'America/Los_Angeles',
  days: [
    ...['mon', 'tue', 'wed', 'thu', 'fri'].map((weekday) => ({ weekday, open: true, from, to })),
    sat ? { weekday: 'sat', open: true, from: sat[0], to: sat[1] } : { weekday: 'sat', open: false },
    sun ? { weekday: 'sun', open: true, from: sun[0], to: sun[1] } : { weekday: 'sun', open: false },
  ],
});

export const SERVICE_CATEGORIES: Record<Area, { name: string; icon: string }[]> = {
  os_install: [
    { name: 'Android', icon: 'smartphone' },
    { name: 'iOS', icon: 'smartphone' },
    { name: 'Custom ROM', icon: 'cpu' },
    { name: 'Data backup', icon: 'hard-drive' },
  ],
  post_sale: [
    { name: 'Screen repair', icon: 'smartphone' },
    { name: 'Battery', icon: 'battery-charging' },
    { name: 'Warranty', icon: 'shield-check' },
    { name: 'Data recovery', icon: 'hard-drive' },
    { name: 'Trade-in', icon: 'refresh-cw' },
  ],
  welfare: [
    { name: 'Elder care', icon: 'hand-heart' },
    { name: 'Child care', icon: 'baby' },
    { name: 'Disability support', icon: 'accessibility' },
    { name: 'Health checks', icon: 'stethoscope' },
    { name: 'Home help', icon: 'house' },
    { name: 'Counseling', icon: 'message-circle' },
  ],
  booking: [
    { name: 'Beauty', icon: 'scissors' },
    { name: 'Health', icon: 'stethoscope' },
    { name: 'Car service', icon: 'car' },
    { name: 'Stays', icon: 'bed-double' },
    { name: 'Venues', icon: 'calendar-days' },
  ],
};

export const PROVIDERS = [
  { name: 'Marketly Tech Care', kind: 'Phone setup and repair', city: 'Portland, OR', verified: true, since: 2019, replyTime: 'Replies within 2 hours', description: 'The Marketly phone service desk: clean installs, restores, backups and updates by certified technicians.', contacts: { phone: '503-555-0170', email: 'techcare@marketly.example', address: '412 SE Morrison St, Portland, OR 97214' }, location: { lat: 45.5172, lng: -122.6603 }, hours: week('10:00', '19:00', ['10:00', '17:00']), staff: [] },
  { name: 'FixPoint Mobile', kind: 'Certified repair partner', city: 'Portland, OR', verified: true, since: 2012, replyTime: 'Replies within 1 hour', description: 'Screen, battery and charging-port repairs with genuine parts, most done the same day.', contacts: { phone: '503-555-0188', email: 'hello@fixpoint.example', address: '1520 NE Broadway, Portland, OR 97232' }, location: { lat: 45.5351, lng: -122.6497 }, hours: week('09:00', '20:00', ['10:00', '18:00']), staff: [] },
  { name: 'Brightside Care Co.', kind: 'Licensed home care agency', city: 'Millbrook', verified: true, since: 2014, replyTime: 'Replies within 1 hour', description: 'Trained caregivers for older adults, children and people with disabilities, at home and on your schedule.', contacts: { phone: '503-555-0142', email: 'care@brightside.example', address: '18 Elm Street, Millbrook' }, location: { lat: 45.4871, lng: -122.8037 }, hours: week('08:00', '18:00'), staff: [] },
  { name: 'Studio Nine Hair', kind: 'Hair salon', city: 'Portland, OR', verified: true, since: 2016, replyTime: 'Replies within 30 minutes', description: 'Cuts, color and beard trims in a calm studio on Marine Avenue.', contacts: { phone: '503-555-0119', email: 'book@studionine.example', address: '42 Marine Ave, Unit 3, Portland, OR 97217' }, location: { lat: 45.5876, lng: -122.6913 }, hours: week('09:00', '19:00', ['09:00', '17:00']), staff: [{ id: 'maya', name: 'Maya', role: 'Stylist' }, { id: 'jonas', name: 'Jonas', role: 'Barber' }, { id: 'priya', name: 'Priya', role: 'Colorist' }] },
  { name: 'Brightsmile Dental', kind: 'Dental clinic', city: 'Portland, OR', verified: true, since: 2009, replyTime: 'Replies within 2 hours', description: 'Check-ups, cleaning and whitening, with evening appointments on weekdays.', contacts: { phone: '503-555-0133', email: 'front.desk@brightsmile.example', address: '780 NW 23rd Ave, Portland, OR 97210' }, location: { lat: 45.5289, lng: -122.6984 }, hours: week('08:00', '18:00'), staff: [{ id: 'ortiz', name: 'Dr. Lena Ortiz', role: 'Dentist' }, { id: 'kim', name: 'Dr. Sam Kim', role: 'Dentist' }] },
  { name: 'Rose City Auto Care', kind: 'Car service', city: 'Portland, OR', verified: false, since: 2001, replyTime: 'Replies the same day', description: 'Oil changes, tire swaps and inspections while you wait.', contacts: { phone: '503-555-0155', email: 'service@rosecityauto.example', address: '2201 SE Powell Blvd, Portland, OR 97202' }, location: { lat: 45.4974, lng: -122.6418 }, hours: week('07:30', '17:30', ['08:00', '14:00']), staff: [] },
];

type ServiceSeed = { area: Area; provider: string; title: string; category: string; [k: string]: unknown };
export const SERVICES: ServiceSeed[] = [
  // OS install
  {
    area: 'os_install', provider: 'Marketly Tech Care', category: 'Android', title: 'Android clean reinstall', badge: 'Popular', summary: 'A fresh Android with your photos, contacts and apps back.', fromPrice: usd(29), durationLabel: 'About 1–2 hours', supportedLabel: 'Samsung, Pixel, Xiaomi, Oppo', tags: ['Data kept safe'],
    included: ['Full backup of photos, contacts and messages', 'Factory firmware flashed with the latest security patch', 'Data restored and your apps reinstalled', '30-day redo if anything goes wrong'],
    supported: ['Samsung Galaxy S20+', 'Galaxy A series', 'Pixel 6 and newer', 'Xiaomi 13+', 'Oppo Find X', 'Motorola Edge'],
    osVersions: ['Android 17', 'Android 16', 'Keep current'],
    handover: [{ mode: 'dropoff', note: 'Ready in about 2 hours' }, { mode: 'pickup', fee: usd(8), note: 'A courier collects and returns it' }],
  },
  { area: 'os_install', provider: 'Marketly Tech Care', category: 'iOS', title: 'iPhone restore and update', summary: 'Restore from backup or set up fresh on the latest iOS.', fromPrice: usd(25), durationLabel: 'About 1 hour', supportedLabel: 'iPhone 11 and newer', included: ['Backup to your iCloud or our encrypted drive', 'Latest iOS installed', 'Apps, photos and settings restored'], supported: ['iPhone 11 to 17'], osVersions: ['iOS 20', 'iOS 19', 'Keep current'], handover: [{ mode: 'dropoff', note: 'Ready in about 1 hour' }, { mode: 'pickup', fee: usd(8) }] },
  { area: 'os_install', provider: 'Marketly Tech Care', category: 'Custom ROM', title: 'Custom ROM install', summary: 'LineageOS or GrapheneOS installed and set up for you.', fromPrice: usd(49), durationLabel: 'About 3 hours', supportedLabel: 'Pixel and selected Samsung', included: ['Bootloader unlock where supported', 'ROM flashed and verified', 'Google apps optional'], supported: ['Pixel 6 to 10', 'Galaxy S21–S23 (Exynos excluded)'], osVersions: ['LineageOS 23', 'GrapheneOS'], handover: [{ mode: 'dropoff' }], terms: ['Unlocking can void the maker warranty'] },
  { area: 'os_install', provider: 'Marketly Tech Care', category: 'Data backup', title: 'OS update and data backup', summary: 'Your phone backed up, updated and checked.', fromPrice: usd(15), durationLabel: 'About 45 minutes', supportedLabel: 'Android and iPhone', included: ['Encrypted backup kept 30 days', 'System update installed', 'Battery and storage check'], handover: [{ mode: 'dropoff' }, { mode: 'online', note: 'Remote help for updates only' }] },
  // post-sale
  {
    area: 'post_sale', provider: 'FixPoint Mobile', category: 'Screen repair', title: 'Screen replacement', badge: 'Genuine parts', summary: 'A new screen with genuine parts, usually back the same day.', fromPrice: usd(89), durationLabel: 'Same day', coverage: 'Portland and 10 mi around', tags: ['Free pickup'],
    priceTableTitle: 'Price by model', priceTable: [{ label: 'Galaxy S26 Ultra', price: '$229' }, { label: 'Galaxy S25 / S25+', price: '$179' }, { label: 'Galaxy A56 / A57', price: '$89' }, { label: 'Pixel 10 / 10 Pro', price: '$159' }, { label: 'iPhone 17 / 17 Pro', price: '$199' }],
    terms: ['6 months on the new screen and the labor', 'Free once per year for phones with Marketly post-sale cover', 'Not covered: water damage, or a phone opened by another shop'],
    steps: [{ title: 'Request', detail: 'Pick a time' }, { title: 'Pickup', detail: 'Courier collects it' }, { title: 'Repair', detail: 'Status updates' }, { title: 'Return', detail: 'Back the same day' }],
    handover: [{ mode: 'pickup', note: 'Free pickup' }, { mode: 'dropoff' }],
  },
  { area: 'post_sale', provider: 'FixPoint Mobile', category: 'Battery', title: 'Battery replacement', summary: 'A new battery and a health check in under an hour.', fromPrice: usd(59), durationLabel: '45 minutes', tags: ['Free pickup'], priceTableTitle: 'Price by model', priceTable: [{ label: 'Galaxy S series', price: '$79' }, { label: 'Pixel', price: '$69' }, { label: 'iPhone', price: '$89' }], terms: ['12 months on the battery'], steps: [{ title: 'Request' }, { title: 'Replace' }, { title: 'Health check' }], handover: [{ mode: 'dropoff' }, { mode: 'pickup' }] },
  { area: 'post_sale', provider: 'Marketly Tech Care', category: 'Warranty', title: 'Warranty claim help', summary: 'We check your phone and file the maker warranty claim for you.', priceUnit: 'free', durationLabel: '3–7 days', terms: ['Covers faults the maker warranty covers', 'A loan phone while yours is away, if available'], steps: [{ title: 'Check' }, { title: 'Claim' }, { title: 'Return' }], handover: [{ mode: 'dropoff' }] },
  { area: 'post_sale', provider: 'FixPoint Mobile', category: 'Data recovery', title: 'Data recovery', summary: 'Photos and files back from phones that won’t start.', fromPrice: usd(99), durationLabel: '2–5 days', terms: ['No data, no charge'], handover: [{ mode: 'dropoff' }] },
  // welfare
  {
    area: 'welfare', provider: 'Brightside Care Co.', category: 'Elder care', title: 'In-home elder care', summary: 'Companionship, meals and help with daily routines at home.', priceUnit: 'hour', fromPrice: usd(24), coverage: 'Millbrook and 15 km around',
    description: 'Trained caregivers visit your parent at home for companionship, meals and help with daily routines, so they can stay independent and safe. Visits from 2 hours, any day of the week.',
    included: ['Companionship and conversation', 'Meal preparation', 'Help with bathing and dressing', 'Medication reminders', 'Light housekeeping'],
    requirements: ['Adults 65+ or with a care plan from a doctor', 'Within 15 km of Millbrook', 'A short home visit before the first booking', 'Medicare and long-term care insurance accepted'],
    priceTableTitle: 'Schedule and prices', priceTable: [{ label: 'Single visit', detail: '2–4 hrs, any day', price: '$28/hr' }, { label: 'Weekly', detail: '3+ visits a week', price: '$24/hr' }, { label: 'Overnight', detail: '9 pm – 7 am', price: '$190/night' }, { label: 'Assessment', detail: 'Before first visit', price: 'Free' }],
    handover: [{ mode: 'at_home' }],
  },
  { area: 'welfare', provider: 'Brightside Care Co.', category: 'Child care', title: 'After-school child care', summary: 'Pickup from school, homework help and play until you’re home.', priceUnit: 'hour', fromPrice: usd(22), coverage: 'Millbrook', included: ['School pickup', 'Homework help', 'A healthy snack'], requirements: ['Children 5–12', 'Background-checked caregivers'], handover: [{ mode: 'at_home' }] },
  { area: 'welfare', provider: 'Brightside Care Co.', category: 'Health checks', title: 'Home health check', summary: 'A nurse visits for blood pressure, sugar and medication review.', priceUnit: 'visit', fromPrice: usd(45), included: ['Blood pressure and glucose check', 'Medication review', 'A written summary for your doctor'], handover: [{ mode: 'at_home' }] },
  // booking
  { area: 'booking', provider: 'Studio Nine Hair', category: 'Beauty', title: 'Haircut', summary: 'Wash included', fromPrice: usd(25), durationLabel: '30 min', slotMinutes: 30 },
  { area: 'booking', provider: 'Studio Nine Hair', category: 'Beauty', title: 'Cut and beard trim', fromPrice: usd(38), durationLabel: '45 min', slotMinutes: 45 },
  { area: 'booking', provider: 'Studio Nine Hair', category: 'Beauty', title: 'Color and style', fromPrice: usd(85), durationLabel: '1 h 30 min', slotMinutes: 90 },
  { area: 'booking', provider: 'Brightsmile Dental', category: 'Health', title: 'Check-up and cleaning', summary: 'With a dentist', fromPrice: usd(90), durationLabel: '45 min', slotMinutes: 45 },
  { area: 'booking', provider: 'Rose City Auto Care', category: 'Car service', title: 'Oil change while you wait', summary: 'Synthetic oil', fromPrice: usd(49), durationLabel: '40 min', slotMinutes: 60 },
];

/** Writes what is missing; answers what it added */
export async function seedServices(admin: AdminCall): Promise<Record<string, number>> {
  const added = { categories: 0, providers: 0, services: 0 };
  const categoryId = new Map<string, string>();
  for (const [area, list] of Object.entries(SERVICE_CATEGORIES) as [Area, { name: string; icon: string }[]][]) {
    const existing = (await admin('GET', `/admin/services/categories?area=${area}`)) as { id: string; slug: string }[];
    for (const c of existing) categoryId.set(`${area}:${c.slug}`, c.id);
    for (const c of list) {
      if (categoryId.has(`${area}:${slug(c.name)}`)) continue;
      const row = await admin('POST', '/admin/services/categories', { area, name: c.name, icon: c.icon });
      categoryId.set(`${area}:${row.slug}`, row.id);
      added.categories++;
    }
  }
  const providers = (await admin('GET', '/admin/services/providers?limit=100')) as { items: { id: string; slug: string }[] };
  const providerId = new Map(providers.items.map((p) => [p.slug, p.id]));
  for (const p of PROVIDERS) {
    if (providerId.has(slug(p.name))) continue;
    const bookingCategory = SERVICES.find((s) => s.provider === p.name && s.area === 'booking')?.category;
    const row = await admin('POST', '/admin/services/providers', { ...p, ...(bookingCategory ? { categoryId: categoryId.get(`booking:${slug(bookingCategory)}`) } : {}) });
    providerId.set(row.slug, row.id);
    added.providers++;
  }
  const services = (await admin('GET', '/admin/services/services?limit=100')) as { items: { slug: string }[] };
  const serviceSlugs = new Set(services.items.map((s) => s.slug));
  for (const s of SERVICES) {
    if (serviceSlugs.has(slug(s.title))) continue;
    const { provider, category, ...rest } = s;
    await admin('POST', '/admin/services/services', { ...rest, providerId: providerId.get(slug(provider)), categoryId: categoryId.get(`${s.area}:${slug(category)}`) });
    added.services++;
  }
  return added;
}
