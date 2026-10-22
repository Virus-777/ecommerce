/**
 * Sample phones for the app's Phone tab (departments module, standalone phones): the Galaxy S26 Ultra exactly as on
 * the approved AdminPhoneEdit and PhoneDetail artboards, and five more with plausible data (the Galaxy A57 hidden).
 * Written through the Admin Center API and only when missing (a phone with the same slug is kept as it is), so it is
 * safe to run again. Used by seedDepartments (departments-data.ts).
 *
 * Advertisement images: posters generated with sharp (the phone, a big headline and a subline), apart from the
 * photos. A sample phone that exists without any (added before advertisement images) gets them on the next run, the
 * rest of it kept as it is.
 *
 * Photos: generated with sharp (a soft tinted background, a rounded phone shape in the phone's first color, the
 * phone's name and "Photo n"), in the artboard's mixed sizes (1440 × 1920, 1920 × 1440, 2048 × 1152, 1080 × 1350;
 * phone photos must be at least 1080 px wide), uploaded as content_image files.
 */
import sharp from 'sharp';
import type { AdminCall } from './departments-data.js';
import type { Uploader } from './software-data.js';

const usd = (dollars: number) => ({ amount: Math.round(dollars * 100), currency: 'USD' });
const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

type Size = '1440x1920' | '1920x1440' | '2048x1152' | '1080x1350' | '1080x1920';
/** The artboards' image tints (--img-1 … --img-6) */
const TINTS = ['#E4EFEC', '#E9ECF4', '#F4ECE4', '#ECE8F2', '#F2EFE2', '#E5EEF3'];

export interface SamplePhone {
  brand: string;
  name: string;
  overview: string;
  storage: { size: string; price: number; was?: number }[];
  colors: { name: string; short: string; hex: string }[];
  photos: { size: Size; alt: string }[];
  /** The Advertisements tab: posters, never also a preview photo (alt = headline and sub) */
  ads: { size: Size; headline: string; sub: string }[];
  specGroups: { name: string; rows: [string, string][] }[];
  showServices?: boolean;
  status?: 'published' | 'hidden';
}

export const PHONES: SamplePhone[] = [
  {
    brand: 'Samsung',
    name: 'Samsung Galaxy S26 Ultra 5G',
    overview: 'Galaxy S26 Ultra pairs a 6.9-inch QHD+ display with a 200 MP main camera and a built-in S Pen. The titanium frame is lighter than last year’s, and the 5,000 mAh battery lasts a full day of heavy use.',
    storage: [
      { size: '256 GB', price: 1099.99, was: 1299.99 },
      { size: '512 GB', price: 1219.99, was: 1419.99 },
      { size: '1 TB', price: 1459.99 },
    ],
    colors: [
      { name: 'Titanium Gray', short: 'Gray', hex: '#8C918F' },
      { name: 'Titanium Black', short: 'Black', hex: '#222826' },
      { name: 'Titanium Violet', short: 'Violet', hex: '#8E86A8' },
    ],
    photos: [
      { size: '1440x1920', alt: 'Titanium Gray, front and back' },
      { size: '1920x1440', alt: 'The S Pen' },
      { size: '2048x1152', alt: 'Camera module, close up' },
      { size: '1440x1920', alt: 'Titanium Violet' },
      { size: '1440x1920', alt: 'In the hand' },
      { size: '1920x1440', alt: 'Titanium Black, side' },
      { size: '1080x1350', alt: 'Display, outdoors' },
      { size: '1920x1440', alt: 'In the box' },
    ],
    ads: [
      { size: '1080x1920', headline: 'Galaxy S26 Ultra', sub: 'Titanium, lighter than ever' },
      { size: '1080x1350', headline: '200 MP. Every detail.', sub: 'Main camera with 5× optical zoom' },
      { size: '1920x1440', headline: 'Built-in S Pen', sub: 'Write, sketch and edit' },
      { size: '1080x1920', headline: 'All day. Then some.', sub: '5,000 mAh battery, 45 W charging' },
    ],
    specGroups: [
      { name: 'Display', rows: [['Size', '6.9 inches'], ['Type', 'Dynamic AMOLED 2X'], ['Resolution', '3120 × 1440 (QHD+)'], ['Refresh rate', '1–120 Hz']] },
      { name: 'Performance', rows: [['Chip', 'Snapdragon 8 Elite Gen 2'], ['Memory', '12 GB RAM'], ['Storage', '256 GB, 512 GB or 1 TB']] },
      { name: 'Camera', rows: [['Main', '200 MP, f/1.7, OIS'], ['Ultra-wide', '50 MP, f/1.9'], ['Telephoto', '50 MP, 5× optical zoom'], ['Front', '12 MP'], ['Video', '8K at 30 fps']] },
      { name: 'Battery', rows: [['Capacity', '5,000 mAh'], ['Wired charging', '45 W'], ['Wireless', '15 W']] },
      { name: 'Connectivity', rows: [['Network', '5G'], ['Wi-Fi', 'Wi-Fi 7'], ['Bluetooth', '5.4'], ['SIM', 'Nano-SIM and eSIM'], ['Port', 'USB-C 3.2']] },
      { name: 'Build', rows: [['Dimensions', '162.8 × 77.6 × 8.2 mm'], ['Weight', '218 g'], ['Frame', 'Titanium'], ['Water resistance', 'IP68']] },
      { name: 'Software', rows: [['OS', 'Android 17, One UI 9'], ['Updates', '7 years of OS updates']] },
    ],
  },
  {
    brand: 'Apple',
    name: 'Apple iPhone 18 Pro',
    overview: 'iPhone 18 Pro has a 6.3-inch ProMotion display, three 48 MP cameras with a 4× telephoto, and the A20 Pro chip.\n\nThe aluminium unibody keeps it cool under load, and the battery plays up to 31 hours of video.',
    storage: [
      { size: '256 GB', price: 1099, was: 1199 },
      { size: '512 GB', price: 1299 },
      { size: '1 TB', price: 1499 },
    ],
    colors: [
      { name: 'Cosmic Orange', short: 'Orange', hex: '#D9733A' },
      { name: 'Deep Blue', short: 'Blue', hex: '#2E3A55' },
      { name: 'Silver', short: 'Silver', hex: '#D9D9D6' },
    ],
    photos: [
      { size: '1440x1920', alt: 'Cosmic Orange, front and back' },
      { size: '2048x1152', alt: 'Camera plateau, close up' },
      { size: '1920x1440', alt: 'Deep Blue, side' },
      { size: '1080x1350', alt: 'In the hand' },
      { size: '1440x1920', alt: 'Silver' },
    ],
    ads: [
      { size: '1080x1920', headline: 'iPhone 18 Pro', sub: 'Three 48 MP cameras' },
      { size: '1080x1350', headline: 'A20 Pro inside', sub: 'Cool under load, fast all day' },
      { size: '1920x1440', headline: '31 hours of video', sub: 'The longest-lasting Pro yet' },
    ],
    specGroups: [
      { name: 'Display', rows: [['Size', '6.3 inches'], ['Type', 'Super Retina XDR OLED'], ['Resolution', '2622 × 1206'], ['Refresh rate', '1–120 Hz ProMotion']] },
      { name: 'Performance', rows: [['Chip', 'A20 Pro'], ['Memory', '12 GB RAM'], ['Storage', '256 GB, 512 GB or 1 TB']] },
      { name: 'Camera', rows: [['Main', '48 MP Fusion, f/1.78'], ['Ultra-wide', '48 MP, f/2.2'], ['Telephoto', '48 MP, 4× optical zoom'], ['Front', '18 MP Center Stage'], ['Video', '4K at 120 fps, Dolby Vision']] },
      { name: 'Battery', rows: [['Video playback', 'Up to 31 hours'], ['Wired charging', '40 W'], ['Wireless', 'MagSafe 25 W']] },
      { name: 'Connectivity', rows: [['Network', '5G'], ['Wi-Fi', 'Wi-Fi 7'], ['Bluetooth', '6.0'], ['SIM', 'eSIM only'], ['Port', 'USB-C (USB 3)']] },
      { name: 'Build', rows: [['Dimensions', '150.0 × 71.9 × 8.7 mm'], ['Weight', '204 g'], ['Frame', 'Aluminium'], ['Water resistance', 'IP68']] },
      { name: 'Software', rows: [['OS', 'iOS 27']] },
    ],
  },
  {
    brand: 'Google',
    name: 'Google Pixel 11 Pro',
    overview: 'Pixel 11 Pro brings Google’s Tensor G6 chip, a 6.3-inch Super Actua display and a 50 MP triple camera with 5× zoom. It gets seven years of Android and security updates.',
    storage: [
      { size: '128 GB', price: 999, was: 1099 },
      { size: '256 GB', price: 1099, was: 1199 },
      { size: '512 GB', price: 1219 },
    ],
    colors: [
      { name: 'Obsidian', short: 'Black', hex: '#2B2B2B' },
      { name: 'Porcelain', short: 'White', hex: '#EDE6DA' },
      { name: 'Moonstone', short: 'Blue', hex: '#8D99A6' },
    ],
    photos: [
      { size: '1440x1920', alt: 'Obsidian, front and back' },
      { size: '2048x1152', alt: 'Camera bar' },
      { size: '1920x1440', alt: 'Porcelain, side' },
      { size: '1080x1350', alt: 'Night photo on the display' },
      { size: '1440x1920', alt: 'Moonstone' },
      { size: '1920x1440', alt: 'In the box' },
    ],
    ads: [
      { size: '1080x1920', headline: 'Pixel 11 Pro', sub: 'Google AI, built in' },
      { size: '1920x1440', headline: 'Night Sight, sharper', sub: '50 MP with 5× zoom' },
      { size: '1080x1350', headline: '7 years of updates', sub: 'Android and security, included' },
    ],
    specGroups: [
      { name: 'Display', rows: [['Size', '6.3 inches'], ['Type', 'Super Actua LTPO OLED'], ['Resolution', '2856 × 1280'], ['Refresh rate', '1–120 Hz']] },
      { name: 'Performance', rows: [['Chip', 'Google Tensor G6'], ['Memory', '16 GB RAM'], ['Storage', '128 GB, 256 GB or 512 GB']] },
      { name: 'Camera', rows: [['Main', '50 MP, f/1.68, OIS'], ['Ultra-wide', '48 MP, f/1.7'], ['Telephoto', '48 MP, 5× optical zoom'], ['Front', '42 MP'], ['Video', '8K at 30 fps']] },
      { name: 'Battery', rows: [['Capacity', '4,870 mAh'], ['Wired charging', '30 W'], ['Wireless', 'Qi2 25 W']] },
      { name: 'Connectivity', rows: [['Network', '5G'], ['Wi-Fi', 'Wi-Fi 7'], ['Bluetooth', '6.0'], ['SIM', 'Nano-SIM and eSIM'], ['Port', 'USB-C 3.2']] },
      { name: 'Build', rows: [['Dimensions', '152.8 × 72.0 × 8.5 mm'], ['Weight', '199 g'], ['Frame', 'Aluminium'], ['Water resistance', 'IP68']] },
      { name: 'Software', rows: [['OS', 'Android 17'], ['Updates', '7 years of OS and security updates']] },
    ],
  },
  {
    brand: 'Xiaomi',
    name: 'Xiaomi 16T Pro',
    overview: 'Xiaomi 16T Pro charges from empty to full in about 20 minutes and has a 6.67-inch 144 Hz display. Its Leica-tuned 50 MP camera handles night shots well.',
    storage: [
      { size: '256 GB', price: 649.99, was: 749.99 },
      { size: '512 GB', price: 729.99, was: 799.99 },
    ],
    colors: [
      { name: 'Titan Gray', short: 'Gray', hex: '#7D7F82' },
      { name: 'Titan Blue', short: 'Blue', hex: '#3E5D7E' },
      { name: 'Titan Black', short: 'Black', hex: '#1E1E1E' },
    ],
    photos: [
      { size: '1440x1920', alt: 'Titan Gray, front and back' },
      { size: '1920x1440', alt: 'Titan Blue, side' },
      { size: '2048x1152', alt: 'Leica camera, close up' },
      { size: '1080x1350', alt: 'Charging' },
    ],
    ads: [
      { size: '1080x1920', headline: 'Xiaomi 16T Pro', sub: 'Full in about 20 minutes' },
      { size: '1080x1350', headline: '120 W HyperCharge', sub: '5,500 mAh battery' },
    ],
    specGroups: [
      { name: 'Display', rows: [['Size', '6.67 inches'], ['Type', 'AMOLED'], ['Resolution', '2712 × 1220'], ['Refresh rate', '144 Hz']] },
      { name: 'Performance', rows: [['Chip', 'MediaTek Dimensity 9500+'], ['Memory', '12 GB RAM'], ['Storage', '256 GB or 512 GB']] },
      { name: 'Camera', rows: [['Main', '50 MP, f/1.62, OIS'], ['Ultra-wide', '12 MP'], ['Telephoto', '50 MP, 2.6× optical zoom'], ['Front', '32 MP']] },
      { name: 'Battery', rows: [['Capacity', '5,500 mAh'], ['Wired charging', '120 W'], ['Wireless', '50 W']] },
      { name: 'Connectivity', rows: [['Network', '5G'], ['Wi-Fi', 'Wi-Fi 7'], ['Bluetooth', '5.4'], ['SIM', 'Dual nano-SIM'], ['Port', 'USB-C']] },
      { name: 'Software', rows: [['OS', 'Android 16, HyperOS 3'], ['Updates', '5 years of OS updates']] },
    ],
  },
  {
    brand: 'Oppo',
    name: 'Oppo Find X9',
    overview: 'Find X9 is a compact flagship with a 6.59-inch display, a Hasselblad-tuned triple camera and a 7,025 mAh battery that easily lasts two days.',
    storage: [
      { size: '256 GB', price: 899 },
      { size: '512 GB', price: 999, was: 1099 },
    ],
    colors: [
      { name: 'Space Black', short: 'Black', hex: '#1C1C1E' },
      { name: 'Velvet Red', short: 'Red', hex: '#8E2B33' },
      { name: 'Frost White', short: 'White', hex: '#F0F0EE' },
    ],
    photos: [
      { size: '1440x1920', alt: 'Space Black, front and back' },
      { size: '2048x1152', alt: 'Hasselblad camera ring' },
      { size: '1920x1440', alt: 'Velvet Red, side' },
      { size: '1440x1920', alt: 'Frost White' },
      { size: '1080x1350', alt: 'Portrait photo on the display' },
    ],
    ads: [
      { size: '1080x1920', headline: 'Find X9', sub: 'Small phone, big battery' },
      { size: '1920x1440', headline: 'Hasselblad colour', sub: '50 MP triple camera' },
      { size: '1080x1350', headline: 'Two days per charge', sub: '7,025 mAh, 80 W charging' },
    ],
    specGroups: [
      { name: 'Display', rows: [['Size', '6.59 inches'], ['Type', 'LTPO AMOLED'], ['Resolution', '2760 × 1256'], ['Refresh rate', '1–120 Hz']] },
      { name: 'Performance', rows: [['Chip', 'MediaTek Dimensity 9500'], ['Memory', '12 GB or 16 GB RAM'], ['Storage', '256 GB or 512 GB']] },
      { name: 'Camera', rows: [['Main', '50 MP, f/1.6, OIS'], ['Ultra-wide', '50 MP'], ['Telephoto', '50 MP, 3× optical zoom'], ['Front', '32 MP']] },
      { name: 'Battery', rows: [['Capacity', '7,025 mAh'], ['Wired charging', '80 W'], ['Wireless', '50 W']] },
      { name: 'Build', rows: [['Dimensions', '156.9 × 73.9 × 8.0 mm'], ['Weight', '203 g'], ['Water resistance', 'IP68 and IP69']] },
      { name: 'Software', rows: [['OS', 'Android 16, ColorOS 16']] },
    ],
  },
  {
    brand: 'Samsung',
    name: 'Samsung Galaxy A57 5G',
    overview: 'Galaxy A57 5G has a bright 6.7-inch Super AMOLED display, a 50 MP camera and six years of updates at a mid-range price.',
    storage: [
      { size: '128 GB', price: 449.99, was: 499.99 },
      { size: '256 GB', price: 509.99 },
    ],
    colors: [
      { name: 'Awesome Navy', short: 'Navy', hex: '#2A3550' },
      { name: 'Awesome Lilac', short: 'Lilac', hex: '#C8B8E0' },
      { name: 'Awesome Ice Blue', short: 'Ice Blue', hex: '#BFD8E6' },
    ],
    photos: [
      { size: '1440x1920', alt: 'Awesome Navy, front and back' },
      { size: '1920x1440', alt: 'Awesome Lilac, side' },
      { size: '1080x1350', alt: 'Awesome Ice Blue' },
      { size: '2048x1152', alt: 'Camera, close up' },
    ],
    ads: [
      { size: '1080x1920', headline: 'Galaxy A57 5G', sub: 'Awesome, every day' },
      { size: '1080x1350', headline: 'Six years of updates', sub: 'One UI on a 6.7-inch screen' },
    ],
    specGroups: [
      { name: 'Display', rows: [['Size', '6.7 inches'], ['Type', 'Super AMOLED'], ['Refresh rate', '120 Hz']] },
      { name: 'Performance', rows: [['Chip', 'Exynos 1680'], ['Memory', '8 GB RAM'], ['Storage', '128 GB or 256 GB']] },
      { name: 'Camera', rows: [['Main', '50 MP, OIS'], ['Ultra-wide', '12 MP'], ['Macro', '5 MP'], ['Front', '12 MP']] },
      { name: 'Battery', rows: [['Capacity', '5,000 mAh'], ['Wired charging', '45 W']] },
      { name: 'Software', rows: [['OS', 'Android 16, One UI 8.5'], ['Updates', '6 years of OS updates']] },
    ],
    status: 'hidden',
  },
];

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A sample phone photo: tinted background, a rounded phone in `hex`, the phone's name and "Photo n" (PNG) */
export async function phonePhoto(name: string, n: number, size: Size, hex: string): Promise<Buffer> {
  const [width, height] = size.split('x').map(Number) as [number, number];
  const tint = TINTS[(n - 1) % TINTS.length]!;
  const ph = Math.round(height * 0.56);
  const pw = Math.round(ph * 0.48);
  const x = Math.round((width - pw) / 2);
  const y = Math.round(height * 0.1);
  const r = Math.round(pw * 0.14);
  const inset = Math.round(pw * 0.05);
  const title = Math.round(Math.min(width, height) * 0.05);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${tint}"/>
  <rect x="${x + 10}" y="${y + 16}" width="${pw}" height="${ph}" rx="${r}" fill="#13201C" fill-opacity="0.08"/>
  <rect x="${x}" y="${y}" width="${pw}" height="${ph}" rx="${r}" fill="${hex}" stroke="#3E4C47" stroke-opacity="0.35" stroke-width="${Math.max(3, Math.round(pw * 0.012))}"/>
  <rect x="${x + inset}" y="${y + inset}" width="${pw - 2 * inset}" height="${ph - 2 * inset}" rx="${Math.round(r * 0.7)}" fill="#FFFFFF" fill-opacity="0.18"/>
  <circle cx="${x + pw * 0.26}" cy="${y + pw * 0.26}" r="${pw * 0.09}" fill="#13201C" fill-opacity="0.35"/>
  <text x="${width / 2}" y="${y + ph + title * 2}" font-family="Arial, Helvetica, sans-serif" font-size="${title}" font-weight="700" fill="#3E4C47" text-anchor="middle">${escapeXml(name)}</text>
  <text x="${width / 2}" y="${y + ph + title * 3.4}" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(title * 0.75)}" fill="#5F6C67" text-anchor="middle">Photo ${n}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A sample advertisement: a poster with a tinted gradient, the phone, a big headline and a subline (PNG) */
export async function phonePoster(headline: string, sub: string, n: number, size: Size, hex: string): Promise<Buffer> {
  const [width, height] = size.split('x').map(Number) as [number, number];
  const tint = TINTS[(n + 2) % TINTS.length]!;
  const landscape = width > height;
  const ph = Math.round(height * (landscape ? 0.7 : 0.46));
  const pw = Math.round(ph * 0.48);
  const x = landscape ? Math.round(width * 0.72 - pw / 2) : Math.round((width - pw) / 2);
  const y = landscape ? Math.round((height - ph) / 2) : Math.round(height * 0.42);
  const r = Math.round(pw * 0.14);
  const inset = Math.round(pw * 0.05);
  const textX = landscape ? Math.round(width * 0.07) : width / 2;
  const anchor = landscape ? 'start' : 'middle';
  const textY = landscape ? Math.round(height * 0.46) : Math.round(height * 0.17);
  // the text fits its column (left of the phone on a landscape poster): smaller type, or two lines when that gets too small
  const room = landscape ? x - textX - Math.round(width * 0.04) : Math.round(width * 0.86);
  const want = Math.round(Math.min(width, height) * (landscape ? 0.07 : 0.085));
  let lines = [headline];
  if (headline.length * want * 0.56 * 0.7 > room && headline.includes(' ')) {
    const words = headline.split(' ');
    const off = (i: number) => Math.abs(words.slice(0, i).join(' ').length - headline.length / 2);
    let cut = 1;
    for (let i = 2; i < words.length; i++) if (off(i) < off(cut)) cut = i;
    // a break after a full stop or comma reads better, when it is not far from the middle
    for (let i = 1; i < words.length; i++) if (/[.,]$/.test(words[i - 1]!) && off(i) <= headline.length / 4) cut = i;
    lines = [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
  }
  const longest = Math.max(...lines.map((l) => l.length));
  const big = Math.round(Math.min(want, room / (longest * 0.56)));
  const lineGap = Math.round(big * 1.1);
  const small = Math.round(Math.min(want * 0.48, room / (sub.length * 0.5)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="${tint}"/></linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <circle cx="${x + pw / 2}" cy="${y + ph / 2}" r="${ph * 0.62}" fill="${hex}" fill-opacity="0.12"/>
  <rect x="${x}" y="${y}" width="${pw}" height="${ph}" rx="${r}" fill="${hex}" stroke="#3E4C47" stroke-opacity="0.35" stroke-width="${Math.max(3, Math.round(pw * 0.012))}"/>
  <rect x="${x + inset}" y="${y + inset}" width="${pw - 2 * inset}" height="${ph - 2 * inset}" rx="${Math.round(r * 0.7)}" fill="#FFFFFF" fill-opacity="0.18"/>
  <circle cx="${x + pw * 0.26}" cy="${y + pw * 0.26}" r="${pw * 0.09}" fill="#13201C" fill-opacity="0.35"/>
  ${lines.map((l, i) => `<text x="${textX}" y="${textY + i * lineGap}" font-family="Arial, Helvetica, sans-serif" font-size="${big}" font-weight="700" fill="#13201C" text-anchor="${anchor}">${escapeXml(l)}</text>`).join('\n  ')}
  <text x="${textX}" y="${textY + lines.length * lineGap}" font-family="Arial, Helvetica, sans-serif" font-size="${small}" fill="#44514C" text-anchor="${anchor}">${escapeXml(sub)}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Uploads a sample phone's advertisement posters; answers the adImages input */
async function uploadAds(p: SamplePhone, upload: Uploader): Promise<{ id: string; alt: string }[]> {
  const out: { id: string; alt: string }[] = [];
  for (const [i, ad] of p.ads.entries()) {
    const body = await phonePoster(ad.headline, ad.sub, i + 1, ad.size, p.colors[i % p.colors.length]!.hex);
    out.push({ id: await upload({ purpose: 'content_image', fileName: `${slug(p.name)}-ad-${i + 1}.png`, contentType: 'image/png', body }), alt: `${ad.headline} ${ad.sub}` });
  }
  return out;
}

/** A phone as the admin API answers it */
type PhoneAdminOut = { id: string; slug: string; brand: string; name: string; overview?: string | null; storage: unknown[]; colors: unknown[]; photos: { id: string; alt?: string | null }[]; adImages?: { id: string; alt?: string | null }[]; specGroups: unknown[]; showServices: boolean; searchTerm?: string | null; status: string };

/**
 * Adds the sample phones that are missing (by slug), with their generated photos and advertisement images, and gives
 * an existing sample phone without advertisement images its posters (the whole phone is sent back as it is, plus
 * the images). Answers how many phones it added and how many got their advertisement images.
 */
export async function seedPhones(admin: AdminCall, upload: Uploader): Promise<{ added: number; ads: number }> {
  const existing = (await admin('GET', '/admin/departments/phones')) as { items: PhoneAdminOut[] };
  const bySlug = new Map(existing.items.map((p) => [p.slug, p]));
  let added = 0;
  let ads = 0;
  for (const p of PHONES) {
    const have = bySlug.get(slug(p.name));
    if (have) {
      if (have.adImages?.length || !p.ads.length) continue;
      await admin('PATCH', `/admin/departments/phones/${have.id}`, {
        brand: have.brand,
        name: have.name,
        slug: have.slug,
        overview: have.overview ?? null,
        storage: have.storage,
        colors: have.colors,
        photos: have.photos.map((x) => ({ id: x.id, alt: x.alt ?? null })),
        adImages: await uploadAds(p, upload),
        specGroups: have.specGroups,
        showServices: have.showServices,
        searchTerm: have.searchTerm ?? null,
        status: have.status,
      });
      ads++;
      continue;
    }
    const photos: { id: string; alt: string }[] = [];
    for (const [i, photo] of p.photos.entries()) {
      const body = await phonePhoto(p.name, i + 1, photo.size, p.colors[i % p.colors.length]!.hex);
      photos.push({ id: await upload({ purpose: 'content_image', fileName: `${slug(p.name)}-${i + 1}.png`, contentType: 'image/png', body }), alt: photo.alt });
    }
    await admin('POST', '/admin/departments/phones', {
      brand: p.brand,
      name: p.name,
      overview: p.overview,
      storage: p.storage.map((s) => ({ size: s.size, price: usd(s.price), was: s.was ? usd(s.was) : null })),
      colors: p.colors,
      photos,
      adImages: await uploadAds(p, upload),
      specGroups: p.specGroups.map((g) => ({ name: g.name, rows: g.rows.map(([name, value]) => ({ name, value })) })),
      showServices: p.showServices ?? true,
      status: p.status ?? 'published',
    });
    added++;
  }
  return { added, ads };
}
