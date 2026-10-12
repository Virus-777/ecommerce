// Sample data for the mock layer (fictional names). Ported from design/prototype/js/data.js.
// Pages read shared entities from here; screen-specific copy lives next to each page.
// When the API is wired up, these are replaced by queries in src/api/.
import type { IconName } from '../ui/icons.generated';

/** Image tint: a design token (--img-1..6, brand-soft, surface-3), rendered as the .tint-* class. */
export type Tint = '1' | '2' | '3' | '4' | '5' | '6' | 'brand' | 'surface' | 'surface-3';

export interface Seller { id: string; name: string; short?: string; official?: boolean; verified: boolean; positive: number; ratings: number; location: string; ships: string; since: number; initials: string; tint: Tint; dispatch: string; status: string }
export interface Category { id: string; name: string; icon: IconName; tint: Tint; count: number; subs: string[] }
export interface Product { id: string; name: string; brand: string; cat: string; sub: string; price: number; was: number | null; rating: number; reviews: number; icon: IconName; tint: Tint; seller: SellerId; offers: number; delivery: string; free: boolean; sku: string; stock: number }
export interface Brand { name: string; initials: string; tint: Tint; products: number }
export interface Offer { seller: SellerId; condition: string; price: number; ship: number; delivery: string; dispatch: string; returns: string; warranty: string; main?: boolean; stock: string; note?: string; restricted?: boolean }

export const sellers = {
  official: {
    id: "official",
    name: "Marketly Official",
    short: "Official Store",
    official: true,
    verified: true,
    positive: 99,
    ratings: 18240,
    location: "Reno, NV",
    ships: "Marketly",
    since: 2026,
    initials: "M",
    tint: "brand",
    dispatch: "Same or next business day",
    status: "Approved"
  },
  northwind: {
    id: "northwind",
    name: "Northwind Audio",
    verified: true,
    positive: 98,
    ratings: 4812,
    location: "Portland, OR",
    ships: "Seller",
    since: 2026,
    initials: "NA",
    tint: "2",
    dispatch: "1 business day",
    status: "Approved"
  },
  pixelport: {
    id: "pixelport",
    name: "Pixel & Port",
    verified: true,
    positive: 96,
    ratings: 2391,
    location: "Austin, TX",
    ships: "Seller",
    since: 2026,
    initials: "PP",
    tint: "6",
    dispatch: "1–2 business days",
    status: "Approved"
  },
  casaverde: {
    id: "casaverde",
    name: "Casa Verde Home",
    verified: true,
    positive: 97,
    ratings: 1730,
    location: "Sacramento, CA",
    ships: "Seller",
    since: 2026,
    initials: "CV",
    tint: "1",
    dispatch: "2 business days",
    status: "Approved"
  },
  trailhead: {
    id: "trailhead",
    name: "Trailhead Outfitters",
    verified: true,
    positive: 95,
    ratings: 980,
    location: "Boulder, CO",
    ships: "Seller",
    since: 2026,
    initials: "TO",
    tint: "5",
    dispatch: "1–2 business days",
    status: "Approved"
  },
  gadgetgrove: {
    id: "gadgetgrove",
    name: "Gadget Grove",
    verified: false,
    positive: 89,
    ratings: 412,
    location: "Phoenix, AZ",
    ships: "Seller",
    since: 2026,
    initials: "GG",
    tint: "3",
    dispatch: "2–3 business days",
    status: "Restricted"
  }
} satisfies Record<string, Seller>;
export type SellerId = keyof typeof sellers;

export const categories: Category[] = [
  {
    id: "electronics",
    name: "Electronics",
    icon: "headphones",
    tint: "2",
    count: 1240,
    subs: [
      "Headphones",
      "Speakers",
      "Smart home",
      "Cameras",
      "Wearables"
    ]
  },
  {
    id: "computers",
    name: "Computers",
    icon: "monitor",
    tint: "6",
    count: 860,
    subs: [
      "Monitors",
      "Storage",
      "Keyboards",
      "Laptops",
      "Accessories"
    ]
  },
  {
    id: "home",
    name: "Home & Kitchen",
    icon: "cooking-pot",
    tint: "3",
    count: 2105,
    subs: [
      "Cookware",
      "Bedding",
      "Lighting",
      "Coffee & tea",
      "Cleaning"
    ]
  },
  {
    id: "fashion",
    name: "Fashion",
    icon: "shirt",
    tint: "4",
    count: 1830,
    subs: [
      "Knitwear",
      "Shoes",
      "Bags",
      "Outerwear",
      "Accessories"
    ]
  },
  {
    id: "sports",
    name: "Sports & Outdoors",
    icon: "tent",
    tint: "1",
    count: 940,
    subs: [
      "Hiking",
      "Running",
      "Yoga",
      "Cycling",
      "Camping"
    ]
  },
  {
    id: "beauty",
    name: "Beauty",
    icon: "sparkles",
    tint: "5",
    count: 620,
    subs: [
      "Skincare",
      "Hair",
      "Fragrance",
      "Bath"
    ]
  },
  {
    id: "toys",
    name: "Toys & Games",
    icon: "puzzle",
    tint: "3",
    count: 410,
    subs: [
      "Puzzles",
      "Board games",
      "Building sets"
    ]
  },
  {
    id: "pets",
    name: "Pet Supplies",
    icon: "paw-print",
    tint: "2",
    count: 330,
    subs: [
      "Dog",
      "Cat",
      "Small pets"
    ]
  }
];

export const products: Product[] = [
  {
    id: "aurora",
    name: "Halden Aurora ANC Wireless Headphones",
    brand: "Halden",
    cat: "electronics",
    sub: "Headphones",
    price: 189,
    was: 229,
    rating: 4.6,
    reviews: 1284,
    icon: "headphones",
    tint: "2",
    seller: "official",
    offers: 4,
    delivery: "Thu, Oct 15",
    free: true,
    sku: "HAL-AUR-BLK",
    stock: 142
  },
  {
    id: "kestrel27",
    name: "Kestrel 27\" 4K IPS Monitor, USB-C 65 W",
    brand: "Kestrel",
    cat: "computers",
    sub: "Monitors",
    price: 329,
    was: null,
    rating: 4.4,
    reviews: 612,
    icon: "monitor",
    tint: "6",
    seller: "pixelport",
    offers: 3,
    delivery: "Fri, Oct 16",
    free: true,
    sku: "KST-27UHD",
    stock: 18
  },
  {
    id: "ssd1tb",
    name: "Kestrel 1 TB Portable SSD, USB 3.2",
    brand: "Kestrel",
    cat: "computers",
    sub: "Storage",
    price: 94.99,
    was: 119.99,
    rating: 4.7,
    reviews: 2210,
    icon: "hard-drive",
    tint: "6",
    seller: "pixelport",
    offers: 5,
    delivery: "Thu, Oct 15",
    free: true,
    sku: "KST-SSD1T",
    stock: 64
  },
  {
    id: "lamp",
    name: "Brightline Smart LED Desk Lamp with Wireless Charger",
    brand: "Brightline",
    cat: "home",
    sub: "Lighting",
    price: 42,
    was: null,
    rating: 4.3,
    reviews: 388,
    icon: "lamp-desk",
    tint: "5",
    seller: "official",
    offers: 1,
    delivery: "Wed, Oct 14",
    free: true,
    sku: "BRL-LAMP-W",
    stock: 9
  },
  {
    id: "duvet",
    name: "Mosswood Washed Linen Duvet Cover, Queen",
    brand: "Mosswood",
    cat: "home",
    sub: "Bedding",
    price: 119,
    was: 149,
    rating: 4.8,
    reviews: 954,
    icon: "bed-double",
    tint: "1",
    seller: "casaverde",
    offers: 2,
    delivery: "Mon, Oct 19",
    free: true,
    sku: "MSW-LIN-Q-SAGE",
    stock: 31
  },
  {
    id: "bottle",
    name: "Tidewell Insulated Bottle 750 ml",
    brand: "Tidewell",
    cat: "sports",
    sub: "Hiking",
    price: 29.5,
    was: null,
    rating: 4.6,
    reviews: 3105,
    icon: "cup-soda",
    tint: "6",
    seller: "trailhead",
    offers: 3,
    delivery: "Thu, Oct 15",
    free: false,
    sku: "TDW-750-SLT",
    stock: 220
  },
  {
    id: "backpack",
    name: "Trailhead Ridge 40 L Hiking Backpack",
    brand: "Trailhead",
    cat: "sports",
    sub: "Hiking",
    price: 139,
    was: 165,
    rating: 4.5,
    reviews: 471,
    icon: "backpack",
    tint: "5",
    seller: "trailhead",
    offers: 1,
    delivery: "Fri, Oct 16",
    free: true,
    sku: "TRH-R40-OLV",
    stock: 26
  },
  {
    id: "shoes",
    name: "Corvo Swift Trail Running Shoes",
    brand: "Corvo",
    cat: "fashion",
    sub: "Shoes",
    price: 112,
    was: null,
    rating: 4.2,
    reviews: 296,
    icon: "footprints",
    tint: "4",
    seller: "trailhead",
    offers: 2,
    delivery: "Fri, Oct 16",
    free: true,
    sku: "CRV-SWF-10",
    stock: 40
  },
  {
    id: "skillet",
    name: "Pellar Pre-seasoned Cast Iron Skillet 26 cm",
    brand: "Pellar",
    cat: "home",
    sub: "Cookware",
    price: 58,
    was: 72,
    rating: 4.9,
    reviews: 1876,
    icon: "cooking-pot",
    tint: "3",
    seller: "official",
    offers: 3,
    delivery: "Wed, Oct 14",
    free: true,
    sku: "PLR-CI26",
    stock: 77
  },
  {
    id: "sweater",
    name: "Nordvik Merino Wool Crew Sweater",
    brand: "Nordvik",
    cat: "fashion",
    sub: "Knitwear",
    price: 84,
    was: null,
    rating: 4.4,
    reviews: 203,
    icon: "shirt",
    tint: "4",
    seller: "official",
    offers: 1,
    delivery: "Thu, Oct 15",
    free: true,
    sku: "NDV-MER-M-NVY",
    stock: 52
  },
  {
    id: "speaker",
    name: "Halden Pocket Bluetooth Speaker",
    brand: "Halden",
    cat: "electronics",
    sub: "Speakers",
    price: 59,
    was: 79,
    rating: 4.5,
    reviews: 842,
    icon: "speaker",
    tint: "2",
    seller: "northwind",
    offers: 3,
    delivery: "Thu, Oct 15",
    free: true,
    sku: "HAL-PKT-TEAL",
    stock: 88
  },
  {
    id: "vacuum",
    name: "Brightline S2 Robot Vacuum with Mapping",
    brand: "Brightline",
    cat: "home",
    sub: "Cleaning",
    price: 279,
    was: 349,
    rating: 4.1,
    reviews: 519,
    icon: "bot",
    tint: "1",
    seller: "gadgetgrove",
    offers: 4,
    delivery: "Tue, Oct 20",
    free: true,
    sku: "BRL-S2",
    stock: 6
  },
  {
    id: "keyboard",
    name: "Kestrel K75 Wireless Mechanical Keyboard",
    brand: "Kestrel",
    cat: "computers",
    sub: "Keyboards",
    price: 109,
    was: null,
    rating: 4.6,
    reviews: 731,
    icon: "keyboard",
    tint: "6",
    seller: "pixelport",
    offers: 2,
    delivery: "Fri, Oct 16",
    free: true,
    sku: "KST-K75-GRY",
    stock: 35
  },
  {
    id: "pourover",
    name: "Mosswood Ceramic Pour-over Coffee Set",
    brand: "Mosswood",
    cat: "home",
    sub: "Coffee & tea",
    price: 36,
    was: null,
    rating: 4.7,
    reviews: 412,
    icon: "coffee",
    tint: "3",
    seller: "official",
    offers: 2,
    delivery: "Wed, Oct 14",
    free: true,
    sku: "MSW-PO-CRM",
    stock: 58
  },
  {
    id: "serum",
    name: "Aster Daily Vitamin C Serum 30 ml",
    brand: "Aster",
    cat: "beauty",
    sub: "Skincare",
    price: 24,
    was: 30,
    rating: 4.3,
    reviews: 1520,
    icon: "droplet",
    tint: "5",
    seller: "official",
    offers: 2,
    delivery: "Thu, Oct 15",
    free: false,
    sku: "AST-VC30",
    stock: 140
  },
  {
    id: "yogamat",
    name: "Corvo Grip Yoga Mat 6 mm",
    brand: "Corvo",
    cat: "sports",
    sub: "Yoga",
    price: 45,
    was: null,
    rating: 4.4,
    reviews: 667,
    icon: "activity",
    tint: "1",
    seller: "trailhead",
    offers: 2,
    delivery: "Fri, Oct 16",
    free: false,
    sku: "CRV-YM6-SAGE",
    stock: 70
  }
];
export const P: Record<string, Product> = Object.fromEntries(products.map((p) => [p.id, p]));

export const brands: Brand[] = [
  {
    name: "Halden",
    initials: "H",
    tint: "2",
    products: 48
  },
  {
    name: "Kestrel",
    initials: "K",
    tint: "6",
    products: 63
  },
  {
    name: "Mosswood",
    initials: "Mw",
    tint: "1",
    products: 37
  },
  {
    name: "Brightline",
    initials: "B",
    tint: "5",
    products: 29
  },
  {
    name: "Corvo",
    initials: "C",
    tint: "4",
    products: 41
  },
  {
    name: "Pellar",
    initials: "P",
    tint: "3",
    products: 18
  }
];

export const auroraOffers: Offer[] = [
  {
    seller: "official",
    condition: "New",
    price: 189,
    ship: 0,
    delivery: "Thu, Oct 15",
    dispatch: "Ships today",
    returns: "30-day free returns",
    warranty: "2-year manufacturer warranty",
    main: true,
    stock: "In stock"
  },
  {
    seller: "northwind",
    condition: "New",
    price: 184,
    ship: 6.99,
    delivery: "Fri, Oct 16",
    dispatch: "Ships in 1 business day",
    returns: "30-day returns, buyer pays return shipping",
    warranty: "2-year manufacturer warranty",
    stock: "In stock"
  },
  {
    seller: "pixelport",
    condition: "Used – Like new",
    price: 149,
    ship: 0,
    delivery: "Mon, Oct 19",
    dispatch: "Ships in 2 business days",
    returns: "14-day returns",
    warranty: "90-day seller warranty",
    note: "Opened box, all accessories included, no visible wear.",
    stock: "2 left"
  },
  {
    seller: "gadgetgrove",
    condition: "Refurbished",
    price: 129,
    ship: 4.99,
    delivery: "Tue, Oct 20",
    dispatch: "Ships in 2–3 business days",
    returns: "14-day returns",
    warranty: "6-month seller warranty",
    note: "Replacement ear cushions. Carry case not included.",
    stock: "In stock",
    restricted: true
  }
];

export const customer = {
  name: "Jordan Lee",
  first: "Jordan",
  email: "jordan.lee@example.com",
  phone: "(503) 555-0148",
  since: "Aug 2026",
  addresses: [
    {
      id: "a1",
      label: "Home",
      name: "Jordan Lee",
      line1: "2140 Alder St, Apt 5",
      city: "Portland, OR 97205",
      phone: "(503) 555-0148",
      default: true
    },
    {
      id: "a2",
      label: "Work",
      name: "Jordan Lee",
      line1: "815 SW 2nd Ave, Floor 4",
      city: "Portland, OR 97204",
      phone: "(503) 555-0199",
      default: false
    }
  ]
};

export const order = {
  ref: "MK-260914-48213",
  placed: "Sep 14, 2026, 7:42 PM",
  status: "Partly delivered",
  payment: "Visa •••• 4417",
  paymentStatus: "Accepted",
  groups: [
    {
      seller: "official",
      pkg: "Package 1 of 3",
      status: "Delivered",
      carrier: "UPS Ground",
      tracking: "1Z84E2W70392017745",
      eta: "Delivered Sep 17",
      items: [
        {
          p: "aurora",
          qty: 1,
          price: 189,
          variant: "Midnight black",
          state: "Delivered"
        },
        {
          p: "pourover",
          qty: 1,
          price: 36,
          variant: "Cream",
          state: "Return requested"
        }
      ],
      ship: 0
    },
    {
      seller: "pixelport",
      pkg: "Package 2 of 3",
      status: "Shipped",
      carrier: "USPS Priority",
      tracking: "9405 5112 9830 1847 2290 31",
      eta: "Arrives Oct 9–10",
      items: [
        {
          p: "ssd1tb",
          qty: 2,
          price: 94.99,
          variant: "Space gray",
          state: "In transit"
        }
      ],
      ship: 0
    },
    {
      seller: "casaverde",
      pkg: "Package 3 of 3",
      status: "Delayed",
      carrier: "—",
      tracking: null,
      eta: "Was due Sep 22 · now Oct 12",
      items: [
        {
          p: "duvet",
          qty: 1,
          price: 119,
          variant: "Queen · Sage",
          state: "Delayed"
        }
      ],
      ship: 0
    }
  ],
  subtotal: 533.98,
  discount: 20,
  coupon: "WELCOME20",
  shipping: 0,
  tax: 0,
  total: 513.98
};

export const orders = [
  {
    ref: "MK-261006-90127",
    date: "Oct 6, 2026",
    total: 88.5,
    items: [
      "bottle",
      "yogamat"
    ],
    status: "Preparing",
    tone: "info",
    sellers: 1
  },
  {
    ref: "MK-260914-48213",
    date: "Sep 14, 2026",
    total: 513.98,
    items: [
      "aurora",
      "pourover",
      "ssd1tb",
      "duvet"
    ],
    status: "Partly delivered",
    tone: "warning",
    sellers: 3
  },
  {
    ref: "MK-260830-11764",
    date: "Aug 30, 2026",
    total: 58,
    items: [
      "skillet"
    ],
    status: "Delivered",
    tone: "success",
    sellers: 1
  },
  {
    ref: "MK-260818-07352",
    date: "Aug 18, 2026",
    total: 139,
    items: [
      "backpack"
    ],
    status: "Refunded",
    tone: "neutral",
    sellers: 1
  },
  {
    ref: "MK-260811-03309",
    date: "Aug 11, 2026",
    total: 112,
    items: [
      "shoes"
    ],
    status: "Cancelled",
    tone: "neutral",
    sellers: 1
  }
];

export const sellerOrders = [
  {
    ref: "MK-261008-12077",
    placed: "Oct 8, 9:14 AM",
    buyer: "Sam R.",
    items: "Halden Pocket Bluetooth Speaker × 2",
    total: 118,
    status: "New",
    due: "Due today 5:00 PM",
    dueTone: "warning"
  },
  {
    ref: "MK-261008-11902",
    placed: "Oct 8, 8:02 AM",
    buyer: "Priya K.",
    items: "Halden Aurora ANC Headphones",
    total: 190.99,
    status: "New",
    due: "Due today 5:00 PM",
    dueTone: "warning"
  },
  {
    ref: "MK-261007-10433",
    placed: "Oct 7, 6:48 PM",
    buyer: "Alex M.",
    items: "Halden Pocket Speaker × 1",
    total: 59,
    status: "Preparing",
    due: "Overdue 3 h",
    dueTone: "danger"
  },
  {
    ref: "MK-261007-09811",
    placed: "Oct 7, 2:10 PM",
    buyer: "Chris T.",
    items: "Halden Aurora ANC Headphones",
    total: 190.99,
    status: "Shipped",
    due: "Shipped Oct 8",
    dueTone: "ok"
  },
  {
    ref: "MK-261006-08120",
    placed: "Oct 6, 11:31 AM",
    buyer: "Jordan L.",
    items: "Studio Cable Kit",
    total: 24,
    status: "Completed",
    due: "Delivered Oct 8",
    dueTone: "ok"
  }
];

export const staffRoles = [
  {
    role: "Business Owner",
    area: "All areas",
    people: [
      "Morgan Hale"
    ],
    limit: "Sets all limits"
  },
  {
    role: "Platform Administrator",
    area: "Settings",
    people: [
      "Riley Chen"
    ],
    limit: "No financial authority"
  },
  {
    role: "Official Store Manager",
    area: "Official store",
    people: [
      "Dana Ortiz"
    ],
    limit: "Price changes up to 30%"
  },
  {
    role: "Purchasing Manager",
    area: "Purchasing",
    people: [
      "Ken Watanabe"
    ],
    limit: "POs up to $25,000"
  },
  {
    role: "Inventory Manager",
    area: "Inventory",
    people: [
      "Ana Silva"
    ],
    limit: "Adjustments up to 50 units"
  },
  {
    role: "Warehouse Manager",
    area: "Warehouse",
    people: [
      "Ana Silva"
    ],
    limit: "—"
  },
  {
    role: "Order Manager",
    area: "Orders",
    people: [
      "Theo Grant"
    ],
    limit: "Cancellations up to $500"
  },
  {
    role: "Shipping Manager",
    area: "Shipping",
    people: [
      "Theo Grant"
    ],
    limit: "Carrier claims up to $1,000"
  },
  {
    role: "Returns Manager",
    area: "Returns",
    people: [
      "Lena Park"
    ],
    limit: "Propose remedies"
  },
  {
    role: "Catalog Manager",
    area: "Catalog",
    people: [
      "Omar Haddad"
    ],
    limit: "Publish / suspend products"
  },
  {
    role: "Seller Manager",
    area: "Sellers",
    people: [
      "Grace Kim"
    ],
    limit: "Restrict sellers; suspend with 2nd review"
  },
  {
    role: "Customer Support Manager",
    area: "Customer service",
    people: [
      "Isabel Cruz"
    ],
    limit: "Goodwill credit up to $50"
  },
  {
    role: "Finance Manager",
    area: "Finance",
    people: [
      "Priya Nair"
    ],
    limit: "Refunds up to $2,000; payouts with 2nd review"
  },
  {
    role: "Marketing Manager",
    area: "Marketing",
    people: [
      "Jamie Brooks"
    ],
    limit: "Campaign budget up to $10,000"
  },
  {
    role: "Advertising Manager",
    area: "Advertisements",
    people: [
      "Jamie Brooks"
    ],
    limit: "Approve creatives"
  },
  {
    role: "Content Manager",
    area: "Content",
    people: [
      "Noor Aziz"
    ],
    limit: "Publish pages and articles"
  },
  {
    role: "Trust and Risk Manager",
    area: "Trust and risk",
    people: [
      "Sven Larsen"
    ],
    limit: "Recommend enforcement"
  },
  {
    role: "Reports Analyst",
    area: "Reports",
    people: [
      "Mei Lin"
    ],
    limit: "Read-only + exports"
  }
];

export const sales14 = {
  labels: [
    "Sep 25",
    "Sep 26",
    "Sep 27",
    "Sep 28",
    "Sep 29",
    "Sep 30",
    "Oct 1",
    "Oct 2",
    "Oct 3",
    "Oct 4",
    "Oct 5",
    "Oct 6",
    "Oct 7",
    "Oct 8"
  ],
  official: [
    18.2,
    19.1,
    22.4,
    24.8,
    17.6,
    16.9,
    18.4,
    20.2,
    21,
    25.6,
    27.1,
    19.4,
    18.8,
    20.6
  ],
  sellers: [
    11.4,
    12,
    14.8,
    16.2,
    12.1,
    12.6,
    13,
    14.4,
    15.1,
    18.9,
    20.3,
    14.2,
    14.9,
    16.1
  ]
};
