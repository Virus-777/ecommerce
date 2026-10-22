import { describe, expect, it } from 'vitest';
import { checkChoices, choicesPriced, discountBadge, etaLabel, etaWindow, geocodeInputOf, groupsOf, lowestUnitPrice, makeRef, openStateOf, orderedItemsOf, shortName } from '../domain/rules.js';
import { EXTRAS_GROUP, SIZE_GROUP } from './helpers.js';

const LA = 'America/Los_Angeles';
const week = (from: string, to: string) => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday) => ({ weekday, open: true, from, to }));
/** A wall time in Los Angeles in January (UTC−8) */
const la = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`);

describe('opening hours', () => {
  it('reads open, closing soon, opening later today and closed today', () => {
    const hours = week('11:00', '23:00');
    expect(openStateOf(hours, la('2030-01-09', '12:00'), LA)).toEqual({ open: true, label: 'Open until 11 PM', opensLabel: null });
    expect(openStateOf(hours, la('2030-01-09', '22:45'), LA).label).toBe('Closes soon · 11 PM');
    expect(openStateOf(hours, la('2030-01-09', '09:30'), LA)).toEqual({ open: false, label: 'Closed · opens 11 AM', opensLabel: 'opens 11 AM' });
    expect(openStateOf(hours, la('2030-01-09', '23:30'), LA)).toEqual({ open: false, label: 'Closed today', opensLabel: 'opens tomorrow 11 AM' });
    // paused restaurants read as closed
    expect(openStateOf(hours, la('2030-01-09', '12:00'), LA, true)).toEqual({ open: false, label: 'Closed today', opensLabel: null });
  });

  it('closes past midnight when the closing time is earlier than the opening time', () => {
    const evenings = week('17:00', '01:30');
    expect(openStateOf(evenings, la('2030-01-09', '16:00'), LA).label).toBe('Closed · opens 5 PM');
    expect(openStateOf(evenings, la('2030-01-09', '21:00'), LA).label).toBe('Open until 1:30 AM');
    // Thursday 00:30 is still Wednesday night's opening
    expect(openStateOf(evenings, la('2030-01-10', '00:30'), LA)).toMatchObject({ open: true, label: 'Open until 1:30 AM' });
    expect(openStateOf(evenings, la('2030-01-10', '01:15'), LA).label).toBe('Closes soon · 1:30 AM');
    expect(openStateOf(evenings, la('2030-01-10', '02:00'), LA).label).toBe('Closed · opens 5 PM');
  });

  it('names the next opening day when closed for days', () => {
    const weekdaysOnly = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday, i) => (i < 5 ? { weekday, open: true, from: '11:00', to: '20:00' } : { weekday, open: false }));
    // Saturday 2030-01-12
    expect(openStateOf(weekdaysOnly, la('2030-01-12', '12:00'), LA)).toEqual({ open: false, label: 'Closed today', opensLabel: 'opens Mon 11 AM' });
  });
});

describe('options and prices', () => {
  const groups = groupsOf([SIZE_GROUP, EXTRAS_GROUP], 'USD');

  it('checks required groups, limits and known choices without applying defaults', () => {
    expect(checkChoices(groups, [])).toEqual({ problem: { groupId: 'size', message: 'Choose a size' } });
    expect(checkChoices(groups, [{ groupId: 'size', choiceIds: ['regular', 'family'] }])).toMatchObject({ problem: { groupId: 'size' } });
    expect(checkChoices(groups, [{ groupId: 'crust', choiceIds: ['thin'] }])).toMatchObject({ problem: { groupId: 'crust' } });
    expect(checkChoices(groups, [{ groupId: 'size', choiceIds: ['huge'] }])).toMatchObject({ problem: { groupId: 'size' } });
    const ok = checkChoices(groups, [{ groupId: 'extras', choiceIds: ['basil', 'mozzarella'] }, { groupId: 'size', choiceIds: ['regular'] }]);
    // in the menu's order
    expect(ok).toEqual({ options: [{ groupId: 'size', choiceIds: ['regular'] }, { groupId: 'extras', choiceIds: ['mozzarella', 'basil'] }] });
    expect(choicesPriced(groups, (ok as { options: never }).options)).toEqual({ delta: 390, label: '12" regular · Extra mozzarella · Fresh basil' });
  });

  it('works out the cheapest allowed price and the discount badge', () => {
    expect(lowestUnitPrice(1450, groups)).toBe(1150);
    expect(lowestUnitPrice(250, groups)).toBe(-50);
    expect(discountBadge(1190, 1390)).toBe('-14%');
    expect(discountBadge(850, 1000)).toBe('-15%');
    expect(discountBadge(1000, null)).toBeNull();
  });
});

describe('labels', () => {
  it('shows the delivery time before acceptance and the arrival window after it', () => {
    expect(etaLabel('placed', { from: null, to: null }, { min: 20, max: 30 }, LA)).toBe('Usually 20–30 min');
    const w = etaWindow(la('2030-01-09', '19:18'), 20, 30);
    expect(etaLabel('preparing', w, { min: 20, max: 30 }, LA)).toBe('Arrives 7:40–7:50 PM');
    expect(etaLabel('on_the_way', etaWindow(la('2030-01-09', '11:25'), 20, 45), { min: 20, max: 45 }, LA)).toBe('Arrives 11:45 AM–12:10 PM');
    expect(etaLabel('delivered', w, { min: 20, max: 30 }, LA)).toBeNull();
  });

  it('makes FD- references and signs reviews with a first name and initial', () => {
    expect(makeRef()).toMatch(/^FD-[2-9A-HJ-NP-Z]{5}$/);
    expect(shortName('Dana Ross')).toBe('Dana R.');
    expect(shortName('')).toBe('Customer');
  });
});

describe('places and reviews', () => {
  const at = (address: string | null, city: string | null, region: string | null = null, postal_code: string | null = null) => ({ address, city, region, postal_code });
  it('reads a restaurant address for the geocoder', () => {
    expect(geocodeInputOf(at('118 Bay Rd', 'Portland, OR'))).toEqual({ line1: '118 Bay Rd', city: 'Portland', region: 'OR' });
    expect(geocodeInputOf(at(' 9 Harbor Way ', 'Portland', 'OR', '97209'))).toEqual({ line1: '9 Harbor Way', city: 'Portland', region: 'OR', postalCode: '97209' });
    // a region given apart wins over a different state written in the city
    expect(geocodeInputOf(at(null, 'Vancouver, BC', 'WA'))).toEqual({ city: 'Vancouver, BC', region: 'WA' });
    expect(geocodeInputOf(at(null, 'vancouver, wa', 'WA'))).toEqual({ city: 'vancouver', region: 'WA' });
    expect(geocodeInputOf(at('1 Main St', null))).toBeNull();
    expect(geocodeInputOf(at('1 Main St', '  '))).toBeNull();
  });

  it('lists what a reviewer ordered', () => {
    expect(orderedItemsOf([{ name: 'Margherita pizza 12"', quantity: 2 }, { name: 'Tiramisu', quantity: 1 }])).toEqual(['2 × Margherita pizza 12"', 'Tiramisu']);
    expect(orderedItemsOf(null)).toEqual([]);
    expect(orderedItemsOf([null, { quantity: 3 }])).toEqual([]);
  });
});
