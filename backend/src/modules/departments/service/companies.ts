/**
 * Companies: industries and company pages kept by staff (logo, photos, description, contacts, map location, verified
 * mark), shown in the app's Companies directory; signed-in customers send inquiries, which staff handle and pass on.
 */
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type Page, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Company, CompanyAdmin, CompanyCard, CompanyContacts, CompanyInput, GeoPoint, Industry, IndustryInput, InquiryAdmin, InquiryInput, InquiryReceipt, InquiryUpdate } from '../../../spec/departments.js';
import { isSafeUrl, LIMITS } from '../domain/rules.js';
import type { CompanyRow, IndustryRow, InquiryRow } from '../ports.js';
import { invalid, mediaList, mediaOf, notFound, optionalText, requireText, unique, type By, type StoredMedia } from './base.js';
import { DepartmentsBlogs } from './blogs.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const contactsOf = (v: unknown): CompanyContacts => {
  const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof c[k] === 'string' && c[k] ? (c[k] as string) : null);
  return { phone: s('phone'), email: s('email'), website: s('website'), address: s('address') };
};
const locationOf = (v: unknown): GeoPoint | null => {
  const g = v as { lat?: unknown; lng?: unknown } | null;
  return g && typeof g.lat === 'number' && typeof g.lng === 'number' ? { lat: g.lat, lng: g.lng } : null;
};

export class DepartmentsCompanies extends DepartmentsBlogs {
  /* ---------------------------------------------------------------- industries */

  private async industriesOut(rows: IndustryRow[]): Promise<Industry[]> {
    const counts = await this.repo.companyCounts();
    return rows.map((i) => ({ id: i.id, slug: i.slug, name: i.name, position: i.position, visible: i.visible, companyCount: counts.get(i.id) ?? 0 }));
  }

  async listIndustries(): Promise<Industry[]> {
    return this.industriesOut(await this.repo.listIndustries({ visibleOnly: true }));
  }

  async listIndustriesAdmin(): Promise<Industry[]> {
    return this.industriesOut(await this.repo.listIndustries());
  }

  async createIndustry(input: IndustryInput, by: By): Promise<Industry> {
    const name = requireText(input.name, 'name', LIMITS.name, 'Name the industry');
    const row: IndustryRow = { id: newId(), slug: await this.slugFor('industries', input.slug, name), name, position: input.position ?? (await this.repo.countIndustries()) + 1, visible: input.visible ?? true };
    await this.repo.insertIndustry(row);
    await this.audit({ action: 'departments.companies.industry.create', actionLabel: 'Added an industry', target: { type: 'industry', id: row.id, label: name }, after: row }, by);
    return (await this.industriesOut([row]))[0]!;
  }

  async updateIndustry(id: string, input: IndustryInput, by: By): Promise<Industry> {
    const before = await this.repo.getIndustry(id);
    if (!before) throw notFound('Industry');
    const name = requireText(input.name, 'name', LIMITS.name, 'Name the industry');
    const patch: Partial<IndustryRow> = { name, slug: input.slug !== undefined && input.slug !== null ? await this.slugFor('industries', input.slug, name, id) : before.slug, ...(input.position != null ? { position: input.position } : {}), ...(input.visible != null ? { visible: input.visible } : {}) };
    const after = (await this.repo.updateIndustry(id, patch))!;
    await this.audit({ action: 'departments.companies.industry.update', actionLabel: 'Edited an industry', target: { type: 'industry', id, label: name }, before, after }, by);
    return (await this.industriesOut([after]))[0]!;
  }

  async deleteIndustry(id: string, by: By): Promise<void> {
    const i = await this.repo.getIndustry(id);
    if (!i) throw notFound('Industry');
    if (await this.repo.countCompanies({ industryId: id })) throw this.ctx.error('IN_USE', 'Companies still use this industry; move or delete them first');
    await this.repo.deleteIndustry(id);
    await this.audit({ action: 'departments.companies.industry.delete', actionLabel: 'Deleted an industry', target: { type: 'industry', id, label: i.name }, before: i }, by);
  }

  /* ---------------------------------------------------------------- companies */

  private async companyContext(rows: CompanyRow[]) {
    const [industries, refs] = await Promise.all([
      this.repo.industriesByIds(unique(rows.map((c) => c.industry_id).filter((x): x is string => Boolean(x)))),
      this.refsMap(rows.flatMap((c) => [mediaOf(c.logo)?.id, ...mediaList(c.photos).map((p) => p.id)])),
    ]);
    return { industries: new Map(industries.map((i) => [i.id, i])), refs };
  }

  private cardOfCompany(c: CompanyRow, x: Awaited<ReturnType<DepartmentsCompanies['companyContext']>>): CompanyCard {
    const logo = mediaOf(c.logo);
    const ind = c.industry_id ? x.industries.get(c.industry_id) : undefined;
    return { id: c.id, slug: c.slug, name: c.name, logo: logo ? (x.refs.get(logo.id) ?? null) : null, industry: ind ? { id: ind.id, slug: ind.slug, name: ind.name } : null, city: c.city, tagline: c.tagline, verified: c.verified };
  }

  private companyOf(c: CompanyRow, x: Awaited<ReturnType<DepartmentsCompanies['companyContext']>>): Company {
    return {
      ...this.cardOfCompany(c, x),
      description: c.description,
      photos: mediaList(c.photos).map((p) => x.refs.get(p.id)).filter((r): r is common.MediaRef => Boolean(r)),
      founded: c.founded,
      employees: c.employees,
      contacts: contactsOf(c.contacts),
      location: locationOf(c.location),
    };
  }

  private async companiesAdmin(rows: CompanyRow[]): Promise<CompanyAdmin[]> {
    const [x, open] = await Promise.all([this.companyContext(rows), this.repo.openInquiryCounts(rows.map((c) => c.id))]);
    return rows.map((c) => ({ ...this.companyOf(c, x), status: c.status as CompanyAdmin['status'], position: c.position, openInquiryCount: open.get(c.id) ?? 0, createdAt: c.created_at.toISOString(), updatedAt: c.updated_at.toISOString() }));
  }

  private async hiddenIndustryIds(): Promise<string[]> {
    return (await this.repo.listIndustries()).filter((i) => !i.visible).map((i) => i.id);
  }

  async listCompanies(q: { industry?: string; q?: string }, page: PageRequest): Promise<Page<CompanyCard>> {
    let industryId: string | undefined;
    if (q.industry) {
      const i = await this.repo.industryBySlug(q.industry);
      if (!i || !i.visible) return pageOf([], page);
      industryId = i.id;
    }
    const res = await this.repo.pageCompanies({ status: 'published', industryId, hiddenIndustryIds: industryId ? undefined : await this.hiddenIndustryIds(), q: q.q }, page);
    const x = await this.companyContext(res.items);
    return { ...res, items: res.items.map((c) => this.cardOfCompany(c, x)) };
  }

  async getCompany(slug: string): Promise<Company> {
    const c = await this.repo.companyBySlug(slug);
    if (!c || c.status !== 'published') throw notFound('Company');
    return this.companyOf(c, await this.companyContext([c]));
  }

  async listCompaniesAdmin(q: { status?: 'published' | 'hidden'; industryId?: string; q?: string }, page: PageRequest): Promise<Page<CompanyAdmin>> {
    const res = await this.repo.pageCompanies(q, page);
    return { ...res, items: await this.companiesAdmin(res.items) };
  }

  async getCompanyAdmin(id: string): Promise<CompanyAdmin> {
    const c = await this.repo.getCompany(id);
    if (!c) throw notFound('Company');
    return (await this.companiesAdmin([c]))[0]!;
  }

  /** The checked parts of a company input */
  private async companyFields(input: CompanyInput) {
    const name = requireText(input.name, 'name', LIMITS.name, 'Name the company');
    if (input.industryId && !(await this.repo.getIndustry(input.industryId))) throw invalid('industryId', 'Industry not found');
    const photos = (input.photos ?? []).filter((p) => p?.id).map((p) => ({ id: p.id }));
    if (photos.length > LIMITS.companyPhotos) throw invalid('photos', `Add at most ${LIMITS.companyPhotos} photos`);
    const c = input.contacts ?? {};
    const email = optionalText(c.email, 'contacts.email', 200);
    if (email && !EMAIL.test(email)) throw invalid('contacts.email', 'Use an email address like name@example.com');
    const website = optionalText(c.website, 'contacts.website', 300);
    if (website && (!isSafeUrl(website) || !/^https?:\/\//i.test(website))) throw invalid('contacts.website', 'Use a full web address, e.g. https://example.com');
    const loc = input.location;
    if (loc && (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng) || Math.abs(loc.lat) > 90 || Math.abs(loc.lng) > 180)) throw invalid('location', 'Use a latitude from −90 to 90 and a longitude from −180 to 180');
    const year = this.now().getUTCFullYear();
    if (input.founded != null && (!Number.isInteger(input.founded) || input.founded < 1600 || input.founded > year)) throw invalid('founded', `Use a year from 1600 to ${year}`);
    return {
      name,
      industry_id: input.industryId ?? null,
      city: optionalText(input.city, 'city', LIMITS.name),
      tagline: optionalText(input.tagline, 'tagline', LIMITS.tagline),
      description: optionalText(input.description, 'description', 5000),
      logo: input.logo?.id ? { id: input.logo.id } : null,
      photos,
      founded: input.founded ?? null,
      employees: optionalText(input.employees, 'employees', 40),
      contacts: { phone: optionalText(c.phone, 'contacts.phone', 40), email, website, address: optionalText(c.address, 'contacts.address', 300) },
      location: loc ? { lat: loc.lat, lng: loc.lng } : null,
    };
  }

  private filesOf(f: { logo: StoredMedia | null; photos: StoredMedia[] }) {
    return [...(f.logo ? [{ id: f.logo.id, path: 'logo' }] : []), ...f.photos.map((p, i) => ({ id: p.id, path: `photos[${i}]` }))];
  }

  async createCompany(input: CompanyInput, by: By): Promise<CompanyAdmin> {
    const f = await this.companyFields(input);
    const id = newId();
    const now = this.now();
    const row: CompanyRow = { id, slug: await this.slugFor('companies', input.slug, f.name), ...f, verified: input.verified ?? false, status: input.status ?? 'published', position: input.position ?? (await this.repo.nextCompanyPosition()), created_at: now, updated_at: now };
    await this.withMedia(id, f.name, [], this.filesOf(f), () => this.repo.insertCompany(row));
    await this.audit({ action: 'departments.companies.create', actionLabel: 'Added a company', target: { type: 'company', id, label: f.name }, after: row }, by);
    return (await this.companiesAdmin([row]))[0]!;
  }

  async updateCompany(id: string, input: CompanyInput, by: By): Promise<CompanyAdmin> {
    const before = await this.repo.getCompany(id);
    if (!before) throw notFound('Company');
    const f = await this.companyFields(input);
    const slug = input.slug !== undefined && input.slug !== null ? await this.slugFor('companies', input.slug, f.name, id) : before.slug;
    const prev = [...(mediaOf(before.logo) ? [mediaOf(before.logo)!] : []), ...mediaList(before.photos)];
    const patch: Partial<CompanyRow> = { ...f, slug, verified: input.verified ?? before.verified, status: input.status ?? before.status, position: input.position ?? before.position, updated_at: this.now() };
    const after = await this.withMedia(id, f.name, prev, this.filesOf(f), async () => (await this.repo.updateCompany(id, patch))!);
    await this.audit({ action: 'departments.companies.update', actionLabel: after.status !== before.status ? (after.status === 'hidden' ? 'Hid a company' : 'Showed a company again') : 'Edited a company', target: { type: 'company', id, label: f.name }, before, after }, by);
    return (await this.companiesAdmin([after]))[0]!;
  }

  async deleteCompany(id: string, by: By): Promise<void> {
    const c = await this.repo.getCompany(id);
    if (!c) throw notFound('Company');
    await this.repo.transaction((tx) => tx.deleteCompanyCascade(id));
    await this.detachAll(id, [...(mediaOf(c.logo) ? [mediaOf(c.logo)!] : []), ...mediaList(c.photos)]);
    await this.audit({ action: 'departments.companies.delete', actionLabel: 'Deleted a company', target: { type: 'company', id, label: c.name }, before: c }, by);
  }

  /* ---------------------------------------------------------------- inquiries */

  async sendInquiry(companyId: string, customerId: string, input: InquiryInput): Promise<InquiryReceipt> {
    const c = await this.repo.getCompany(companyId);
    if (!c || c.status !== 'published') throw notFound('Company');
    const email = requireText(input.email, 'email', 200, 'Enter your email');
    if (!EMAIL.test(email)) throw invalid('email', 'Use an email address like name@example.com');
    const now = this.now();
    const row: InquiryRow = { id: newId(), company_id: c.id, customer_id: customerId, name: requireText(input.name, 'name', LIMITS.name, 'Enter your name'), email, phone: optionalText(input.phone, 'phone', 40), message: requireText(input.message, 'message', LIMITS.inquiryMessage, 'Write your message'), status: 'new', staff_note: null, created_at: now, updated_at: now };
    await this.repo.insertInquiry(row);
    return { id: row.id, message: `Sent to ${c.name}. They usually reply by email.` };
  }

  private async inquiriesAdmin(rows: InquiryRow[]): Promise<InquiryAdmin[]> {
    const companies = new Map((await this.repo.companiesByIds(unique(rows.map((r) => r.company_id)))).map((c) => [c.id, c.name]));
    return rows.map((r) => ({ id: r.id, companyId: r.company_id, companyName: companies.get(r.company_id) ?? 'Deleted company', customerId: r.customer_id, name: r.name, email: r.email, phone: r.phone, message: r.message, status: r.status as InquiryAdmin['status'], staffNote: r.staff_note, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() }));
  }

  async listInquiries(q: { status?: 'new' | 'replied' | 'closed'; companyId?: string }, page: PageRequest): Promise<Page<InquiryAdmin>> {
    const res = await this.repo.pageInquiries(q, page);
    return { ...res, items: await this.inquiriesAdmin(res.items) };
  }

  async updateInquiry(id: string, input: InquiryUpdate, by: By): Promise<InquiryAdmin> {
    const before = await this.repo.getInquiry(id);
    if (!before) throw notFound('Inquiry');
    const patch: Partial<InquiryRow> = { updated_at: this.now(), ...(input.status ? { status: input.status } : {}), ...(input.staffNote !== undefined ? { staff_note: optionalText(input.staffNote, 'staffNote', 1000) } : {}) };
    const after = (await this.repo.updateInquiry(id, patch))!;
    await this.audit({ action: 'departments.companies.inquiry.update', actionLabel: input.status && input.status !== before.status ? `Marked an inquiry ${input.status}` : 'Noted an inquiry', target: { type: 'inquiry', id, label: `${before.name} · ${before.email}` }, before: { status: before.status, staffNote: before.staff_note }, after: { status: after.status, staffNote: after.staff_note } }, by);
    return (await this.inquiriesAdmin([after]))[0]!;
  }
}
