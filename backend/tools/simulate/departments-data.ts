/**
 * Sample content for the app's department pages (departments module): blog topics, authors and posts, industries
 * and companies around Portland, Play center games with ranking tables, and the Phone tab picks. Written through the
 * Admin Center API, and only what is missing (a topic, author, post, industry, company or game with the same slug
 * is kept as it is), so it is safe to run again. Used by the simulator (flows/departments.ts) and by
 * tools/seed-departments.ts against a running server. The texts are samples.
 */

/** One Admin Center call: method, path under /api, body; answers the parsed body */
export type AdminCall = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => Promise<any>;
/** One store call (a visitor of the store) */
export type StoreCall = (path: string) => Promise<any>;

const P = (...paras: string[]) => paras.map((p) => (p.startsWith('<') ? p : `<p>${p}</p>`)).join('');

export const BLOG_TOPICS = ['Science', 'Economy', 'Education', 'Technology', 'Health', 'Lifestyle'];

export const BLOG_AUTHORS = [
  { name: 'Mina Park', email: 'mina.park@marketly.example', bio: 'Science writer. Space, weather and the physics of everyday things.' },
  { name: 'Daniel Okafor', email: 'daniel.okafor@marketly.example', bio: 'Covers money, prices and small business for the Marketly blog.' },
  { name: 'Lena Hoffmann', email: 'lena.hoffmann@marketly.example', bio: 'Former teacher writing about learning, health and home life.' },
];

export const BLOG_POSTS: { title: string; topic: string; author: number; featured?: boolean; summary: string; body: string }[] = [
  {
    title: 'How reusable rockets land upright',
    topic: 'Science',
    author: 0,
    featured: true,
    summary: 'Grid fins, a last-second engine burn and a lot of software bring a 40-metre booster back to a landing pad.',
    body: P(
      'A rocket booster falling back from the edge of space is moving faster than a rifle bullet. Bringing it down gently on a pad the size of a tennis court takes three things working together: steering surfaces, a precise engine burn and software that recalculates the landing many times a second.',
      '<h2>Steering on the way down</h2>',
      'Folding grid fins near the top of the booster open after separation. They work like the flaps on an aircraft wing, nudging the falling stage toward its target while the air is still thin.',
      '<h2>The landing burn</h2>',
      'Close to the ground the engines light again for less than a minute. Too early and the booster runs out of fuel while still in the air; too late and it hits the pad too fast. The guidance computer solves that problem continuously, which is why the burn often looks like it starts at the very last moment.',
      'Landing legs unfold seconds before touchdown, and the booster settles on the pad with almost no horizontal speed left.',
    ),
  },
  {
    title: 'Why your weather app disagrees with the sky',
    topic: 'Science',
    author: 0,
    summary: 'Forecasts are probabilities over a grid. Here is how to read a 40% chance of rain.',
    body: P(
      'A forecast of 40% rain does not mean it will rain for 40% of the day. It means that, across the forecast area, there is a four in ten chance that measurable rain falls at any given point during the period.',
      'Weather models divide the world into grid boxes a few kilometres wide. Anything smaller than a box, like a single thunderstorm over your neighbourhood, has to be estimated, which is where most of the surprises come from.',
      '<h2>Reading a forecast better</h2>',
      '<ul><li>Look at the hourly view, not just the daily icon.</li><li>Check the radar for showers that are already on their way.</li><li>Treat anything past five days as a trend, not a plan.</li></ul>',
    ),
  },
  {
    title: 'Five ways to spend less on groceries without coupons',
    topic: 'Economy',
    author: 1,
    summary: 'Unit prices, shopping lists and store brands do more than chasing deals.',
    body: P(
      'Food prices have risen faster than most household budgets over the last few years. The biggest savings rarely come from coupons: they come from habits that work every week.',
      '<ol><li><strong>Compare unit prices.</strong> The shelf label shows the price per ounce or per item; the bigger pack is not always cheaper.</li><li><strong>Shop with a list.</strong> Impulse buys add up to a large share of a typical bill.</li><li><strong>Try the store brand.</strong> Many are made in the same plants as the names you know.</li><li><strong>Cook once, eat twice.</strong> Planning leftovers cuts waste.</li><li><strong>Check the freezer section.</strong> Frozen vegetables are picked ripe and keep for months.</li></ol>',
    ),
  },
  {
    title: 'What a small shop owner should know about cash flow',
    topic: 'Economy',
    author: 1,
    summary: 'Profit on paper and money in the bank are not the same thing.',
    body: P(
      'Plenty of profitable small businesses close because they run out of cash. Customers pay late, stock has to be bought weeks before it sells, and taxes arrive in lumps.',
      'A simple weekly cash forecast, with money expected in and money going out for the next eight weeks, shows trouble long before it reaches the bank balance.',
      '<h2>Three quick wins</h2>',
      '<ul><li>Invoice the day the work is done.</li><li>Ask suppliers for 30-day terms.</li><li>Keep one month of fixed costs aside.</li></ul>',
    ),
  },
  {
    title: 'Helping children read for fun again',
    topic: 'Education',
    author: 2,
    summary: 'Choice, comics and reading aloud matter more than reading logs.',
    body: P(
      'Children who read for pleasure do better at school in almost every subject, yet many stop reading on their own around age nine. The good news: small changes at home bring them back.',
      'Let them choose. Comics, graphic novels and books about their hobbies all count. Keep reading aloud long after they can read alone; hearing a fluent reader builds vocabulary they will not meet in conversation.',
      'And keep books where screens usually are: in the car, at the table, next to the sofa.',
    ),
  },
  {
    title: 'Is your old phone still safe to use?',
    topic: 'Technology',
    author: 1,
    summary: 'Security updates, not speed, decide when a phone should be replaced.',
    body: P(
      'A phone can feel perfectly fast and still be risky. What matters most is whether it still receives security updates from its maker.',
      '<h2>How to check</h2>',
      'Open Settings, then About phone or General, and look for the security patch level or the software version. If the date is more than a year old and no update is offered, the phone is no longer supported.',
      'An unsupported phone is fine for music or as a camera at home, but not for banking or shopping.',
    ),
  },
  {
    title: 'A ten-minute stretch routine for desk workers',
    topic: 'Health',
    author: 2,
    summary: 'Neck, shoulders, back and hips, with no equipment.',
    body: P(
      'Sitting for long periods tightens the hips and rounds the shoulders. Ten minutes of gentle stretching once or twice a day helps more than one long session a week.',
      '<ol><li>Neck tilts: 30 seconds each side.</li><li>Shoulder rolls: 10 forward, 10 back.</li><li>Seated twist: 30 seconds each side.</li><li>Standing hip flexor stretch: 45 seconds each side.</li><li>Forward fold with soft knees: 60 seconds.</li></ol>',
      'Move slowly and stop if anything hurts. If pain persists, talk to a doctor or physiotherapist.',
    ),
  },
  {
    title: 'Making a small apartment feel bigger',
    topic: 'Lifestyle',
    author: 2,
    summary: 'Light, mirrors and furniture with legs.',
    body: P(
      'You cannot add square feet, but you can change how a room feels. Light is the biggest lever: pale walls, sheer curtains and lamps at different heights make corners disappear.',
      'Furniture on legs shows more floor, which reads as more space. A large mirror opposite a window doubles the daylight. And clear surfaces do more than any storage trick.',
    ),
  },
];

export const INDUSTRIES = ['Manufacturing', 'Technology', 'Logistics', 'Food', 'Construction', 'Agriculture'];

export const COMPANIES: { name: string; industry: string; city: string; tagline: string; description: string; founded: number; employees: string; verified: boolean; phone: string; email: string; website: string; address: string; lat: number; lng: number }[] = [
  { name: 'Northwind Tools', industry: 'Manufacturing', city: 'Portland, OR', tagline: 'Hand tools made in Oregon since 1982', description: 'Northwind Tools makes forged hand tools for builders and gardeners.\n\nEvery hammer and pruner is finished and tested in our Northwest Portland workshop, and we repair our own tools for life.', founded: 1982, employees: '50–100', verified: true, phone: '503-555-0142', email: 'hello@northwind-tools.example', website: 'https://northwind-tools.example', address: '1200 NW Front Ave, Portland, OR 97209', lat: 45.5331, lng: -122.6787 },
  { name: 'Bitwise Labs', industry: 'Technology', city: 'Beaverton, OR', tagline: 'Software for small shops and makers', description: 'Bitwise Labs builds point-of-sale and inventory software for independent retailers.\n\nWe started as three engineers in a garage and now support more than 2,000 shops on the West Coast.', founded: 2014, employees: '20–50', verified: true, phone: '503-555-0177', email: 'team@bitwise-labs.example', website: 'https://bitwise-labs.example', address: '4800 SW Griffith Dr, Beaverton, OR 97005', lat: 45.4871, lng: -122.8037 },
  { name: 'Cascade Freight', industry: 'Logistics', city: 'Portland, OR', tagline: 'Same-day freight across the metro area', description: 'Cascade Freight moves pallets and parcels for businesses between Portland, Vancouver and Salem.\n\nOur trucks run on a fixed schedule, so customers always know when the next pickup is.', founded: 2003, employees: '100–250', verified: true, phone: '503-555-0110', email: 'dispatch@cascade-freight.example', website: 'https://cascade-freight.example', address: '6200 N Basin Ave, Portland, OR 97217', lat: 45.5909, lng: -122.7081 },
  { name: 'Rose City Bakery Co.', industry: 'Food', city: 'Portland, OR', tagline: 'Wholesale bread for cafés and grocers', description: 'Rose City Bakery bakes sourdough, rye and morning pastries overnight for cafés, restaurants and grocers.\n\nWe use Oregon wheat and deliver before 6 AM.', founded: 1997, employees: '20–50', verified: false, phone: '503-555-0193', email: 'orders@rosecitybakery.example', website: 'https://rosecitybakery.example', address: '2025 SE Division St, Portland, OR 97202', lat: 45.5048, lng: -122.6439 },
  { name: 'Timberline Builders', industry: 'Construction', city: 'Lake Oswego, OR', tagline: 'Custom homes and remodels', description: 'Timberline Builders designs and builds custom homes, additions and kitchen remodels.\n\nA single project manager stays with each client from the first sketch to the final walkthrough.', founded: 2009, employees: '10–20', verified: true, phone: '503-555-0128', email: 'projects@timberline-builders.example', website: 'https://timberline-builders.example', address: '450 A Ave, Lake Oswego, OR 97034', lat: 45.4207, lng: -122.6706 },
  { name: 'Willamette Valley Growers', industry: 'Agriculture', city: 'Hillsboro, OR', tagline: 'Berries and hazelnuts from family farms', description: 'Willamette Valley Growers is a cooperative of 40 family farms growing berries, hazelnuts and seasonal vegetables.\n\nMembers share packing, cold storage and delivery to stores across the region.', founded: 1988, employees: '50–100', verified: false, phone: '503-555-0156', email: 'coop@wvgrowers.example', website: 'https://wvgrowers.example', address: '3700 NW Evergreen Rd, Hillsboro, OR 97124', lat: 45.5456, lng: -122.9365 },
];

const PLAYERS = ['Kai Nakamura', 'Ana Lima', 'Lee Chen', 'Sam Rivera', 'Noor Haddad', 'Jonas Berg', 'Priya Shah', 'Mateo Cruz', 'Ella Novak', 'Omar Said'];

export const GAMES: { title: string; genre: string; featured?: boolean; playersLabel: string; description: string; howToPlay: string[]; prizes: { ranks: string; reward: string }[]; top: number }[] = [
  { title: 'Block Drop', genre: 'Puzzle', featured: true, playersLabel: '12k players this week', description: 'Fit falling blocks into full rows. Rows clear, the pace picks up, and every cleared row scores.', howToPlay: ['Move and turn the falling block', 'Fill a whole row to clear it', 'Clear several rows at once for bonus points'], prizes: [{ ranks: '#1', reward: '$20 coupon' }, { ranks: '#2–3', reward: '$10 coupon' }, { ranks: '#4–10', reward: '$5 coupon' }], top: 48210 },
  { title: 'Word Rush', genre: 'Word', playersLabel: '8.4k players this week', description: 'Find as many words as you can in a grid of letters before the timer runs out.', howToPlay: ['Swipe across touching letters', 'Longer words score more', 'Rare letters double the word'], prizes: [{ ranks: '#1', reward: '$10 coupon' }], top: 3920 },
  { title: 'Turbo Lap', genre: 'Racing', playersLabel: '6.1k players this week', description: 'One-thumb racing on twisting tracks. Drift through corners to fill your boost.', howToPlay: ['Hold to accelerate', 'Release to drift', 'Boost on the straights'], prizes: [], top: 152340 },
  { title: 'Fruit Match', genre: 'Puzzle', playersLabel: '15k players this week', description: 'Swap fruit to line up three or more of a kind and set off chain reactions.', howToPlay: ['Swap two neighbouring fruit', 'Match three or more', 'Chains multiply your score'], prizes: [{ ranks: '#1–3', reward: 'Free delivery for a month' }], top: 92110 },
  { title: 'Tower Tactics', genre: 'Strategy', playersLabel: '3.2k players this week', description: 'Place towers along the path and stop every wave before it reaches your gate.', howToPlay: ['Tap a spot to build', 'Upgrade towers between waves', 'Survive as many waves as you can'], prizes: [], top: 640 },
  { title: 'Coin Hopper', genre: 'Arcade', playersLabel: '9.8k players this week', description: 'Jump from platform to platform collecting coins. Miss a jump and the run is over.', howToPlay: ['Tap to jump', 'Hold for a longer jump', 'Collect coins for points'], prizes: [{ ranks: '#1', reward: '$5 coupon' }], top: 21480 },
];

const PRIZE_NOTE = 'Coupons land in Account › Coupons on Monday. Minimum order $30.';

/** Ten rows from a top score down, with movement since the last update */
function table(top: number, seed: number) {
  return PLAYERS.map((_, i) => ({ name: PLAYERS[(i + seed) % PLAYERS.length]!, score: Math.round(top * (1 - i * 0.07)), change: [2, 0, -1, 1, 3, -2, 0, 1, -1, 0][(i + seed) % 10]! }));
}

export const FARM_TYPES = ['Tractors', 'Harvesters', 'Tillers', 'Seeders', 'Sprayers', 'Irrigation'];
const FARM_HIGHLIGHTS = [['25 hp · 4WD', 'Front loader ready'], ['Grain and corn heads', '6 m cut'], ['5 ft working width'], ['12-row precision'], ['300 L tank · 12 m boom'], ['Drip and sprinkler kits']];

const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Writes what is missing; answers what it added */
export async function seedDepartments(admin: AdminCall, store: StoreCall): Promise<Record<string, number>> {
  const added = { topics: 0, authors: 0, posts: 0, industries: 0, companies: 0, games: 0, rankings: 0, phones: 0, farmMachines: 0 };

  // blogs
  const topics = (await admin('GET', '/admin/departments/blogs/topics')) as { id: string; slug: string }[];
  const topicId = new Map(topics.map((t) => [t.slug, t.id]));
  for (const name of BLOG_TOPICS) {
    if (topicId.has(slug(name))) continue;
    const t = await admin('POST', '/admin/departments/blogs/topics', { name });
    topicId.set(t.slug, t.id);
    added.topics++;
  }
  const authors = (await admin('GET', '/admin/departments/blogs/authors')) as { id: string; slug: string }[];
  const authorId = new Map(authors.map((a) => [a.slug, a.id]));
  for (const a of BLOG_AUTHORS) {
    if (authorId.has(slug(a.name))) continue;
    const row = await admin('POST', '/admin/departments/blogs/authors', a);
    authorId.set(row.slug, row.id);
    added.authors++;
  }
  const posts = (await admin('GET', '/admin/departments/blogs/posts?limit=100')) as { items: { slug: string }[] };
  const postSlugs = new Set(posts.items.map((p) => p.slug));
  for (const p of BLOG_POSTS) {
    if (postSlugs.has(slug(p.title))) continue;
    await admin('POST', '/admin/departments/blogs/posts', { title: p.title, summary: p.summary, body: p.body, topicId: topicId.get(slug(p.topic)), authorId: authorId.get(slug(BLOG_AUTHORS[p.author]!.name)), featured: p.featured ?? false, status: 'published' });
    added.posts++;
  }

  // companies
  const industries = (await admin('GET', '/admin/departments/industries')) as { id: string; slug: string }[];
  const industryId = new Map(industries.map((i) => [i.slug, i.id]));
  for (const name of INDUSTRIES) {
    if (industryId.has(slug(name))) continue;
    const i = await admin('POST', '/admin/departments/industries', { name });
    industryId.set(i.slug, i.id);
    added.industries++;
  }
  const companies = (await admin('GET', '/admin/departments/companies?limit=100')) as { items: { slug: string }[] };
  const companySlugs = new Set(companies.items.map((c) => c.slug));
  for (const c of COMPANIES) {
    if (companySlugs.has(slug(c.name))) continue;
    await admin('POST', '/admin/departments/companies', {
      name: c.name,
      industryId: industryId.get(slug(c.industry)),
      city: c.city,
      tagline: c.tagline,
      description: c.description,
      founded: c.founded,
      employees: c.employees,
      verified: c.verified,
      contacts: { phone: c.phone, email: c.email, website: c.website, address: c.address },
      location: { lat: c.lat, lng: c.lng },
    });
    added.companies++;
  }

  // play center
  const games = (await admin('GET', '/admin/departments/play/games')) as { id: string; slug: string; rankingsUpdatedAt?: string | null }[];
  for (const [n, g] of GAMES.entries()) {
    let row = games.find((x) => x.slug === slug(g.title));
    if (!row) {
      row = await admin('POST', '/admin/departments/play/games', { title: g.title, genre: g.genre, featured: g.featured ?? false, playersLabel: g.playersLabel, description: g.description, howToPlay: g.howToPlay, prizes: g.prizes, prizeNote: g.prizes.length ? PRIZE_NOTE : null });
      added.games++;
    }
    if (row!.rankingsUpdatedAt) continue;
    for (const [k, period] of (['today', 'week', 'all_time'] as const).entries()) {
      await admin('PUT', `/admin/departments/play/games/${row!.id}/rankings/${period}`, { entries: table(Math.round(g.top * [0.6, 1, 1.8][k]!), n + k) });
      added.rankings++;
    }
  }

  // phones: the products of the Phones category (else Electronics), when nothing is picked yet
  const picks = (await admin('GET', '/admin/departments/phones')) as { productIds: string[] };
  if (!picks.productIds.length) {
    const tree = (await admin('GET', '/admin/catalog/categories')) as { name: string; slug: string; children?: unknown[] }[];
    const flat: { name: string; slug: string }[] = [];
    const walk = (list: { name: string; slug: string; children?: unknown[] }[]) => list.forEach((c) => (flat.push(c), walk((c.children ?? []) as never)));
    walk(tree);
    const category = flat.find((c) => /^phones?$/i.test(c.name)) ?? flat.find((c) => /electronics/i.test(c.name));
    if (category) {
      // search results carry the card under product (ads in the list are placed rows too)
      const res = (await store(`/store/search/products?category=${encodeURIComponent(category.slug)}&limit=24`)) as { items: { product?: { productId?: string } }[] };
      const ids = [...new Set(res.items.map((p) => p.product?.productId).filter((id): id is string => Boolean(id)))].slice(0, 24);
      if (ids.length) {
        await admin('PUT', '/admin/departments/phones', { productIds: ids });
        added.phones = ids.length;
      }
    }
  }
  // farm machines: products found by farm words (else a few garden or outdoor products as placeholders), when none are picked yet
  const farm = (await admin('GET', '/admin/departments/farm')) as { machines: unknown[] };
  if (!farm.machines.length) {
    const found: string[] = [];
    for (const q of ['tractor', 'harvester', 'tiller', 'seeder', 'sprayer', 'irrigation', 'mower', 'garden', 'outdoor']) {
      const res = (await store(`/store/search/products?q=${encodeURIComponent(q)}&limit=12`)) as { items: { product?: { productId?: string } }[] };
      for (const id of res.items.map((p) => p.product?.productId)) if (id && !found.includes(id)) found.push(id);
      if (found.length >= 9) break;
    }
    if (found.length) {
      const types = FARM_TYPES.map((name, i) => ({ id: `type-${i + 1}`, name, slug: slug(name) }));
      const machineIds = found.slice(0, 6);
      const attachments = found.slice(6, 9);
      const machines = machineIds.map((productId, i) => ({ productId, typeId: types[i % types.length]!.id, highlights: FARM_HIGHLIGHTS[i % FARM_HIGHLIGHTS.length]!, attachmentIds: i === 0 ? attachments : [] }));
      await admin('PUT', '/admin/departments/farm', { types, machines });
      added.farmMachines = machines.length;
    }
  }
  return added;
}


/* ------------------------------------------------------------------ reviews and play center scores */

/** Any API call: method, full path, body, bearer token, extra headers; answers the parsed body */
export type ApiCall = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, token?: string, headers?: Record<string, string>) => Promise<any>;

/** Sample customers who review companies and games and post scores (signed in, or registered with the dev outbox code) */
export const PLAY_CUSTOMERS = [
  { firstName: 'Kofi', lastName: 'Boateng', email: 'kofi.boateng.play@example.com' },
  { firstName: 'Lina', lastName: 'Wolff', email: 'lina.wolff.play@example.com' },
  { firstName: 'Omar', lastName: 'Haddad', email: 'omar.haddad.play@example.com' },
];
const PLAY_PASSWORD = 'Block-Drop-8842Z';

/** Who reviews which company or game, and what they wrote */
export const DEPARTMENT_REVIEWS: { target: 'company' | 'game'; name: string; by: string; stars: number; text?: string }[] = [
  { target: 'company', name: 'Northwind Tools', by: 'Kofi', stars: 5, text: 'My pruners came back sharpened and like new. Lifetime repair is real.' },
  { target: 'company', name: 'Northwind Tools', by: 'Lina', stars: 4, text: 'Solid hammers; a bit pricey but they last.' },
  { target: 'company', name: 'Cascade Freight', by: 'Omar', stars: 5, text: 'Pickups on time every week.' },
  { target: 'company', name: 'Bitwise Labs', by: 'Lina', stars: 4 },
  { target: 'company', name: 'Rose City Bakery Co.', by: 'Kofi', stars: 5, text: 'Our cafe runs on their sourdough.' },
  { target: 'game', name: 'Block Drop', by: 'Kofi', stars: 5, text: 'Simple and hard to put down.' },
  { target: 'game', name: 'Block Drop', by: 'Omar', stars: 4 },
  { target: 'game', name: 'Word Rush', by: 'Lina', stars: 5, text: 'Great for a coffee break.' },
  { target: 'game', name: 'Fruit Match', by: 'Omar', stars: 3, text: 'Fun, but the levels repeat.' },
];

/** The games whose partners post scores in dev, with the week's best score */
export const SCORE_GAMES: { title: string; top: number }[] = [
  { title: 'Block Drop', top: 21305 },
  { title: 'Word Rush', top: 3920 },
];
/** The development customer whose player ID gets scores when Admin › Play center finds it */
export const DEV_CUSTOMER_EMAIL = 'android.dev.0ae9fb@example.com';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A sample customer's store token: signs in, or registers with the code from the development outbox (DEV_TOKENS on) */
async function sampleCustomer(api: ApiCall, storeApp: () => Promise<string>, p: (typeof PLAY_CUSTOMERS)[number]): Promise<string> {
  const app = await storeApp();
  const device = { kind: 'web' };
  try {
    const session = await api('POST', '/api/public/identity/sessions', { email: p.email, password: PLAY_PASSWORD, audience: 'store', keepSignedIn: false, device }, app);
    if (session.status === 'signed_in') return session.tokens.accessToken as string;
  } catch {
    // not registered yet
  }
  const since = new Date(Date.now() - 1000).toISOString();
  const reg = await api('POST', '/api/public/identity/registrations', { email: p.email, password: PLAY_PASSWORD, firstName: p.firstName, lastName: p.lastName, marketingOptIn: false, acceptedTermsVersion: '2026-01', device }, app);
  let code: string | undefined;
  for (let i = 0; i < 45 && !code; i++) {
    const box = (await api('GET', `/api/dev/notifications/outbox?to=${encodeURIComponent(p.email)}&channel=email&since=${encodeURIComponent(since)}`, undefined, app)) as { items: { subject: string | null; text: string }[] };
    code = box.items.map((m) => `${m.subject ?? ''}\n${m.text}`.match(/\b(\d{6})\b/)?.[1]).find(Boolean);
    if (!code) await wait(2000);
  }
  if (!code) throw new Error(`no verification code reached ${p.email}`);
  const done = await api('POST', `/api/public/identity/verifications/${reg.id}/confirm`, { code, keepSignedIn: false, device }, app);
  return done.tokens.accessToken as string;
}

/**
 * Reviews and Play center scores through the flows the app, the Admin Center and a game partner use:
 * - the sample customers (PLAY_CUSTOMERS) sign in or register and write the DEPARTMENT_REVIEWS they have not written;
 * - each SCORE_GAMES game without scores gets a server key made for this run (nothing secret is printed or kept;
 *   one is rotated when the game already has two) and its partner posts two or three scores for each player: the
 *   sample customers (their player IDs from GET /play/player) and customers Admin › Play center finds, the development
 *   customer first (findPlayers issues their player IDs). Scores are from the last hour (older ones are refused);
 * - Block Drop's #4–10 tier is linked to the Daily rewards $5 off coupon campaign when it runs, so the weekly prize job
 *   has a campaign to give codes from (seed-departments seeds Daily rewards before this).
 */
export async function seedDepartmentActivity(admin: AdminCall, api: ApiCall, storeApp: () => Promise<string>, o: { now?: Date } = {}) {
  const added = { reviews: 0, gameKeys: 0, players: 0, scores: 0, prizeLinks: 0, devCustomer: false, skipped: [] as string[] };
  const tokens = new Map<string, string>();
  for (const p of PLAY_CUSTOMERS) {
    try {
      tokens.set(p.firstName, await sampleCustomer(api, storeApp, p));
    } catch (err) {
      added.skipped.push(`${p.email} (${err instanceof Error ? err.message.slice(0, 80) : 'sign-in failed'})`);
    }
  }

  // reviews the sample customers have not written yet
  for (const v of DEPARTMENT_REVIEWS) {
    const token = tokens.get(v.by);
    if (!token) continue;
    const base = v.target === 'company' ? `/api/store/departments/companies/${slug(v.name)}` : `/api/store/departments/play/games/${slug(v.name)}`;
    const page = await api('GET', base, undefined, token).catch(() => null);
    if (!page || page.myReview) continue;
    await api('POST', `${base}/reviews`, { stars: v.stars, ...(v.text ? { text: v.text } : {}) }, token);
    added.reviews++;
  }

  // players: the sample customers, then customers staff can find (the development customer first)
  const players: string[] = [];
  for (const token of tokens.values()) players.push((await api('GET', '/api/store/departments/play/player', undefined, token)).playerId);
  for (const q of [DEV_CUSTOMER_EMAIL, 'example.com']) {
    if (players.length >= 12) break;
    const found = (await admin('GET', `/admin/departments/play/players?q=${encodeURIComponent(q)}`).catch(() => [])) as { customerId: string; playerId: string }[];
    if (q === DEV_CUSTOMER_EMAIL && found.length) added.devCustomer = true;
    for (const p of found) if (players.length < 12 && !players.includes(p.playerId)) players.push(p.playerId);
  }
  added.players = players.length;

  const games = (await admin('GET', '/admin/departments/play/games')) as { id: string; slug: string; scoreCount: number; activeKeyCount: number }[];
  const now = o.now ?? new Date();
  for (const [n, sg] of SCORE_GAMES.entries()) {
    const g = games.find((x) => x.slug === slug(sg.title));
    if (!g || g.scoreCount > 0 || !players.length) continue;
    let secret: string;
    if (g.activeKeyCount >= 2) {
      const keys = (await admin('GET', `/admin/departments/play/games/${g.id}/keys`)) as { id: string; status: string }[];
      secret = (await admin('POST', `/admin/departments/play/games/${g.id}/keys/${keys.find((k) => k.status === 'active')!.id}/rotate`)).secret;
    } else {
      secret = (await admin('POST', `/admin/departments/play/games/${g.id}/keys`)).secret;
    }
    added.gameKeys++;
    for (const [i, playerId] of players.entries()) {
      const best = Math.round(sg.top * (1 - i * 0.07));
      const tries = [Math.round(best * 0.62), best, ...(i % 2 ? [] : [Math.round(best * 0.41)])];
      for (const [t, score] of tries.entries()) {
        // within the last 50 minutes: scores may be at most an hour old
        const playedAt = new Date(now.getTime() - (50 - i * 3 - t) * 60_000).toISOString();
        await api('POST', '/webhooks/departments/play/scores', { scoreId: `seed-${n}-${playerId}-${t}`, playerId, score, playedAt }, undefined, { 'x-game-key': secret });
        added.scores++;
      }
    }
  }

  // Block Drop #4–10 → the Daily rewards $5 off coupon campaign, when it runs
  const full = ((await admin('GET', '/admin/departments/play/games')) as any[]).find((x) => x.slug === 'block-drop');
  const tier = full ? (full.prizes as any[]).findIndex((p) => p.fromRank === 4 && p.toRank === 10 && !p.campaignId) : -1;
  if (full && tier >= 0) {
    const found = ((await admin('GET', `/admin/promotions/campaigns?q=${encodeURIComponent('Daily rewards: $5 off')}&limit=20`).catch(() => ({ items: [] }))).items ?? []) as { id: string; name: string; status: string }[];
    const campaign = found.find((c) => c.name === 'Daily rewards: $5 off' && (c.status === 'live' || c.status === 'scheduled'));
    if (campaign) {
      const prizes = (full.prizes as any[]).map((p, i) => ({ ranks: p.ranks, reward: p.reward, fromRank: p.fromRank, toRank: p.toRank, campaignId: i === tier ? campaign.id : p.campaignId }));
      await admin('PATCH', `/admin/departments/play/games/${full.id}`, { title: full.title, slug: full.slug, genre: full.genre, icon: full.icon, cover: full.cover, playersLabel: full.playersLabel, featured: full.featured, description: full.description, howToPlay: full.howToPlay, prizes, prizeNote: full.prizeNote ?? PRIZE_NOTE, status: full.status, position: full.position });
      added.prizeLinks++;
    }
  }
  return added;
}
