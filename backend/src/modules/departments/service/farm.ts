/**
 * Farm machines: the machine types staff keep and the machines they pick (catalog products, bought through cart and
 * checkout; renting is left out of v1) with their attachments, in one farm_setup row (id farm). The cards come from
 * search (cardsFor); machines and attachments the store no longer shows are left out.
 */
import { newId } from '../../../kernel/lib/ids.js';
import { slugify } from '../../../kernel/lib/text.js';
import type * as search from '../../../spec/search.js';
import type { FarmAdmin, FarmInput, FarmMachine, FarmMachineCard, FarmMachineInput, FarmMachineType, FarmPage, FarmType } from '../../../spec/departments.js';
import { LIMITS } from '../domain/rules.js';
import { actorKey, invalid, iso, notFound, requireText, unique, type By } from './base.js';
import { DepartmentsPhones } from './phones.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const typesOf = (v: unknown): FarmType[] => (Array.isArray(v) ? (v as FarmType[]).filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string').map((t) => ({ id: t.id, name: t.name, slug: t.slug || slugify(t.name) })) : []);
const machinesOf = (v: unknown): FarmMachineInput[] =>
  Array.isArray(v)
    ? (v as FarmMachineInput[])
        .filter((m) => m && typeof m.productId === 'string' && typeof m.typeId === 'string')
        .map((m) => ({ productId: m.productId, typeId: m.typeId, highlights: Array.isArray(m.highlights) ? m.highlights.filter((h) => typeof h === 'string') : [], attachmentIds: Array.isArray(m.attachmentIds) ? m.attachmentIds.filter((a) => typeof a === 'string') : [] }))
    : [];

export class DepartmentsFarm extends DepartmentsPhones {
  private async farmSetup() {
    const row = await this.repo.getFarm();
    return { types: typesOf(row?.types), machines: machinesOf(row?.machines), updatedAt: iso(row?.updated_at) };
  }

  /** Cards by product id (search keeps only products it still shows) */
  private async cardsById(ids: string[], postalCode?: string): Promise<Map<string, search.ProductCard>> {
    const cards = await this.cardsFor(unique(ids), postalCode);
    return new Map(cards.map((c) => [c.productId, c]));
  }

  async getFarm(q: { postalCode?: string }): Promise<FarmPage> {
    const { types, machines } = await this.farmSetup();
    const cards = await this.cardsById(machines.map((m) => m.productId), q.postalCode);
    const out: FarmMachineCard[] = [];
    for (const m of machines) {
      const product = cards.get(m.productId);
      if (product) out.push({ product, typeId: m.typeId, highlights: m.highlights ?? [] });
    }
    return { types, machines: out };
  }

  async getFarmMachine(productId: string): Promise<FarmMachine> {
    const { machines } = await this.farmSetup();
    const m = machines.find((x) => x.productId === productId);
    if (!m) throw notFound('Machine');
    const cards = await this.cardsById([m.productId, ...(m.attachmentIds ?? [])]);
    const product = cards.get(m.productId);
    if (!product) throw notFound('Machine');
    return { product, typeId: m.typeId, highlights: m.highlights ?? [], attachments: (m.attachmentIds ?? []).map((id) => cards.get(id)).filter((c): c is search.ProductCard => Boolean(c)) };
  }

  /**
   * The type of each picked machine, keyed by product id (farm statistics group orders by machine type).
   * A product that is not picked any more, or whose type has been removed, is left out rather than failing, so
   * old orders can still be counted; no card is read, only the farm setup row.
   */
  async farmMachineTypes(productIds: string[]): Promise<Record<string, FarmMachineType>> {
    const wanted = new Set(productIds);
    if (!wanted.size) return {};
    const { types, machines } = await this.farmSetup();
    const names = new Map(types.map((t) => [t.id, t.name]));
    const out: Record<string, FarmMachineType> = {};
    for (const m of machines) {
      if (!wanted.has(m.productId)) continue;
      const typeName = names.get(m.typeId);
      if (typeName) out[m.productId] = { typeId: m.typeId, typeName };
    }
    return out;
  }

  async getFarmAdmin(): Promise<FarmAdmin> {
    const { types, machines, updatedAt } = await this.farmSetup();
    const ids = unique(machines.flatMap((m) => [m.productId, ...(m.attachmentIds ?? [])]));
    return { types, machines, products: await this.cardsFor(ids), updatedAt };
  }

  async setFarm(input: FarmInput, by: By): Promise<FarmAdmin> {
    const typesIn = input.types ?? [];
    if (!typesIn.length) throw invalid('types', 'Add at least one machine type');
    if (typesIn.length > LIMITS.farmTypes) throw invalid('types', `Use at most ${LIMITS.farmTypes} types`);
    const known = new Set((await this.farmSetup()).types.map((t) => t.id));
    const slugs = new Set<string>();
    const types: FarmType[] = typesIn.map((t, i) => {
      const name = requireText(t.name, `types[${i}].name`, LIMITS.name);
      const slug = slugify(t.slug?.trim() || name);
      if (!slug) throw invalid(`types[${i}].name`, 'Use letters or digits in the name');
      if (slugs.has(slug)) throw invalid(`types[${i}].name`, 'Two types have the same name');
      slugs.add(slug);
      // ids are kept; a new type (or an id we never handed out) gets a fresh one
      const id = t.id && known.has(t.id) ? t.id : newId();
      return { id, name, slug };
    });
    // a new type sent with a made-up id: machines refer to it by that id, so map it to the new one
    const idMap = new Map(typesIn.map((t, i) => [t.id, types[i]!.id]));
    const machinesIn = input.machines ?? [];
    if (machinesIn.length > LIMITS.farmMachines) throw invalid('machines', `Pick at most ${LIMITS.farmMachines} machines`);
    const seen = new Set<string>();
    const typeIds = new Set(types.map((t) => t.id));
    const machines: FarmMachineInput[] = machinesIn.map((m, i) => {
      const at = `machines[${i}]`;
      if (!UUID.test(m.productId)) throw invalid(`${at}.productId`, 'Not a product id');
      if (seen.has(m.productId)) throw invalid(`${at}.productId`, 'Each machine can be picked once');
      seen.add(m.productId);
      const typeId = idMap.get(m.typeId) ?? m.typeId;
      if (!typeIds.has(typeId)) throw invalid(`${at}.typeId`, 'Pick one of the machine types');
      const highlights = (m.highlights ?? []).map((h) => h.trim()).filter(Boolean);
      if (highlights.length > 4) throw invalid(`${at}.highlights`, 'Use at most 4 spec lines');
      highlights.forEach((h, k) => {
        if (h.length > 60) throw invalid(`${at}.highlights[${k}]`, 'Use at most 60 characters');
      });
      const attachmentIds = unique(m.attachmentIds ?? []);
      if (attachmentIds.length > LIMITS.farmAttachments) throw invalid(`${at}.attachmentIds`, `Use at most ${LIMITS.farmAttachments} attachments`);
      attachmentIds.forEach((a, k) => {
        if (!UUID.test(a)) throw invalid(`${at}.attachmentIds[${k}]`, 'Not a product id');
        if (a === m.productId) throw invalid(`${at}.attachmentIds[${k}]`, 'A machine is not its own attachment');
      });
      return { productId: m.productId, typeId, highlights, attachmentIds };
    });
    const before = await this.farmSetup();
    await this.repo.saveFarm({ types, machines }, actorKey(by.actor), this.now());
    const out = await this.getFarmAdmin();
    await this.audit({ action: 'departments.farm.set', actionLabel: 'Changed the farm machines', target: { type: 'farm_setup', id: 'farm', label: 'Farm machines' }, before: { types: before.types, machines: before.machines }, after: { types, machines } }, by);
    return out;
  }
}
