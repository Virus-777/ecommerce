/**
 * The ten departments of the home rail as the integrated search knows them (pure: no I/O). One entry per section
 * of the search screen: its name and icon (the rail's), the screen it opens, which module answers for it, the
 * kinds that module sends back, and the words that make the query name the department itself (the shortcut card).
 *
 * The names, icons, paths and order are the ones content keeps for the rail (its DEPARTMENT_PAGES); the order
 * breaks ties when two sections match equally well.
 */

export type SectionKey = 'phones' | 'farm' | 'software' | 'welfare' | 'booking' | 'food' | 'blogs' | 'companies' | 'play' | 'rewards';

/** Which module's search function answers for a section. */
export type SectionModule = 'departments' | 'software' | 'services' | 'food' | 'rewards';

export interface DepartmentDef {
  key: SectionKey;
  name: string;
  icon: string;
  path: string;
  tagline: string;
  /** The modules that answer for this section: Phones is both this module's phones and services' two areas. */
  modules: readonly SectionModule[];
  /** Kinds this section shows, in the order the screen lays its groups out. */
  kinds: readonly string[];
  /** Words that make the query name the department (lower case, matched whole or as a prefix of the query). */
  names: readonly string[];
}

export const DEPARTMENTS: readonly DepartmentDef[] = [
  {
    key: 'phones',
    name: 'Phones',
    icon: 'smartphone',
    path: '/phones',
    tagline: 'Phones, OS installs and post-sale repairs',
    modules: ['departments', 'services'],
    kinds: ['phone', 'os_install_service', 'post_sale_service'],
    names: ['phone', 'phones', 'mobile', 'mobiles', 'smartphone', 'smartphones', 'os install', 'post sale', 'repair', 'repairs'],
  },
  {
    key: 'farm',
    name: 'Farm machines',
    icon: 'tractor',
    path: '/farm-machines',
    tagline: 'Tractors and machines delivered to your farm',
    modules: ['departments'],
    kinds: ['farm_machine', 'farm_machine_type'],
    names: ['farm', 'farm machine', 'farm machines', 'farming', 'tractor', 'tractors', 'machinery'],
  },
  {
    key: 'software',
    name: 'Softwares',
    icon: 'app-window',
    path: '/software',
    tagline: 'Apps for your phone and PC',
    modules: ['software'],
    kinds: ['app', 'pack', 'software_category'],
    names: ['software', 'softwares', 'app', 'apps', 'application', 'applications', 'program', 'programs'],
  },
  {
    key: 'welfare',
    name: 'Welfare services',
    icon: 'hand-heart',
    path: '/welfare',
    tagline: 'Care and support services near you',
    modules: ['services'],
    kinds: ['welfare_service', 'welfare_provider', 'welfare_category'],
    names: ['welfare', 'welfare service', 'welfare services', 'care', 'home care', 'support'],
  },
  {
    key: 'food',
    name: 'Food delivery',
    icon: 'utensils',
    path: '/food',
    tagline: 'Order from restaurants near you',
    modules: ['food'],
    kinds: ['restaurant', 'dish', 'food_category'],
    names: ['food', 'food delivery', 'restaurant', 'restaurants', 'takeaway', 'take away', 'delivery', 'eat', 'meal', 'meals'],
  },
  {
    key: 'booking',
    name: 'Booking',
    icon: 'calendar-check',
    path: '/booking',
    tagline: 'Book a time with a provider near you',
    modules: ['services'],
    kinds: ['booking_provider', 'booking_service', 'booking_category'],
    names: ['booking', 'bookings', 'book', 'appointment', 'appointments', 'reservation', 'reservations'],
  },
  {
    key: 'blogs',
    name: 'Blogs',
    icon: 'newspaper',
    path: '/blogs',
    tagline: 'Stories, guides and reviews',
    modules: ['departments'],
    kinds: ['post', 'author', 'topic'],
    names: ['blog', 'blogs', 'post', 'posts', 'article', 'articles', 'story', 'stories'],
  },
  {
    key: 'companies',
    name: 'Companies',
    icon: 'building-2',
    path: '/companies',
    tagline: 'The companies on Marketly',
    modules: ['departments'],
    kinds: ['company', 'industry'],
    names: ['company', 'companies', 'business', 'businesses', 'directory', 'industry', 'industries'],
  },
  {
    key: 'play',
    name: 'Play center',
    icon: 'gamepad-2',
    path: '/play',
    tagline: 'Games and their ranking tables',
    modules: ['departments'],
    kinds: ['game', 'genre'],
    names: ['play', 'play center', 'play centre', 'game', 'games', 'gaming', 'ranking', 'rankings'],
  },
  {
    key: 'rewards',
    name: 'Daily rewards',
    icon: 'gift',
    path: '/rewards',
    tagline: 'Check in every day and swap points for coupons',
    modules: ['rewards'],
    kinds: ['reward'],
    names: ['reward', 'rewards', 'daily reward', 'daily rewards', 'points', 'check in', 'checkin', 'streak', 'coupon', 'coupons'],
  },
];

/** Every module that answers for a section, in the order the rail first names them. */
export const MODULES: readonly SectionModule[] = [...new Set(DEPARTMENTS.flatMap((d) => d.modules))];

export const BY_KEY: ReadonlyMap<SectionKey, DepartmentDef> = new Map(DEPARTMENTS.map((d) => [d.key, d]));

/** Rail position of a section, for breaking ties between equally good matches. */
export const RAIL_ORDER: ReadonlyMap<SectionKey, number> = new Map(DEPARTMENTS.map((d, i) => [d.key, i]));

/** The section a kind belongs to (services' areas decide for its kinds). */
export const SECTION_OF_KIND: ReadonlyMap<string, SectionKey> = new Map(DEPARTMENTS.flatMap((d) => d.kinds.map((k) => [k, d.key] as const)));

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Departments the query names: "food delivery" or "food" names Food delivery. The query must be one of those
 * names or the beginning of one, so "food processor" (a product someone is looking for) names nothing.
 */
export function departmentsNamed(q: string): DepartmentDef[] {
  const text = norm(q);
  if (!text) return [];
  return DEPARTMENTS.filter((d) => d.names.some((n) => text === n || `${n} `.startsWith(`${text} `)));
}

/** Which modules must be asked for these sections (one call each, with every section it answers for). */
export function modulesFor(keys: readonly SectionKey[]): { module: SectionModule; sections: SectionKey[] }[] {
  const out: { module: SectionModule; sections: SectionKey[] }[] = [];
  for (const module of MODULES) {
    const sections = DEPARTMENTS.filter((d) => d.modules.includes(module) && keys.includes(d.key)).map((d) => d.key);
    if (sections.length) out.push({ module, sections });
  }
  return out;
}

/** The sections a module answers for, as that module names them in `DeptSearchRequest.sections`. */
export const sectionsOfModule = (module: SectionModule): SectionKey[] => DEPARTMENTS.filter((d) => d.modules.includes(module)).map((d) => d.key);
