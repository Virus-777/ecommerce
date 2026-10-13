/**
 * The simulator's sample data: people, Portland addresses, stores and products. Plain lists, so the owner can
 * change what a run looks like without touching the flows. Money is in cents (USD). Prices end in 99, 49, 95 or
 * 00 on purpose: the development card processor treats some endings specially (…02 declines, …03 times out,
 * refunds ending 12–15 fail or stall; payments/providers/card-processor.ts), and a normal sale must not hit them.
 */

export const FIRST_NAMES = [
  'Ana', 'Ben', 'Chloe', 'Daniel', 'Elena', 'Felix', 'Grace', 'Hiro', 'Isabel', 'Jamal', 'Katie', 'Liam', 'Maya', 'Noah',
  'Olivia', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Umar', 'Vera', 'Wes', 'Yuki', 'Zoe', 'Marcus', 'Leah', 'Owen',
];

export const LAST_NAMES = [
  'Lopez', 'Nguyen', 'Patel', 'Johnson', 'Kim', 'Okafor', 'Schmidt', 'Rivera', 'Tanaka', 'Walsh', 'Hughes', 'Moreno',
  'Lindqvist', 'Brooks', 'Chen', 'Diaz', 'Foster', 'Garcia', 'Haddad', 'Iverson', 'Jensen', 'Kowalski', 'Mendoza', 'Park',
];

/** Real Portland-area streets with the ZIP code of that block */
export const PORTLAND_ADDRESSES = [
  { line1: '1120 SW 5th Ave', postalCode: '97204', city: 'Portland' },
  { line1: '921 SW Washington St', postalCode: '97205', city: 'Portland' },
  { line1: '1005 W Burnside St', postalCode: '97209', city: 'Portland' },
  { line1: '2122 NE Broadway St', postalCode: '97232', city: 'Portland' },
  { line1: '3520 SE Hawthorne Blvd', postalCode: '97214', city: 'Portland' },
  { line1: '4038 N Mississippi Ave', postalCode: '97227', city: 'Portland' },
  { line1: '1640 NE Alberta St', postalCode: '97211', city: 'Portland' },
  { line1: '7905 SE Division St', postalCode: '97206', city: 'Portland' },
  { line1: '2315 NW Thurman St', postalCode: '97210', city: 'Portland' },
  { line1: '1305 SE Stark St', postalCode: '97214', city: 'Portland' },
  { line1: '8310 N Lombard St', postalCode: '97203', city: 'Portland' },
  { line1: '5340 NE Sandy Blvd', postalCode: '97213', city: 'Portland' },
  { line1: '3325 SE Belmont St', postalCode: '97214', city: 'Portland' },
  { line1: '7820 SW Capitol Hwy', postalCode: '97219', city: 'Portland' },
  { line1: '6620 SE Foster Rd', postalCode: '97206', city: 'Portland' },
  { line1: '2225 NE Martin Luther King Jr Blvd', postalCode: '97212', city: 'Portland' },
  { line1: '1510 NW 23rd Ave', postalCode: '97210', city: 'Portland' },
  { line1: '4225 SE Woodstock Blvd', postalCode: '97206', city: 'Portland' },
  { line1: '12350 SW Broadway St', postalCode: '97005', city: 'Beaverton' },
  { line1: '210 NE Division St', postalCode: '97030', city: 'Gresham' },
];

/** Second address lines, used now and then */
export const UNITS = ['Apt 2B', 'Unit 4', 'Suite 210', 'Apt 11', '#305'];

/** Business addresses of the seller stores (Portland industrial and retail streets) */
export const BUSINESS_ADDRESSES = [
  { line1: '410 SE Grand Ave', postalCode: '97214', city: 'Portland' },
  { line1: '2730 NW 31st Ave', postalCode: '97210', city: 'Portland' },
  { line1: '5800 NE Columbia Blvd', postalCode: '97218', city: 'Portland' },
  { line1: '1825 SE 7th Ave', postalCode: '97214', city: 'Portland' },
  { line1: '3030 NW Yeon Ave', postalCode: '97210', city: 'Portland' },
  { line1: '7400 SW Macadam Ave', postalCode: '97219', city: 'Portland' },
];

/** The company warehouse of the Official Store (created once, then reused by every run) */
export const OFFICIAL_WAREHOUSE = {
  code: 'PDX1',
  name: 'Portland fulfilment center',
  address: { name: 'Marketly Fulfilment', line1: '11400 N Lombard St', city: 'Portland', region: 'OR', postalCode: '97203', country: 'US' },
  timeZone: 'America/Los_Angeles',
  pickBins: ['A-01-1', 'A-01-2', 'A-01-3', 'A-02-1', 'A-02-2', 'A-02-3'],
};

/** Category tree the Catalog Manager keeps (created once, reused) */
export const CATEGORIES: { name: string; children: string[] }[] = [
  { name: 'Electronics', children: ['Headphones', 'Speakers'] },
  { name: 'Home & Kitchen', children: ['Coffee & Tea', 'Cookware'] },
  { name: 'Sports & Outdoors', children: ['Camping', 'Cycling'] },
];

export interface ProductSeed {
  title: string;
  brand: string;
  /** Leaf category name (CATEGORIES) */
  category: string;
  model: string;
  description: string;
  features: string[];
  specs: Record<string, string>;
  included: string[];
  /** One option name and its values: one variant per value */
  option: { name: string; values: string[] };
  price: number;
  weightGrams: number;
}

/** A seller store: its theme decides which products it lists */
export interface StoreSeed {
  name: string;
  /** Short code for SKUs */
  code: string;
  products: ProductSeed[];
}

const p = (x: ProductSeed) => x;

export const STORES: StoreSeed[] = [
  {
    name: 'Rose City Audio',
    code: 'RCA',
    products: [
      p({ title: 'Bridgetown ANC wireless headphones', brand: 'Bridgetown Sound', category: 'Headphones', model: 'BT-700', description: 'Over-ear headphones with adaptive noise cancelling, 38 hours of battery and a fold-flat design that fits a commuter bag.', features: ['Adaptive noise cancelling', '38 h battery', 'USB-C fast charge'], specs: { 'Battery life': '38 h', Weight: '254 g' }, included: ['Headphones', 'USB-C cable', 'Travel case'], option: { name: 'Color', values: ['Black', 'Sand'] }, price: 17999, weightGrams: 600 }),
      p({ title: 'Bridgetown studio monitor headphones', brand: 'Bridgetown Sound', category: 'Headphones', model: 'BT-M50', description: 'Closed-back studio headphones with a flat response for mixing, a detachable cable and replaceable ear pads.', features: ['Closed back', 'Detachable cable', '45 mm drivers'], specs: { Impedance: '38 ohm', Weight: '285 g' }, included: ['Headphones', 'Coiled cable', '6.3 mm adapter'], option: { name: 'Color', values: ['Black'] }, price: 12900, weightGrams: 650 }),
      p({ title: 'Hawthorne portable Bluetooth speaker', brand: 'Hawthorne Audio', category: 'Speakers', model: 'HA-S2', description: 'A splash-proof speaker the size of a water bottle with 16 hours of play time and a strap for the bike or the backpack.', features: ['IPX7 splash proof', '16 h battery', 'Stereo pairing'], specs: { 'Battery life': '16 h', Waterproof: 'IPX7' }, included: ['Speaker', 'Strap', 'USB-C cable'], option: { name: 'Color', values: ['Teal', 'Charcoal', 'Coral'] }, price: 7999, weightGrams: 540 }),
      p({ title: 'Hawthorne bookshelf speakers (pair)', brand: 'Hawthorne Audio', category: 'Speakers', model: 'HA-B4', description: 'Powered bookshelf speakers with Bluetooth, an optical input and a walnut veneer that suits a living room shelf.', features: ['Bluetooth 5.3', 'Optical input', 'Walnut veneer'], specs: { Power: '2 × 40 W', Inputs: 'Optical, RCA, Bluetooth' }, included: ['2 speakers', 'Remote', 'Speaker cable'], option: { name: 'Finish', values: ['Walnut'] }, price: 24900, weightGrams: 9000 }),
    ],
  },
  {
    name: 'Stumptown Brew Supply',
    code: 'SBS',
    products: [
      p({ title: 'Couv pour-over coffee kettle 1 L', brand: 'Couv Coffee Works', category: 'Coffee & Tea', model: 'CK-1', description: 'A gooseneck kettle with a thermometer in the lid for slow, even pour-over brewing on any stovetop, induction included.', features: ['Gooseneck spout', 'Lid thermometer', 'Induction ready'], specs: { Capacity: '1 L', Material: 'Stainless steel' }, included: ['Kettle', 'Thermometer'], option: { name: 'Color', values: ['Matte black', 'Brushed steel'] }, price: 4999, weightGrams: 900 }),
      p({ title: 'Couv burr coffee grinder', brand: 'Couv Coffee Works', category: 'Coffee & Tea', model: 'CG-40', description: 'A conical burr grinder with 40 settings from espresso to French press and a quiet motor for early mornings.', features: ['40 grind settings', 'Conical steel burrs', 'Quiet motor'], specs: { Hopper: '250 g', Settings: '40' }, included: ['Grinder', 'Cleaning brush'], option: { name: 'Color', values: ['Black', 'White'] }, price: 13900, weightGrams: 2600 }),
      p({ title: 'Couv glass pour-over dripper', brand: 'Couv Coffee Works', category: 'Coffee & Tea', model: 'CD-02', description: 'A heat-resistant glass dripper with a spiral ribbed wall for an even flow, for one or two cups at a time.', features: ['Borosilicate glass', 'Spiral ribs', '1–2 cups'], specs: { Size: '02', Material: 'Glass' }, included: ['Dripper', 'Paper filters (40)'], option: { name: 'Color', values: ['Clear'] }, price: 2499, weightGrams: 400 }),
      p({ title: 'Multnomah cast iron skillet 10 in', brand: 'Multnomah Ironworks', category: 'Cookware', model: 'MI-10', description: 'A pre-seasoned cast iron skillet with a long helper handle, made to go from the stovetop to the oven to the campfire.', features: ['Pre-seasoned', 'Oven safe', 'Helper handle'], specs: { Diameter: '10 in', Weight: '2.4 kg' }, included: ['Skillet'], option: { name: 'Size', values: ['10 in', '12 in'] }, price: 3999, weightGrams: 2800 }),
    ],
  },
  {
    name: 'Willamette Outdoor Supply',
    code: 'WOS',
    products: [
      p({ title: 'Forest Park 2-person backpacking tent', brand: 'Forest Park Gear', category: 'Camping', model: 'FP-T2', description: 'A freestanding two-person tent with two doors, a full-coverage fly and a packed weight under two kilograms.', features: ['Freestanding', 'Two doors', 'Packed weight 1.9 kg'], specs: { Capacity: '2 people', 'Packed weight': '1.9 kg' }, included: ['Tent', 'Fly', 'Stakes', 'Stuff sack'], option: { name: 'Color', values: ['Moss', 'Rust'] }, price: 22900, weightGrams: 2100 }),
      p({ title: 'Forest Park down sleeping bag 20 °F', brand: 'Forest Park Gear', category: 'Camping', model: 'FP-SB20', description: 'A mummy sleeping bag with responsibly sourced down, rated to 20 °F, that compresses to the size of a loaf of bread.', features: ['650 fill down', 'Rated 20 °F', 'Compression sack'], specs: { 'Comfort rating': '20 °F', Fill: '650 down' }, included: ['Sleeping bag', 'Compression sack'], option: { name: 'Length', values: ['Regular', 'Long'] }, price: 18999, weightGrams: 1300 }),
      p({ title: 'Columbia Gorge insulated water bottle 32 oz', brand: 'Gorge Trail Co', category: 'Camping', model: 'GT-B32', description: 'A double-wall steel bottle that keeps water cold for a full day on the trail, with a leak-proof chug cap.', features: ['Keeps cold 24 h', 'Leak-proof cap', 'Dishwasher safe'], specs: { Capacity: '32 oz', Material: 'Stainless steel' }, included: ['Bottle', 'Chug cap'], option: { name: 'Color', values: ['Glacier', 'Basalt', 'Fir'] }, price: 3499, weightGrams: 500 }),
      p({ title: 'Springwater commuter bike light set', brand: 'Springwater Cycle', category: 'Cycling', model: 'SW-L800', description: 'A rechargeable front and rear light set with an 800 lumen front beam for dark, wet Portland winter commutes.', features: ['800 lumen front', 'USB-C charging', 'Rain proof'], specs: { 'Front output': '800 lm', Runtime: '2–20 h' }, included: ['Front light', 'Rear light', 'Mounts'], option: { name: 'Set', values: ['Front and rear'] }, price: 5995, weightGrams: 350 }),
    ],
  },
];

/** Products the Official Store sells from its own warehouse (stock received through purchasing) */
export const OFFICIAL_PRODUCTS: ProductSeed[] = [
  p({ title: 'Marketly Basics USB-C charging cable 2 m', brand: 'Marketly Basics', category: 'Headphones', model: 'MB-C2', description: 'A braided USB-C to USB-C cable rated for 100 W charging and fast data, long enough to reach the couch.', features: ['100 W charging', 'Braided', '2 m'], specs: { Length: '2 m', Power: '100 W' }, included: ['Cable'], option: { name: 'Color', values: ['Graphite'] }, price: 1499, weightGrams: 120 }),
  p({ title: 'Marketly Basics French press 34 oz', brand: 'Marketly Basics', category: 'Coffee & Tea', model: 'MB-FP34', description: 'A borosilicate glass French press with a stainless steel frame and a four-level filter for a clean cup.', features: ['Borosilicate glass', '4-level filter', '34 oz'], specs: { Capacity: '34 oz' }, included: ['French press'], option: { name: 'Color', values: ['Silver'] }, price: 2900, weightGrams: 900 }),
  p({ title: 'Marketly Basics camping lantern', brand: 'Marketly Basics', category: 'Camping', model: 'MB-L1', description: 'A rechargeable LED lantern with three brightness levels and a hook, bright enough for a whole campsite.', features: ['3 brightness levels', 'Rechargeable', 'Hanging hook'], specs: { Output: '400 lm', Runtime: '8–40 h' }, included: ['Lantern', 'USB-C cable'], option: { name: 'Color', values: ['Orange'] }, price: 2499, weightGrams: 450 }),
];

/** Brand descriptions the Catalog Manager uses when it creates a missing brand */
export const BRAND_NOTES: Record<string, string> = {
  'Bridgetown Sound': 'Headphones tuned in Portland.',
  'Hawthorne Audio': 'Speakers for small rooms and long rides.',
  'Couv Coffee Works': 'Coffee tools for the slow morning.',
  'Multnomah Ironworks': 'Cast iron that outlives its owner.',
  'Forest Park Gear': 'Light camping gear for the Pacific Northwest.',
  'Gorge Trail Co': 'Bottles and flasks for the trail.',
  'Springwater Cycle': 'Lights and racks for year-round commuters.',
  'Marketly Basics': "Marketly's own everyday basics.",
};

/** Things customers write */
export const REVIEW_TEXTS = [
  { headline: 'Worth every penny', text: 'Arrived two days early and works exactly as described. I have used it every day this week and would buy it again.' },
  { headline: 'Solid and well made', text: 'Feels sturdier than the one it replaced. The finish is nicer than the photos show and setup took five minutes.' },
  { headline: 'Great for the price', text: 'Does everything I need. Packaging was minimal and recyclable, which I appreciate. Took a star off for the short cable.' },
];

export const SELLER_REPLIES = [
  'Thank you for the kind words! We pack every order by hand in our Portland shop, so this made our day.',
  'Thanks for taking the time to write this. If the cable ever gives you trouble, message us and we will send a longer one.',
];

export const QUESTIONS_TO_SELLER = [
  'Hi, my order shows as shipped but the tracking has not moved since yesterday. Can you check on it?',
  'Hello! Could you include a gift receipt with my order? It is a birthday present.',
];

export const SELLER_ANSWERS = [
  'Thanks for reaching out. The carrier scanned it this morning in Portland, so it should move again today.',
  'Happy to! We added a gift receipt and left the prices off the packing slip.',
];
