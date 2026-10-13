// Sample data, taken from the design's fixtures (web-shared/src/data/fixtures.ts) and the store pages' data
// (frontend/src/pages/store/data/*). Money in cents (USD). Prices end in 00, 49, 50, 95 or 99: the dev card
// processor treats endings 02–07, 12–15 and 22–23 specially (payments/providers/card-processor.ts).

export const PASSWORD = 'Marketly-dev-2026!';
export const TZ = 'America/Los_Angeles';
export const usd = (amount) => ({ amount, currency: 'USD' });

/* ---------------------------------------------------------------- owners */

export const OWNERS = {
  olivia: { email: 'olivia.owner@marketly.test', name: 'Olivia Owner' },
  morgan: { email: 'morgan.hale@marketly.test', name: 'Morgan Hale' },
};

/* ---------------------------------------------------------------- taxonomy */

export const CATEGORIES = [
  { key: 'electronics', name: 'Electronics', subs: ['Headphones', 'Speakers', 'Smart home', 'Cameras', 'Wearables'] },
  { key: 'computers', name: 'Computers', subs: ['Monitors', 'Storage', 'Keyboards', 'Laptops', 'Accessories'] },
  { key: 'home', name: 'Home & Kitchen', subs: ['Cookware', 'Bedding', 'Lighting', 'Coffee & tea', 'Cleaning'] },
  { key: 'fashion', name: 'Fashion', subs: ['Knitwear', 'Shoes', 'Bags', 'Outerwear', 'Accessories'] },
  { key: 'sports', name: 'Sports & Outdoors', subs: ['Hiking', 'Running', 'Yoga', 'Cycling', 'Camping'] },
  { key: 'beauty', name: 'Beauty', subs: ['Skincare', 'Hair', 'Fragrance', 'Bath'] },
  { key: 'toys', name: 'Toys & Games', subs: ['Puzzles', 'Board games', 'Building sets'] },
  { key: 'pets', name: 'Pet Supplies', subs: ['Dog', 'Cat', 'Small pets'] },
];

export const BRANDS = ['Halden', 'Kestrel', 'Brightline', 'Mosswood', 'Tidewell', 'Trailhead', 'Corvo', 'Pellar', 'Nordvik', 'Aster', 'Northwind'];

/* ---------------------------------------------------------------- Official Store */

export const OFFICIAL_LOCATION = {
  code: 'RNO1',
  name: 'Reno fulfillment center',
  address: { name: 'Marketly Fulfillment', line1: '1250 Lear Blvd', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US', phone: '+17755550100' },
  timeZone: TZ,
  pickBins: ['A-01-1', 'A-01-2', 'A-01-3', 'A-02-1', 'A-02-2', 'A-02-3', 'B-01-1', 'B-01-2'],
};

/**
 * Products. `seller` is who creates the catalog product (official = Official Store via the admin API).
 * Each variant: key, options, color (photo tint), price, was (list price → verified was-price), stock, sku.
 */
export const PRODUCTS = [
  {
    key: 'aurora',
    seller: 'official',
    title: 'Halden Aurora ANC Wireless Headphones',
    brand: 'Halden',
    cat: 'electronics',
    sub: 'Headphones',
    shape: 'ring',
    model: 'HA-AUR26',
    weightGrams: 900,
    description:
      'Aurora is Halden’s full-size travel headphone. It blocks steady noise like engines and air conditioning, and the transparency mode lets announcements through without taking the headphones off. Controls are physical buttons, so they work with gloves.',
    features: [
      'Hybrid active noise cancelling with 6 microphones and an adjustable transparency mode',
      'Up to 40 hours with ANC on, 55 hours off. 10 minutes of charging gives 5 hours',
      'Bluetooth 5.3 multipoint: stay connected to a phone and a laptop at once',
      'Folds flat into the included hard travel case',
      'Wired listening with the 3.5 mm cable when the battery is empty',
    ],
    specs: {
      Model: 'Aurora (2026), HA-AUR26',
      Type: 'Over-ear, closed back',
      'Noise cancelling': 'Active, hybrid (6 microphones)',
      Battery: '40 h ANC on · 55 h ANC off',
      Charging: 'USB-C, 2 h full charge',
      Bluetooth: '5.3, multipoint (2 devices)',
      Codecs: 'SBC, AAC, LDAC',
      Wired: '3.5 mm (cable included)',
      Weight: '254 g (9 oz)',
      Warranty: '2-year manufacturer warranty, US',
    },
    included: ['Aurora headphones', 'Hard travel case', 'USB-C to USB-C cable, 1 m', '3.5 mm audio cable, 1.2 m', 'Airplane adapter', 'Quick start guide'],
    variants: [
      { key: 'black', options: { Color: 'Midnight black' }, color: '#2b2f36', price: 18900, was: 22900, stock: 142, sku: 'HAL-AUR-BLK' },
      { key: 'stone', options: { Color: 'Stone' }, color: '#b8ad9c', price: 18900, was: 22900, stock: 60, sku: 'HAL-AUR-STN' },
      { key: 'sage', options: { Color: 'Sage' }, color: '#8fa58a', price: 19900, was: 22900, stock: 40, sku: 'HAL-AUR-SGE' },
    ],
  },
  {
    key: 'auroraBuds',
    seller: 'official',
    title: 'Halden Aurora Buds ANC Earbuds',
    brand: 'Halden',
    cat: 'electronics',
    sub: 'Headphones',
    shape: 'circle',
    model: 'HA-AUB26',
    weightGrams: 200,
    description: 'True wireless earbuds with the same noise cancelling as Aurora, in a pocket-sized charging case. Each bud weighs five grams and the case adds three full charges.',
    features: ['Active noise cancelling with transparency mode', '8 hours per charge, 32 hours with the case', 'IPX4 sweat and splash resistant', 'Wireless charging case'],
    specs: { Type: 'In-ear, true wireless', Battery: '8 h buds · 32 h with case', Bluetooth: '5.3, multipoint', 'Water resistance': 'IPX4' },
    included: ['Earbuds', 'Charging case', 'Ear tips S/M/L', 'USB-C cable'],
    variants: [{ key: 'black', options: { Color: 'Midnight black' }, color: '#2b2f36', price: 13900, was: 16900, stock: 80, sku: 'HAL-AUB-BLK' }],
  },
  {
    key: 'studio2',
    seller: 'official',
    title: 'Halden Studio 2 Wired Monitor Headphones',
    brand: 'Halden',
    cat: 'electronics',
    sub: 'Headphones',
    shape: 'ring',
    model: 'HA-ST2',
    weightGrams: 700,
    description: 'Closed-back studio headphones for mixing and long editing sessions, with a flat response, replaceable velour pads and a detachable coiled cable.',
    features: ['Flat, neutral tuning for mixing', 'Detachable coiled and straight cables', 'Replaceable velour ear pads', 'Folds for travel'],
    specs: { Type: 'Over-ear, closed back', Impedance: '32 ohm', Cable: 'Detachable, 3 m coiled + 1.2 m straight' },
    included: ['Studio 2 headphones', 'Coiled cable', 'Straight cable', '6.35 mm adapter', 'Pouch'],
    variants: [{ key: 'black', options: { Color: 'Black' }, color: '#33363d', price: 14900, stock: 35, sku: 'HAL-ST2-BLK' }],
  },
  {
    key: 'lamp',
    seller: 'official',
    title: 'Brightline Smart LED Desk Lamp with Wireless Charger',
    brand: 'Brightline',
    cat: 'home',
    sub: 'Lighting',
    shape: 'diamond',
    model: 'BRL-W1',
    weightGrams: 1600,
    description: 'A compact desk lamp that charges your phone in its base. The touch strip on the arm controls brightness and color without the app, so it still works if your Wi-Fi is down.',
    features: [
      'Built-in 15 W Qi wireless charger in the base',
      'Five color temperatures from 2700 K to 6500 K, stepless dimming',
      'App and voice control with a manual touch strip that works offline',
      'Folding arm and head reach 45 cm over the desk from a 14 cm base',
      'Auto-off timer and a night mode at 3% brightness',
    ],
    specs: { Model: 'Smart Desk Lamp W1', Light: '8 W LED, 520 lumens, CRI 90+', 'Color temperature': '2700–6500 K', 'Charging pad': 'Qi, up to 15 W', Connectivity: 'Wi-Fi 2.4 GHz, Bluetooth for setup', Power: '24 W USB-C adapter (included)', Size: 'Base 14 cm, arm reach 45 cm', Warranty: '2 years, handled by the Official Store' },
    included: ['Lamp with charging base', '24 W USB-C power adapter', 'USB-C cable, 1.5 m', 'Quick start guide'],
    variants: [
      { key: 'white', options: { Color: 'White' }, color: '#d9d4c7', price: 4200, stock: 9, sku: 'BRL-LAMP-W' },
      { key: 'charcoal', options: { Color: 'Charcoal' }, color: '#4a4d52', price: 4200, stock: 30, sku: 'BRL-LAMP-C' },
    ],
  },
  {
    key: 'skillet',
    seller: 'official',
    title: 'Pellar Pre-seasoned Cast Iron Skillet 26 cm',
    brand: 'Pellar',
    cat: 'home',
    sub: 'Cookware',
    shape: 'circle',
    model: 'PLR-CI26',
    weightGrams: 2600,
    description: 'A 26 cm cast iron skillet seasoned with flaxseed oil and ready to cook on day one. Works on gas, electric, induction, in the oven and over a campfire.',
    features: ['Pre-seasoned with flaxseed oil', 'Works on induction, gas, electric and in the oven', 'Two pour spouts and a helper handle', 'Made to last generations'],
    specs: { Diameter: '26 cm', Material: 'Cast iron', Weight: '2.4 kg', 'Oven safe': 'Yes' },
    included: ['Skillet', 'Care guide'],
    variants: [{ key: '26', options: { Size: '26 cm' }, color: '#3d3a38', price: 5800, was: 7200, stock: 77, sku: 'PLR-CI26' }],
  },
  {
    key: 'sweater',
    seller: 'official',
    title: 'Nordvik Merino Wool Crew Sweater',
    brand: 'Nordvik',
    cat: 'fashion',
    sub: 'Knitwear',
    shape: 'square',
    model: 'NDV-MER',
    weightGrams: 450,
    description: 'A midweight crew neck in soft extra-fine merino. Warm without bulk, breathable and naturally odor resistant, so it works on its own or under a jacket.',
    features: ['100% extra-fine merino wool', 'Regular fit, ribbed cuffs and hem', 'Machine washable on wool cycle'],
    specs: { Material: '100% merino wool, 18.5 micron', Fit: 'Regular', Care: 'Machine wash cold, wool cycle' },
    included: ['Sweater'],
    variants: [
      { key: 'navy-m', options: { Color: 'Navy', Size: 'M' }, color: '#2d3a55', price: 8400, stock: 20, sku: 'NDV-MER-M-NVY' },
      { key: 'navy-l', options: { Color: 'Navy', Size: 'L' }, color: '#2d3a55', price: 8400, stock: 18, sku: 'NDV-MER-L-NVY' },
      { key: 'oat-m', options: { Color: 'Oat', Size: 'M' }, color: '#cbb994', price: 8400, stock: 14, sku: 'NDV-MER-M-OAT' },
    ],
  },
  {
    key: 'pourover',
    seller: 'official',
    title: 'Mosswood Ceramic Pour-over Coffee Set',
    brand: 'Mosswood',
    cat: 'home',
    sub: 'Coffee & tea',
    shape: 'diamond',
    model: 'MSW-PO',
    weightGrams: 1300,
    description: 'A hand-glazed ceramic dripper with a matching 600 ml carafe and two cups. The dripper takes standard number 2 cone filters and brews one to three cups.',
    features: ['Hand-glazed stoneware dripper and carafe', 'Fits standard #2 cone filters', 'Brews 1–3 cups', 'Dishwasher safe'],
    specs: { Capacity: '600 ml carafe', Material: 'Glazed stoneware', Filters: '#2 cone' },
    included: ['Dripper', 'Carafe', '2 cups', '40 paper filters'],
    variants: [
      { key: 'cream', options: { Color: 'Cream' }, color: '#e4d6bd', price: 3600, stock: 58, sku: 'MSW-PO-CRM' },
      { key: 'slate', options: { Color: 'Slate' }, color: '#5d6670', price: 3600, stock: 25, sku: 'MSW-PO-SLT' },
    ],
  },
  {
    key: 'serum',
    seller: 'official',
    title: 'Aster Daily Vitamin C Serum 30 ml',
    brand: 'Aster',
    cat: 'beauty',
    sub: 'Skincare',
    shape: 'circle',
    model: 'AST-VC30',
    weightGrams: 120,
    description: 'A lightweight daily serum with 15% vitamin C, vitamin E and ferulic acid that brightens uneven tone and layers under moisturizer and sunscreen.',
    features: ['15% L-ascorbic acid with vitamin E and ferulic acid', 'Fragrance free', 'Dropper bottle in amber glass'],
    specs: { Size: '30 ml', 'Skin type': 'All skin types', Fragrance: 'None' },
    included: ['Serum, 30 ml'],
    variants: [{ key: '30', options: { Size: '30 ml' }, color: '#e0a64a', price: 2400, was: 3000, stock: 140, sku: 'AST-VC30' }],
  },
  /* ------------------------------------------------ Northwind Audio */
  {
    key: 'speaker',
    seller: 'northwind',
    title: 'Halden Pocket Bluetooth Speaker',
    brand: 'Halden',
    cat: 'electronics',
    sub: 'Speakers',
    shape: 'square',
    model: 'HA-PKT',
    weightGrams: 450,
    description: 'A palm-sized speaker with surprisingly full sound, a strap for your bag and 16 hours of battery. Waterproof and dustproof, so it is fine at the beach or in the shower.',
    features: ['16 hours of playback', 'IP67 waterproof and dustproof', 'Pair two for stereo', 'Built-in strap'],
    specs: { Battery: '16 h', 'Water resistance': 'IP67', Bluetooth: '5.3' },
    included: ['Speaker', 'USB-C cable'],
    variants: [
      { key: 'teal', options: { Color: 'Teal' }, color: '#2a8c8c', price: 5900, was: 7900, stock: 88, sku: 'HAL-PKT-TEAL' },
      { key: 'black', options: { Color: 'Black' }, color: '#2b2f36', price: 5900, was: 7900, stock: 40, sku: 'HAL-PKT-BLK' },
    ],
  },
  {
    key: 'cablekit',
    seller: 'northwind',
    title: 'Northwind Studio Cable Kit, 3.5 mm to USB-C',
    brand: 'Northwind',
    cat: 'computers',
    sub: 'Accessories',
    shape: 'bar',
    model: 'NW-SCK',
    weightGrams: 150,
    description: 'Three braided audio cables for headphones and speakers: 3.5 mm to USB-C with a DAC, 3.5 mm to 3.5 mm, and a 6.35 mm adapter, in a zip pouch.',
    features: ['Braided cables with metal plugs', 'USB-C cable with a built-in DAC', 'Zip pouch included'],
    specs: { Length: '1.2 m each', Connectors: '3.5 mm, USB-C, 6.35 mm' },
    included: ['3 cables', 'Adapter', 'Pouch'],
    variants: [{ key: 'std', options: { Color: 'Graphite' }, color: '#55585e', price: 2400, stock: 60, sku: 'NW-SCK-GRP' }],
  },
  /* ------------------------------------------------ Pixel & Port */
  {
    key: 'kestrel27',
    seller: 'pixelport',
    title: 'Kestrel 27" 4K IPS Monitor, USB-C 65 W',
    brand: 'Kestrel',
    cat: 'computers',
    sub: 'Monitors',
    shape: 'square',
    model: 'KST-27UHD',
    weightGrams: 7800,
    description: 'A 27 inch 4K IPS monitor with 65 W USB-C charging, so one cable connects, charges and drives your laptop. Factory calibrated with a height-adjustable stand.',
    features: ['27" 3840 × 2160 IPS panel', 'USB-C with 65 W power delivery', 'Height, tilt and swivel stand', 'Factory calibrated, 99% sRGB'],
    specs: { Panel: '27" IPS, 3840 × 2160', 'Refresh rate': '60 Hz', Inputs: 'USB-C (65 W), HDMI 2.0, DisplayPort 1.4' },
    included: ['Monitor', 'Stand', 'USB-C cable', 'HDMI cable', 'Power cable'],
    variants: [{ key: 'std', options: { Color: 'Black' }, color: '#3a3f47', price: 32900, stock: 18, sku: 'KST-27UHD' }],
  },
  {
    key: 'ssd1tb',
    seller: 'pixelport',
    title: 'Kestrel 1 TB Portable SSD, USB 3.2',
    brand: 'Kestrel',
    cat: 'computers',
    sub: 'Storage',
    shape: 'square',
    model: 'KST-SSD1T',
    weightGrams: 120,
    description: 'A pocket-sized 1 TB SSD with read speeds up to 1,050 MB/s over USB 3.2. Drop resistant to two meters and works with Mac, Windows, iPad and Android.',
    features: ['Up to 1,050 MB/s read', 'USB-C, with USB-C and USB-A cables', 'Drop resistant to 2 m', 'Hardware encryption'],
    specs: { Capacity: '1 TB', Interface: 'USB 3.2 Gen 2', Read: 'Up to 1,050 MB/s' },
    included: ['SSD', 'USB-C to USB-C cable', 'USB-C to USB-A cable'],
    variants: [
      { key: 'gray', options: { Color: 'Space gray' }, color: '#5b6068', price: 9499, was: 11999, stock: 64, sku: 'KST-SSD1T-GRY' },
      { key: 'blue', options: { Color: 'Blue' }, color: '#3f6fb5', price: 9499, was: 11999, stock: 30, sku: 'KST-SSD1T-BLU' },
    ],
  },
  {
    key: 'keyboard',
    seller: 'pixelport',
    title: 'Kestrel K75 Wireless Mechanical Keyboard',
    brand: 'Kestrel',
    cat: 'computers',
    sub: 'Keyboards',
    shape: 'bar',
    model: 'KST-K75',
    weightGrams: 900,
    description: 'A compact 75% mechanical keyboard with hot-swappable switches, a volume knob and three Bluetooth channels plus a 2.4 GHz dongle.',
    features: ['75% layout with a volume knob', 'Hot-swappable tactile switches', 'Bluetooth (3 devices) and 2.4 GHz', 'Up to 200 hours of battery'],
    specs: { Layout: '75% ANSI', Switches: 'Tactile, hot-swappable', Connectivity: 'Bluetooth 5.1, 2.4 GHz, USB-C' },
    included: ['Keyboard', 'USB-C cable', '2.4 GHz receiver', 'Keycap puller'],
    variants: [{ key: 'gray', options: { Color: 'Gray' }, color: '#8a8f96', price: 10900, stock: 35, sku: 'KST-K75-GRY' }],
  },
  /* ------------------------------------------------ Casa Verde Home */
  {
    key: 'duvet',
    seller: 'casaverde',
    title: 'Mosswood Washed Linen Duvet Cover, Queen',
    brand: 'Mosswood',
    cat: 'home',
    sub: 'Bedding',
    shape: 'square',
    model: 'MSW-LIN-Q',
    weightGrams: 1500,
    description: 'Stonewashed European flax linen that is soft from the first night and gets softer with every wash. Queen size with a hidden button closure and corner ties.',
    features: ['100% European flax linen, stonewashed', 'Hidden coconut button closure', 'Corner ties keep the duvet in place', 'OEKO-TEX certified'],
    specs: { Size: 'Queen, 90 × 92 in', Material: '100% linen', Care: 'Machine wash warm, tumble dry low' },
    included: ['Duvet cover'],
    variants: [
      { key: 'sage', options: { Size: 'Queen', Color: 'Sage' }, color: '#97ab8f', price: 11900, was: 14900, stock: 31, sku: 'MSW-LIN-Q-SAGE' },
      { key: 'oat', options: { Size: 'Queen', Color: 'Oat' }, color: '#d8ccb4', price: 11900, was: 14900, stock: 22, sku: 'MSW-LIN-Q-OAT' },
    ],
  },
  {
    key: 'kettle',
    seller: 'casaverde',
    title: 'Mosswood Gooseneck Pour-over Kettle',
    brand: 'Mosswood',
    cat: 'home',
    sub: 'Coffee & tea',
    shape: 'diamond',
    model: 'MSW-GK',
    weightGrams: 1200,
    description: 'An electric gooseneck kettle with a precise pour spout and a temperature dial from 40 to 100 °C. Holds the temperature for an hour.',
    features: ['Temperature control 40–100 °C', 'Keep-warm for 60 minutes', 'Precision gooseneck spout', '0.9 l capacity'],
    specs: { Capacity: '0.9 l', Power: '1200 W', Material: 'Stainless steel' },
    included: ['Kettle', 'Base'],
    variants: [{ key: 'matte', options: { Color: 'Matte black' }, color: '#2f3135', price: 4800, was: 6000, stock: 25, sku: 'MSW-GK-BLK' }],
  },
  {
    key: 'sheets',
    seller: 'casaverde',
    title: 'Mosswood Percale Sheet Set, Queen',
    brand: 'Mosswood',
    cat: 'home',
    sub: 'Bedding',
    shape: 'square',
    model: 'MSW-PC-Q',
    weightGrams: 1800,
    description: 'Crisp, cool organic cotton percale in a queen set with deep pockets that fit mattresses up to 40 cm. Breathable for warm sleepers.',
    features: ['Organic cotton percale', 'Deep pockets up to 40 cm', 'Fitted sheet, flat sheet and two pillowcases'],
    specs: { Size: 'Queen', Material: '100% organic cotton percale' },
    included: ['Fitted sheet', 'Flat sheet', '2 pillowcases'],
    variants: [{ key: 'white', options: { Size: 'Queen', Color: 'White' }, color: '#e9e6df', price: 7900, was: 9900, stock: 40, sku: 'MSW-PC-Q-WHT' }],
  },
  /* ------------------------------------------------ Trailhead Outfitters */
  {
    key: 'bottle',
    seller: 'trailhead',
    title: 'Tidewell Insulated Bottle 750 ml',
    brand: 'Tidewell',
    cat: 'sports',
    sub: 'Hiking',
    shape: 'bar',
    model: 'TDW-750',
    weightGrams: 450,
    description: 'A double-wall vacuum insulated steel bottle that keeps drinks cold for a full day and hot for twelve hours, with a leakproof loop cap.',
    features: ['Cold 24 h, hot 12 h', 'Leakproof loop cap', 'Fits most cup holders', 'Dishwasher safe'],
    specs: { Capacity: '750 ml', Material: '18/8 stainless steel' },
    included: ['Bottle', 'Loop cap'],
    variants: [
      { key: 'slate', options: { Color: 'Slate' }, color: '#5f6b77', price: 2950, stock: 220, sku: 'TDW-750-SLT' },
      { key: 'sage', options: { Color: 'Sage' }, color: '#8fa58a', price: 2950, stock: 90, sku: 'TDW-750-SGE' },
    ],
  },
  {
    key: 'backpack',
    seller: 'trailhead',
    title: 'Trailhead Ridge 40 L Hiking Backpack',
    brand: 'Trailhead',
    cat: 'sports',
    sub: 'Hiking',
    shape: 'square',
    model: 'TRH-R40',
    weightGrams: 1500,
    description: 'A 40 liter pack for overnights and long day hikes, with an adjustable back panel, a ventilated frame and a rain cover in the lid.',
    features: ['Adjustable torso length', 'Ventilated mesh back panel', 'Integrated rain cover', 'Hydration sleeve'],
    specs: { Volume: '40 l', Weight: '1.3 kg', Material: 'Recycled ripstop nylon' },
    included: ['Backpack', 'Rain cover'],
    variants: [{ key: 'olive', options: { Color: 'Olive' }, color: '#6b7346', price: 13900, was: 16500, stock: 26, sku: 'TRH-R40-OLV' }],
  },
  {
    key: 'shoes',
    seller: 'trailhead',
    title: 'Corvo Swift Trail Running Shoes',
    brand: 'Corvo',
    cat: 'fashion',
    sub: 'Shoes',
    shape: 'diamond',
    model: 'CRV-SWF',
    weightGrams: 800,
    description: 'Light trail runners with a grippy lugged outsole, a rock plate and a breathable mesh upper that drains fast after stream crossings.',
    features: ['Lugged outsole for loose ground', 'Rock plate under the forefoot', 'Quick-draining mesh upper'],
    specs: { Drop: '6 mm', Weight: '280 g (size 10)' },
    included: ['Pair of shoes'],
    variants: [
      { key: '9', options: { Size: '9' }, color: '#c4572f', price: 11200, stock: 12, sku: 'CRV-SWF-9' },
      { key: '10', options: { Size: '10' }, color: '#c4572f', price: 11200, stock: 16, sku: 'CRV-SWF-10' },
      { key: '11', options: { Size: '11' }, color: '#c4572f', price: 11200, stock: 12, sku: 'CRV-SWF-11' },
    ],
  },
  {
    key: 'yogamat',
    seller: 'trailhead',
    title: 'Corvo Grip Yoga Mat 6 mm',
    brand: 'Corvo',
    cat: 'sports',
    sub: 'Yoga',
    shape: 'bar',
    model: 'CRV-YM6',
    weightGrams: 1600,
    description: 'A 6 mm natural rubber mat with a polyurethane top that grips even when you sweat, cushioned enough for knees and light enough to carry to class.',
    features: ['Natural rubber base, PU top layer', '6 mm cushioning', 'Alignment lines', 'Carry strap included'],
    specs: { Size: '183 × 68 cm', Thickness: '6 mm' },
    included: ['Mat', 'Carry strap'],
    variants: [
      { key: 'sage', options: { Color: 'Sage' }, color: '#8fa58a', price: 4500, stock: 50, sku: 'CRV-YM6-SAGE' },
      { key: 'plum', options: { Color: 'Plum' }, color: '#7a4e6e', price: 4500, stock: 20, sku: 'CRV-YM6-PLUM' },
    ],
  },
  /* ------------------------------------------------ Gadget Grove */
  {
    key: 'vacuum',
    seller: 'gadgetgrove',
    title: 'Brightline S2 Robot Vacuum with Mapping',
    brand: 'Brightline',
    cat: 'home',
    sub: 'Cleaning',
    shape: 'circle',
    model: 'BRL-S2',
    weightGrams: 4200,
    description: 'A robot vacuum with lidar mapping, room-by-room cleaning and no-go zones in the app. Runs for two hours and returns to its dock to recharge.',
    features: ['Lidar mapping with multi-floor maps', '2,700 Pa suction', 'Up to 120 minutes per charge', 'No-go zones and room scheduling'],
    specs: { Runtime: '120 min', Suction: '2,700 Pa', Navigation: 'Lidar' },
    included: ['Robot', 'Charging dock', 'Side brushes', 'Spare filter'],
    variants: [{ key: 'white', options: { Color: 'White' }, color: '#cfd3d6', price: 27900, was: 34900, stock: 6, sku: 'BRL-S2' }],
  },
];

/** Offers by other sellers on products created by someone else (product page "other offers") */
export const EXTRA_OFFERS = [
  { key: 'aurora-black-northwind', seller: 'northwind', product: 'aurora', variant: 'black', condition: 'new', price: 18400, stock: 23, sku: 'NW-HAL-AUR-BLK' },
  { key: 'aurora-stone-northwind', seller: 'northwind', product: 'aurora', variant: 'stone', condition: 'new', price: 18400, stock: 14, sku: 'NW-HAL-AUR-STN' },
  { key: 'aurora-black-pixelport', seller: 'pixelport', product: 'aurora', variant: 'black', condition: 'used_like_new', conditionNotes: 'Opened box, all accessories included, no visible wear.', price: 14900, stock: 2, sku: 'PP-HAL-AUR-LN', warranty: { kind: 'seller', months: 3 } },
  { key: 'aurora-black-gadgetgrove', seller: 'gadgetgrove', product: 'aurora', variant: 'black', condition: 'refurbished', conditionNotes: 'Replacement ear cushions. Carry case not included.', missingItems: ['Hard travel case'], price: 12900, stock: 5, sku: 'GG-HAL-AUR-RF', warranty: { kind: 'seller', months: 6 } },
  { key: 'pourover-cream-casaverde', seller: 'casaverde', product: 'pourover', variant: 'cream', condition: 'new', price: 3800, stock: 12, sku: 'CV-MSW-PO-CRM' },
  { key: 'skillet-casaverde', seller: 'casaverde', product: 'skillet', variant: '26', condition: 'new', price: 6100, stock: 10, sku: 'CV-PLR-CI26' },
  { key: 'ssd-gray-northwind', seller: 'northwind', product: 'ssd1tb', variant: 'gray', condition: 'new', price: 9900, stock: 8, sku: 'NW-KST-SSD1T' },
];

/* ---------------------------------------------------------------- sellers */

const usdTiers = (cents) => [{ upToGrams: 20000, price: usd(cents) }];

export const SELLERS = [
  {
    key: 'northwind',
    storeName: 'Northwind Audio',
    owner: { first: 'Hannah', last: 'Brooks', email: 'hannah@northwindaudio.example.com', phone: '+15035550121' },
    address: { line1: '410 SE Grand Ave', city: 'Portland', region: 'OR', postalCode: '97214' },
    state: 'OR',
    shipsFrom: 'Portland, OR',
    account: '000123457731',
    taxId: '93-4812001',
    categories: ['electronics', 'computers'],
    tagline: 'Headphones and speakers, tested in Portland',
    introduction: 'Northwind Audio is a small Portland team selling headphones, speakers and cables we use ourselves. Every unit is a US retail unit with the full manufacturer warranty, and we answer questions within a day.',
    warranty: 'US retail units with the full manufacturer warranty.',
    shipping: { standard: usdTiers(699), expedited: 1499, freeOver: null, handlingDays: 1 },
  },
  {
    key: 'pixelport',
    storeName: 'Pixel & Port',
    owner: { first: 'Marcus', last: 'Chen', email: 'marcus@pixelandport.example.com', phone: '+15125550132' },
    address: { line1: '1100 E 5th St', city: 'Austin', region: 'TX', postalCode: '78702' },
    state: 'TX',
    shipsFrom: 'Austin, TX',
    account: '000223457741',
    taxId: '74-2391001',
    categories: ['computers', 'electronics'],
    tagline: 'Monitors, storage and desk gear',
    introduction: 'Pixel & Port sells monitors, storage and keyboards for home offices and studios. We also sell carefully checked open-box items with honest condition notes.',
    warranty: 'Manufacturer warranty on new items; 90-day seller warranty on open-box items.',
    shipping: { standard: usdTiers(599), expedited: 1499, freeOver: 4900, handlingDays: 2 },
  },
  {
    key: 'casaverde',
    storeName: 'Casa Verde Home',
    owner: { first: 'Lucia', last: 'Romero', email: 'lucia@casaverdehome.example.com', phone: '+19165550143' },
    address: { line1: '1801 L St', city: 'Sacramento', region: 'CA', postalCode: '95811' },
    state: 'CA',
    shipsFrom: 'Sacramento, CA',
    account: '000323457751',
    taxId: '68-1730001',
    categories: ['home'],
    tagline: 'Linen, cookware and slow mornings',
    introduction: 'Casa Verde Home is a Sacramento shop for linen bedding, cookware and coffee gear. We pack every order by hand with recycled materials.',
    warranty: 'Defects covered for one year from delivery.',
    shipping: { standard: usdTiers(699), expedited: 1599, freeOver: 7500, handlingDays: 2 },
  },
  {
    key: 'trailhead',
    storeName: 'Trailhead Outfitters',
    owner: { first: 'Owen', last: 'Walsh', email: 'owen@trailheadoutfitters.example.com', phone: '+13035550154' },
    address: { line1: '1600 Pearl St', city: 'Boulder', region: 'CO', postalCode: '80302' },
    state: 'CO',
    shipsFrom: 'Boulder, CO',
    account: '000423457761',
    taxId: '84-9800001',
    categories: ['sports', 'fashion'],
    tagline: 'Gear for the trail, from Boulder',
    introduction: 'Trailhead Outfitters is a Boulder outdoor shop with packs, bottles, trail shoes and yoga gear. Our staff field-test what we sell.',
    warranty: 'Manufacturer warranty; our own one-year guarantee on Trailhead packs.',
    shipping: { standard: usdTiers(599), expedited: 1499, freeOver: 5000, handlingDays: 1 },
  },
  {
    key: 'gadgetgrove',
    storeName: 'Gadget Grove',
    owner: { first: 'Ravi', last: 'Mehta', email: 'ravi@gadgetgrove.example.com', phone: '+16025550165' },
    address: { line1: '2 N Central Ave', city: 'Phoenix', region: 'AZ', postalCode: '85004' },
    state: 'AZ',
    shipsFrom: 'Phoenix, AZ',
    account: '000523457771',
    taxId: '86-4120001',
    categories: ['home', 'electronics'],
    tagline: 'Refurbished and smart home tech',
    introduction: 'Gadget Grove sells robot vacuums, smart home devices and refurbished electronics from Phoenix, each tested before it ships.',
    warranty: 'Six-month seller warranty on refurbished items.',
    shipping: { standard: usdTiers(499), expedited: 1499, freeOver: 20000, handlingDays: 3 },
  },
];

/* ---------------------------------------------------------------- customers */

export const CUSTOMERS = [
  {
    key: 'jordan',
    first: 'Jordan',
    last: 'Lee',
    email: 'jordan.lee@example.com',
    phone: '+15035550148',
    marketing: { emailPromotions: true, smsPromotions: false, pushPromotions: true, personalizedRecommendations: true, recentSearches: true },
    addresses: [
      { key: 'home', label: 'Home', address: { name: 'Jordan Lee', line1: '2140 Alder St', line2: 'Apt 5', city: 'Portland', region: 'OR', postalCode: '97205', country: 'US', phone: '+15035550148' }, makeDefault: true },
      { key: 'work', label: 'Work', address: { name: 'Jordan Lee', line1: '815 SW 2nd Ave', line2: 'Floor 4', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550199' }, makeDefault: false },
    ],
  },
  { key: 'mara', first: 'Mara', last: 'Diaz', email: 'mara.diaz@example.com', phone: '+15035550161', addresses: [{ key: 'home', label: 'Home', address: { name: 'Mara Diaz', line1: '3520 SE Hawthorne Blvd', city: 'Portland', region: 'OR', postalCode: '97214', country: 'US', phone: '+15035550161' }, makeDefault: true }] },
  { key: 'devon', first: 'Devon', last: 'Price', email: 'devon.price@example.com', phone: '+15035550162', addresses: [{ key: 'home', label: 'Home', address: { name: 'Devon Price', line1: '4038 N Mississippi Ave', city: 'Portland', region: 'OR', postalCode: '97227', country: 'US', phone: '+15035550162' }, makeDefault: true }] },
  { key: 'ines', first: 'Ines', last: 'Keller', email: 'ines.keller@example.com', phone: '+15035550163', addresses: [{ key: 'home', label: 'Home', address: { name: 'Ines Keller', line1: '1640 NE Alberta St', city: 'Portland', region: 'OR', postalCode: '97211', country: 'US', phone: '+15035550163' }, makeDefault: true }] },
  { key: 'priya', first: 'Priya', last: 'Kapoor', email: 'priya.kapoor@example.com', phone: '+15035550164', addresses: [{ key: 'home', label: 'Home', address: { name: 'Priya Kapoor', line1: '2315 NW Thurman St', city: 'Portland', region: 'OR', postalCode: '97210', country: 'US', phone: '+15035550164' }, makeDefault: true }] },
  { key: 'sam', first: 'Sam', last: 'Rivera', email: 'sam.rivera@example.com', phone: '+15035550165', addresses: [{ key: 'home', label: 'Home', address: { name: 'Sam Rivera', line1: '1305 SE Stark St', city: 'Portland', region: 'OR', postalCode: '97214', country: 'US', phone: '+15035550165' }, makeDefault: true }] },
];

/* ---------------------------------------------------------------- orders */

/**
 * Orders to place. lines: [offerKey, quantity]; offer keys are "<product>.<variant>" for the creator's offer, or
 * an EXTRA_OFFERS key. plan per seller package: deliver | ship (in transit) | prepare | delay | none.
 * after: extra actions (return_refund, return_request, cancel_all, cancel_item).
 */
export const ORDERS = [
  {
    key: 'jordan-multi',
    customer: 'jordan',
    address: 'home',
    coupon: 'WELCOME20',
    lines: [['aurora.black', 1], ['pourover.cream', 1], ['ssd1tb.gray', 2], ['duvet.sage', 1]],
    plan: { official: 'deliver', pixelport: { do: 'ship', carrier: 'usps', service: 'USPS Priority Mail' }, casaverde: 'delay' },
    after: [{ do: 'return_request', item: 'pourover.cream', reason: 'changed_mind', details: 'The cream glaze looks more yellow than in the photos. I would like to send it back unused.' }],
  },
  { key: 'jordan-preparing', customer: 'jordan', address: 'home', lines: [['bottle.slate', 1], ['yogamat.sage', 1]], plan: { trailhead: 'prepare' } },
  { key: 'jordan-skillet', customer: 'jordan', address: 'home', lines: [['skillet.26', 1]], plan: { official: 'deliver' } },
  {
    key: 'jordan-backpack',
    customer: 'jordan',
    address: 'work',
    lines: [['backpack.olive', 1]],
    plan: { trailhead: 'deliver' },
    after: [{ do: 'return_refund', item: 'backpack.olive', reason: 'wrong_size', details: 'The torso length is too long for me even at the shortest setting. Unused, with the tags on.' }],
  },
  { key: 'jordan-shoes', customer: 'jordan', address: 'home', lines: [['shoes.10', 1]], plan: { trailhead: 'none' }, after: [{ do: 'cancel_all', reason: 'ordered_by_mistake', note: 'Ordered the wrong size' }] },
  { key: 'jordan-speaker', customer: 'jordan', address: 'home', lines: [['speaker.teal', 1], ['cablekit.std', 1]], plan: { northwind: 'deliver' }, before: [{ do: 'cancel_item', item: 'cablekit.std', reason: 'out_of_stock', note: 'Last cable kit failed our check before packing' }] },
  { key: 'jordan-monitor', customer: 'jordan', address: 'work', lines: [['kestrel27.std', 1]], plan: { pixelport: { do: 'ship', carrier: 'ups', service: 'UPS Ground' } } },
  { key: 'mara-aurora', customer: 'mara', address: 'home', lines: [['aurora.black', 1]], plan: { official: 'deliver' } },
  { key: 'devon-aurora', customer: 'devon', address: 'home', lines: [['aurora-stone-northwind', 1]], plan: { northwind: 'deliver' } },
  { key: 'ines-aurora', customer: 'ines', address: 'home', lines: [['aurora.black', 1]], plan: { official: 'deliver' } },
  { key: 'priya-aurora', customer: 'priya', address: 'home', lines: [['aurora-black-northwind', 1], ['lamp.white', 1]], plan: { northwind: 'deliver', official: 'prepare' } },
  { key: 'sam-speakers', customer: 'sam', address: 'home', lines: [['speaker.black', 2]], plan: { northwind: 'none' } },
  { key: 'sam-duvet', customer: 'sam', address: 'home', lines: [['duvet.oat', 1], ['sheets.white', 1]], plan: { casaverde: { do: 'ship', carrier: 'fedex', service: 'FedEx Ground' } } },
];

/* ---------------------------------------------------------------- reviews and questions */

// Texts: at least 50 characters, no links, emails or runs of digits (the auto-hold checks).
export const REVIEWS = [
  { order: 'mara-aurora', item: 'aurora.black', rating: 5, headline: 'Quiet enough for a six-hour flight', text: 'Wore them from Portland to New York and back. The engine noise drops to a low hum, and I still had plenty of battery at the end. Clamping is firm for the first week.' },
  { order: 'devon-aurora', item: 'aurora-stone-northwind', rating: 4, headline: 'Great noise cancelling, bulky case', text: 'Sound and noise cancelling are excellent for the price. The case takes up half my backpack. Multipoint between my phone and work laptop works without pairing again.', reply: 'Thanks for the honest review, Devon! A slimmer soft pouch is on its way to our store next month if the hard case is too big for daily use.' },
  { order: 'ines-aurora', item: 'aurora.black', rating: 2, headline: 'Left ear cup crackles at high volume', text: 'Started after two weeks of daily use, and only when the volume is near the top. Otherwise they are comfortable and the noise cancelling works well on the bus.', official: 'Sorry about this. It is covered by the two-year warranty and by our thirty-day return window. Start a return from your order and choose “Item is faulty” for a free replacement.' },
  { order: 'priya-aurora', item: 'aurora-black-northwind', rating: 5, headline: 'Comfortable all day at my desk', text: 'I wear these through a full workday of calls. The microphones are clear, my colleagues say I sound like I am in a quiet room, and the transparency mode is natural.' },
  { order: 'jordan-skillet', item: 'skillet.26', rating: 5, headline: 'Seasoning holds up from day one', text: 'Fried eggs on the first morning without sticking. It is heavy, as expected, but the helper handle makes it easy to move from the stove to the oven.' },
  { order: 'jordan-speaker', item: 'speaker.teal', rating: 4, headline: 'Big sound from a tiny speaker', text: 'Took it camping and to the beach. It survived sand and a dunk in the lake, and the strap is handy. Bass is thin at full volume, which is fair for the size.', reply: 'Glad it survived the lake, Jordan! For more bass, pair two speakers in stereo mode from the app.' },
];

export const FEEDBACK = [
  { order: 'devon-aurora', seller: 'northwind', asDescribed: true, dispatchRating: 5, communicationRating: 5, comment: 'Shipped the same day and arrived well packed.', reply: 'Thank you, Devon. Enjoy the quiet!' },
  { order: 'priya-aurora', seller: 'northwind', asDescribed: true, dispatchRating: 5, communicationRating: 4, comment: 'Exactly as described, quick delivery.' },
  { order: 'jordan-speaker', seller: 'northwind', asDescribed: true, dispatchRating: 4, communicationRating: 5, comment: 'They told me right away the cable kit was out of stock and refunded it.' },
];

export const QUESTIONS = [
  { key: 'aurora-multipoint', product: 'aurora', asker: 'mara', text: 'Can I connect it to my phone and laptop at the same time?', answers: [{ by: 'staff', text: 'Yes. Aurora supports Bluetooth multipoint with two devices. Audio switches to whichever device starts playing.' }] },
  { key: 'aurora-warranty', product: 'aurora', asker: 'sam', text: 'Is the Northwind Audio offer a US unit with the US warranty?', answers: [{ by: 'seller:northwind', text: 'Yes. We sell US retail units bought from Halden’s US distributor. The two-year warranty is registered in your name with Halden US.' }] },
  {
    key: 'aurora-cushions',
    product: 'aurora',
    asker: 'devon',
    text: 'Can the ear cushions be replaced?',
    answers: [
      { by: 'customer:priya', text: 'Yes, they clip off. I bought a replacement pair from Halden and swapping them took a minute.' },
      { by: 'staff', text: 'Replacement cushions are sold by the Official Store under the Halden Aurora accessories.' },
    ],
  },
  { key: 'lamp-case', product: 'lamp', asker: 'priya', text: 'Will the charging pad work through a phone case?', answers: [{ by: 'staff', text: 'Yes, through cases up to 5 mm thick without metal or magnets.' }] },
  { key: 'lamp-app', product: 'lamp', asker: 'jordan', text: 'Does it need the app to change brightness?', answers: [] },
  { key: 'speaker-stereo', product: 'speaker', asker: 'priya', text: 'Can two of these speakers play in stereo together?', answers: [{ by: 'seller:northwind', text: 'Yes. Hold the pair buttons on both speakers for three seconds and they link as left and right channels.' }] },
];

/* ---------------------------------------------------------------- content */

export const PROMISE_ITEMS = [
  { icon: 'calendar-check', title: 'Delivery date first', body: 'See arrival dates and the full total before you pay.' },
  { icon: 'undo-2', title: '30-day returns', body: 'Every seller accepts returns for at least 30 days after delivery.' },
  { icon: 'shield-check', title: 'Checked sellers', body: 'We verify each seller’s business, owner, bank account and return address.' },
  { icon: 'headset', title: 'We step in', body: 'If a seller doesn’t answer within 2 business days, Marketly helps.' },
];

export const HELP_CATEGORIES = [
  { key: 'shopping', name: 'Shopping', icon: 'shopping-bag', description: 'Offers, sellers, product questions', audience: 'customer' },
  { key: 'delivery', name: 'Delivery', icon: 'truck', description: 'Estimates, tracking, late packages', audience: 'customer' },
  { key: 'payment', name: 'Payment', icon: 'credit-card', description: 'Methods, failed or pending payments', audience: 'customer' },
  { key: 'cancellations', name: 'Cancellations', icon: 'circle-x', description: 'Cancel items before they ship', audience: 'customer' },
  { key: 'returns', name: 'Returns', icon: 'undo-2', description: 'Windows, labels, who pays shipping', audience: 'customer' },
  { key: 'refunds', name: 'Refunds', icon: 'banknote', description: 'Refund timing and status', audience: 'customer' },
  { key: 'account', name: 'Account', icon: 'user-round', description: 'Sign-in, security, addresses', audience: 'customer' },
  { key: 'selling', name: 'Selling on Marketly', icon: 'store', description: 'Listings, product review and launch', audience: 'seller' },
  { key: 'payouts', name: 'Payouts', icon: 'landmark', description: 'Payout schedule, holds and bank accounts', audience: 'seller' },
];

export const HELP_ARTICLES = [
  {
    key: 'return-seller-item',
    category: 'returns',
    title: 'Returning an item bought from a marketplace seller',
    summary: 'How returns to outside sellers work, who pays shipping and when Marketly steps in.',
    featured: true,
    popularSearch: 'Return an item',
    body: `<p>Items sold by outside sellers on Marketly are returned to that seller, not to our warehouse. The seller's return terms are shown on the product page and in your order. Every seller must accept returns for at least 30 days after delivery, and many offer longer.</p>
<h2>How to return an item</h2>
<ol><li>Go to Orders and open the order.</li><li>Choose <b>Return items</b> next to the package, then select the item and quantity.</li><li>Pick a reason and add photos if the item is damaged, defective or not as described.</li><li>Check the summary: return deadline, where it goes, who pays shipping and your refund amount.</li><li>Submit. The seller approves, asks for details or explains a rejection within 2 business days.</li><li>Pack the item and drop it off with the label or instructions you receive. Track the return on your order page.</li></ol>
<h2>Who pays return shipping</h2>
<table><thead><tr><th>Reason for return</th><th>Who pays return shipping</th><th>Shipping refunded</th></tr></thead><tbody><tr><td>Damaged in delivery</td><td>Seller · prepaid label</td><td>Yes</td></tr><tr><td>Incorrect item sent</td><td>Seller · prepaid label</td><td>Yes</td></tr><tr><td>Defective or not working</td><td>Seller · prepaid label</td><td>Yes</td></tr><tr><td>Changed my mind</td><td>You, unless the seller offers free returns</td><td>No</td></tr></tbody></table>
<p>Official Store items always have free return shipping. Some categories have exceptions, such as opened bedding or personal care items. See the Returns policy.</p>
<h2>When Marketly steps in</h2>
<ul><li>The seller hasn't replied to your return request within 2 business days.</li><li>The seller rejected the return and you don't agree with the reason.</li><li>Your refund hasn't been sent within 3 business days after the seller received the item.</li></ul>
<p>Choose <b>Ask Marketly to help</b> on the return. Our team reviews the purchase terms, tracking, photos and messages, then makes a decision. You can appeal a decision within 14 days.</p>`,
    policyKeys: ['returns'],
  },
  {
    key: 'late-package',
    category: 'delivery',
    title: 'My package is late. What can I do?',
    summary: 'What to check first, and when you can cancel for a full refund.',
    popularSearch: 'Late package',
    body: `<p>Each package shows its own delivery estimate on the order page. Estimates combine the seller's dispatch time and the carrier's transit time to your ZIP code.</p>
<h2>What to check first</h2><ul><li>Open the order and check the tracking for that package.</li><li>If the seller reported a delay, the new dispatch date is shown on the package.</li></ul>
<h2>What you can do</h2><ul><li>Report the problem from the order page. The seller responds first; Marketly steps in after 2 business days.</li><li>If an item doesn't ship within 14 days of its estimate, you can cancel it for a full refund.</li></ul>`,
    policyKeys: ['shipping'],
  },
  {
    key: 'several-packages',
    category: 'delivery',
    title: 'Why did my order arrive in several packages?',
    summary: 'One order can have one package per seller or ship-from location.',
    body: `<p>One order can contain items from the Official Store and from several marketplace sellers. Each seller ships its own items, so you get one package per seller or ship-from location, each with its own tracking and delivery estimate.</p><p>Shipping costs are shown per package at checkout. Returns and cancellations work per item, so a problem with one package never affects the others.</p>`,
  },
  {
    key: 'payment-pending',
    category: 'payment',
    title: 'My payment is pending. Was I charged?',
    summary: 'What a pending payment means and why you are never charged twice.',
    popularSearch: 'Payment pending',
    body: `<p>Sometimes the bank doesn't answer right away. While the result is uncertain, your order shows <b>Payment pending</b> and we don't charge you twice if you try again.</p><ul><li>Most pending payments resolve within a few minutes.</li><li>If the payment fails, any hold on your card is released by your bank, usually within 3–5 business days.</li><li>An order is accepted only when the payment is accepted. We email a confirmation only then.</li></ul>`,
    policyKeys: ['purchase_terms'],
  },
  {
    key: 'refund-timing',
    category: 'refunds',
    title: 'How long do refunds take to reach my card?',
    summary: 'Refund steps from Requested to Sent, and bank processing times.',
    body: `<p>Refunds go back to your original payment method. You see each step on the return or cancellation: Requested, Under review, Approved, Processing, Sent.</p><ul><li>Approved doesn't mean the money has arrived. Banks take 3–5 business days after we send it.</li><li>Partial returns refund only the returned items and their share of any discount.</li></ul>`,
    policyKeys: ['returns'],
  },
  {
    key: 'official-verified',
    category: 'shopping',
    title: 'What do Official Store and Verified seller mean?',
    summary: 'The labels on offers and what we check before a seller can sell.',
    body: `<p><b>Official Store</b> items are sold and shipped by Marketly. We own the stock and handle service. It isn't a ranking: other sellers may offer a better price.</p><p><b>Verified seller</b> means we checked the business registration, owner identity, payout account and return address. We don't inspect every product a seller sends.</p><p><b>Sponsored</b> means a seller or brand paid for the position. It's always labelled and doesn't change the price.</p>`,
    policyKeys: ['seller_rules'],
  },
  {
    key: 'cancel-before-ship',
    category: 'cancellations',
    title: 'Cancel items before they ship',
    summary: 'Cancelling one item never cancels the rest of the order.',
    body: `<p>You can cancel an item until its seller ships it. Open the order, choose <b>Cancel items</b> and select what to cancel. Items that are already being packed may need the seller to confirm.</p><p>Cancelling one item doesn't cancel the rest of the order. The refund for a cancelled item, including its share of any discount, goes back to your payment method.</p>`,
    policyKeys: ['purchase_terms'],
  },
  {
    key: 'account-security',
    category: 'account',
    title: 'Keep your account secure',
    summary: 'Passwords, 2-step verification and signed-in devices.',
    body: `<p>Use a password you don't use anywhere else and turn on 2-step verification in Security. You can see every device signed in to your account and sign out the ones you don't recognize.</p><p>Marketly never asks for your password or a verification code by phone or email.</p>`,
  },
  {
    key: 'seller-launch-review',
    category: 'selling',
    audience: 'seller',
    title: 'Fix a rejected or changes-requested product',
    summary: 'What the review notes mean and how to resubmit.',
    featured: true,
    popularSearch: 'Changes requested',
    body: `<p>Every new product is reviewed before it goes live. When we ask for changes, the product page in Seller Center lists each issue with the field it refers to.</p><ol><li>Open the product from Products → Changes requested.</li><li>Fix each listed issue: photos, title, key features or variant details.</li><li>Submit again. Most resubmissions are reviewed within one business day.</li></ol><p>Your offers on the product publish automatically once it is approved.</p>`,
  },
  {
    key: 'seller-payout-schedule',
    category: 'payouts',
    audience: 'seller',
    title: 'Payout schedule and holds',
    summary: 'When sales proceeds become available and how payouts are sent.',
    popularSearch: 'Payout schedule',
    body: `<p>Proceeds from a sale stay pending until the item is delivered and the hold period passes. Then they become available and are included in the next weekly payout to your verified bank account.</p><ul><li>New sellers may have a longer hold for their first orders.</li><li>Changing your payout account pauses payouts for 72 hours while we verify the change.</li></ul>`,
  },
];

const h = (s) => s.trim().replace(/\n\s*/g, '');
export const POLICIES = [
  {
    key: 'returns',
    kind: 'returns',
    title: 'Returns policy',
    audience: 'customer',
    body: h(`
      <p>Every item on Marketly can be returned for at least 30 days after delivery unless a category exception below applies. Sellers can offer longer or free returns; their terms are shown on the product page before you buy.</p>
      <h2>Return window</h2><ul><li>30 days from delivery for most items.</li><li>Official Store items: 30 days, free return shipping for every reason.</li><li>Seller items: at least 30 days. Longer windows are shown on the offer.</li></ul>
      <h2>Who pays return shipping</h2><ul><li>Damaged, incorrect or defective items: the seller, with a prepaid label.</li><li>Changed your mind: you, unless the seller offers free returns.</li></ul>
      <h2>Category exceptions</h2><ul><li>Opened bedding, personal care and beauty items can be returned only if they are faulty.</li></ul>
      <h2>Refunds</h2><ul><li>Refunds go back to your original payment method. You see each step: Requested, Under review, Approved, Processing, Sent.</li><li>Approved doesn't mean the money has arrived. Banks take 3–5 business days after we send it.</li><li>Partial returns refund only the returned items and their share of any discount.</li></ul>
      <h2>When Marketly steps in</h2><p>If a seller doesn't answer a return request within 2 business days, rejects it and you disagree, or doesn't refund within 3 business days of receiving the item, ask Marketly to help from the return page. In some cases we refund without asking you to send the item back, and we record why.</p>`),
  },
  {
    key: 'shipping',
    kind: 'shipping',
    title: 'Shipping policy',
    audience: 'customer',
    body: h(`
      <p>Every item shows who ships it, where it ships from, the shipping cost and a delivery estimate for your address before you pay.</p>
      <h2>Who ships your order</h2><ul><li>Official Store items ship from our Reno, NV fulfillment center.</li><li>Marketplace items ship from the seller's own location.</li><li>One order can arrive in several packages, one per seller or ship-from location.</li></ul>
      <h2>Costs</h2><ul><li>Official Store: free standard delivery on orders over $35, otherwise $5.99.</li><li>Sellers set their own rates. You see each package's cost at checkout.</li></ul>
      <h2>Delivery estimates</h2><p>Estimates combine the seller's dispatch time and the carrier's transit time to your ZIP code. If a package is late, we tell you and show your options on the order page.</p>
      <h2>Where we deliver</h2><p>We deliver to street addresses in the contiguous 48 states and DC. Some sellers also ship to Alaska, Hawaii and PO boxes; the product page tells you before checkout.</p>
      <h2>Late, lost or damaged packages</h2><ul><li>Report it from the order page. The seller responds first; Marketly steps in after 2 business days.</li><li>If an item doesn't ship within 14 days of its estimate, you can cancel it for a full refund.</li></ul>`),
  },
  {
    key: 'privacy',
    kind: 'privacy',
    title: 'Privacy',
    audience: 'both',
    body: h(`
      <p>This policy explains what personal information Marketly collects, why, and the choices you have.</p>
      <h2>What we collect</h2><ul><li>Account details: name, email, phone and password (stored encrypted).</li><li>Order details: addresses, items, payment results. Card numbers are handled by our payment processor; we keep only the last 4 digits.</li><li>Support messages and photos you send.</li><li>Basic device and usage data to keep the site secure and working.</li></ul>
      <h2>What sellers see</h2><p>Sellers get only what they need to deliver and support your order: your name, delivery address, phone for the carrier and the items you bought. They can't see your payment details or other orders.</p>
      <h2>Marketing</h2><p>We only send marketing emails if you opt in. Order, delivery and refund updates are always sent. Change this in Profile at any time.</p>
      <h2>How long we keep it</h2><p>Order records are kept for 7 years for tax and accounting. You can close your account and ask us to delete other data.</p>
      <h2>Your rights</h2><p>You can ask for a copy of your data, correct it or delete it from your account, or write to the address on our About page.</p>`),
  },
  {
    key: 'purchase_terms',
    kind: 'purchase_terms',
    title: 'Purchase terms',
    audience: 'customer',
    body: h(`
      <p>These terms apply when you buy on Marketly. Your order keeps the terms, and each seller's return terms, that were shown when you placed it.</p>
      <h2>Who you're buying from</h2><p>Each item names its seller. Official Store items are sold by Marketly, Inc. Marketplace items are sold by the named seller; Marketly operates the store, takes payment and provides support.</p>
      <h2>Prices and total</h2><p>You see the full total, including shipping and tax, before you place an order. If a price, stock level, delivery date or coupon changes before you pay, we show the change and ask you to choose.</p>
      <h2>When an order is accepted</h2><p>An order is accepted when your payment is accepted. We email a confirmation only then. If the payment result is uncertain, we tell you and don't charge you twice.</p>
      <h2>Cancellations</h2><p>You can cancel an item until its seller ships it. Cancelling one item doesn't cancel the rest of the order.</p>
      <h2>Returns, refunds and help</h2><p>Returns follow the Returns policy and the seller's terms shown at purchase. If something goes wrong, the seller answers first and Marketly steps in when needed.</p>
      <h2>Changes to these terms</h2><p>We publish new versions with an effective date. Changes never apply to orders placed before that date.</p>`),
  },
  {
    key: 'seller_rules',
    kind: 'seller_rules',
    title: 'Seller rules policy',
    audience: 'both',
    body: h(`
      <p>These rules apply to every outside seller on Marketly. Sellers accept them in the seller agreement. Customers can rely on them when buying from any seller.</p>
      <h2>Listing accuracy</h2><ul><li>Offers must match the catalog product exactly: model, variation, bundle contents and condition.</li><li>Used and refurbished items must describe wear and missing accessories.</li><li>Prices and discounts must be real. A "was" price must have been charged in the last 90 days.</li></ul>
      <h2>Dispatch and response targets</h2><ul><li>Ship within the dispatch time shown on the offer.</li><li>Answer customer messages and return requests within 2 business days.</li></ul>
      <h2>What the Verified seller label means</h2><p>We checked the seller's business registration, the identity of its owner, a US bank account for payouts and a US return address. It does not mean we inspected each product. Report anything that looks wrong from the product or order page.</p>
      <h2>Restricted products</h2><p>Sellers can't list weapons, recalled items, prescription drugs, counterfeit goods or items outside our launch categories. Some categories need approval first.</p>
      <h2>Restrictions and appeals</h2><ul><li>When we restrict a seller, we tell them the reason, which activity is affected (for example, new sales or new listings) and how to appeal.</li><li>Existing orders, returns and customer cases continue while a seller is restricted.</li><li>Sellers can appeal within 14 days. A different team member reviews the appeal.</li></ul>`),
  },
];

export const ABOUT_PAGE = {
  slug: 'about',
  title: 'About Marketly',
  eyebrow: 'About us',
  intro: 'Marketly is a US marketplace where you can buy from the Marketly Official Store and from checked independent sellers, with the delivery date, total price and return terms shown before you pay.',
  blocks: [
    { type: 'text', id: 'who', title: 'Who we are', body: '<p>Marketly, Inc. runs the store, takes payment and provides customer support. The Official Store is our own shop: we buy the stock, keep it in our Reno, NV fulfillment center and ship it ourselves. Independent sellers list their own offers on the same product pages, so you can compare price, delivery and return terms side by side.</p>' },
    { type: 'text', id: 'checks', title: 'How we check sellers', body: '<ul><li><b>Application review.</b> We review the business, its products and where it ships from before approving it.</li><li><b>Identity and bank checks.</b> We confirm who owns the business and that payouts go to a verified US bank account.</li><li><b>Ongoing performance.</b> We track on-time dispatch, cancellations, replies and unresolved cases.</li><li><b>Restrictions when needed.</b> Sellers who miss our standards can be restricted. Your existing orders are still looked after.</li></ul>' },
    { type: 'text', id: 'labels', title: 'What our labels mean', body: '<ul><li><b>Official Store:</b> sold and shipped by Marketly. It isn’t a ranking: other sellers may offer a better price.</li><li><b>Verified seller:</b> we checked the business registration, owner identity, payout account and return address. We don’t inspect every product a seller sends.</li><li><b>Sponsored:</b> a seller or brand paid for the position. It’s always labelled and doesn’t change the price.</li></ul>' },
    { type: 'text', id: 'contact', title: 'Contact', body: '<p>Marketly, Inc. · 500 Market St, Portland, OR 97204. For help with an order, use the Help Center.</p>' },
  ],
};
