/**
 * Built-in centroids for the development geocoder (no network). Coordinates are WGS84 degrees, rounded to 4 places
 * (about 10 m), approximating the populated centre of each ZIP Code area. PO-box-only ZIPs are left out: delivery
 * addresses never use them (PO boxes are refused).
 *
 * ZIP_CENTROIDS: every delivery ZIP of the Portland–Vancouver–Salem dev market (Multnomah, Washington, Clackamas,
 * Columbia, Yamhill, Marion and Polk counties in Oregon; Clark County in Washington), plus downtown Seattle.
 * CITY_CENTROIDS: city-hall-area centroids keyed `city|region` (lower-case city, upper-case state), the fallback when
 * a ZIP is not listed. They cover the cities the seed data and tests use across CA, OR and WA (and the few
 * elsewhere the tests use).
 */

export type LatLng = readonly [lat: number, lng: number];

export const ZIP_CENTROIDS: Readonly<Record<string, LatLng>> = {
  // Portland, OR (city and unincorporated Multnomah / Washington / Clackamas edges)
  '97201': [45.5003, -122.6952], // SW: Portland State, Marquam Hill, Homestead
  '97202': [45.4842, -122.6362], // SE: Sellwood-Moreland, Brooklyn, Eastmoreland, Reed
  '97203': [45.6033, -122.7376], // N: St Johns, Cathedral Park, University Park
  '97204': [45.5176, -122.6748], // Downtown core
  '97205': [45.5194, -122.7046], // Goose Hollow, Arlington Heights
  '97206': [45.4826, -122.5998], // SE: Woodstock, Foster-Powell, Mt Scott
  '97209': [45.5299, -122.6835], // Pearl District, Old Town
  '97210': [45.5459, -122.7318], // NW: Nob Hill, Northwest Industrial, Forest Park
  '97211': [45.5652, -122.6448], // NE: Concordia, Woodlawn, King, Alberta
  '97212': [45.5442, -122.6440], // NE: Irvington, Alameda, Grant Park
  '97213': [45.5376, -122.6006], // NE: Rose City Park, Hollywood east
  '97214': [45.5145, -122.6436], // SE: Buckman, Hawthorne, Sunnyside
  '97215': [45.5150, -122.6006], // SE: Mt Tabor, South Tabor
  '97216': [45.5143, -122.5574], // SE: Montavilla east, Mill Park
  '97217': [45.5946, -122.6943], // N: Kenton, Arbor Lodge, Overlook, Hayden Island
  '97218': [45.5763, -122.6008], // NE: Cully, Sunderland, airport
  '97219': [45.4572, -122.7076], // SW: Multnomah Village, Hillsdale, Markham
  '97220': [45.5501, -122.5594], // NE: Parkrose, Gateway, Madison South
  '97221': [45.4979, -122.7286], // SW: West Hills, Sylvan
  '97222': [45.4400, -122.6168], // Milwaukie
  '97223': [45.4405, -122.7746], // Tigard north, Garden Home, Metzger
  '97224': [45.4054, -122.7952], // Tigard south, King City, Durham
  '97225': [45.5003, -122.7714], // Raleigh Hills, Cedar Hills, West Slope
  '97227': [45.5434, -122.6762], // N: Eliot, Boise, Mississippi
  '97229': [45.5484, -122.8104], // Bethany, Cedar Mill, Rock Creek
  '97230': [45.5574, -122.5047], // NE: Wilkes, Russell, Argay
  '97231': [45.6874, -122.8243], // Sauvie Island, Linnton
  '97232': [45.5289, -122.6436], // NE: Lloyd, Sullivan's Gulch, Kerns north
  '97233': [45.5148, -122.4993], // SE: Rockwood, Centennial, Hazelwood east
  '97236': [45.4826, -122.5094], // SE: Powellhurst-Gilbert, Pleasant Valley
  '97239': [45.4924, -122.6930], // SW: Corbett-Terwilliger, South Waterfront
  '97266': [45.4829, -122.5578], // SE: Lents, Brentwood-Darlington
  '97267': [45.4072, -122.6123], // Oak Grove, Jennings Lodge

  // Washington County
  '97003': [45.5025, -122.8650], // Beaverton / Aloha (Reedville)
  '97005': [45.4914, -122.8036], // Beaverton central
  '97006': [45.5172, -122.8597], // Beaverton / Aloha north (Tanasbourne)
  '97007': [45.4501, -122.8655], // Beaverton / Aloha south
  '97008': [45.4600, -122.8050], // Beaverton south (Murrayhill)
  '97062': [45.3720, -122.7590], // Tualatin
  '97078': [45.4535, -122.8935], // Beaverton / Aloha (Farmington)
  '97106': [45.6600, -123.1100], // Banks
  '97113': [45.5150, -123.0520], // Cornelius
  '97116': [45.5370, -123.1250], // Forest Grove
  '97119': [45.4440, -123.1480], // Gaston
  '97123': [45.4900, -122.9800], // Hillsboro south
  '97124': [45.5540, -122.9300], // Hillsboro north, Orenco
  '97125': [45.6700, -123.1900], // Manning
  '97133': [45.6150, -123.0000], // North Plains
  '97140': [45.3550, -122.8430], // Sherwood
  '97144': [45.7100, -123.2900], // Timber

  // Clackamas County
  '97002': [45.2400, -122.7880], // Aurora
  '97004': [45.2570, -122.4690], // Beavercreek
  '97009': [45.4215, -122.3640], // Boring
  '97011': [45.3500, -122.0300], // Brightwood
  '97013': [45.2240, -122.6720], // Canby
  '97015': [45.4140, -122.5420], // Clackamas
  '97017': [45.1700, -122.4300], // Colton
  '97022': [45.3500, -122.3400], // Eagle Creek
  '97023': [45.2700, -122.3270], // Estacada
  '97027': [45.3880, -122.5940], // Gladstone
  '97034': [45.4090, -122.6830], // Lake Oswego (lake, Old Town, Lake Grove south)
  '97035': [45.4150, -122.7230], // Lake Oswego north (Mountain Park, Lake Grove)
  '97038': [45.1460, -122.5700], // Molalla
  '97042': [45.2160, -122.5420], // Mulino
  '97045': [45.3260, -122.5600], // Oregon City
  '97049': [45.3400, -121.9400], // Rhododendron
  '97055': [45.3800, -122.2400], // Sandy
  '97067': [45.3300, -121.9900], // Welches
  '97068': [45.3530, -122.6450], // West Linn
  '97070': [45.3050, -122.7690], // Wilsonville
  '97086': [45.4430, -122.5260], // Happy Valley
  '97089': [45.4260, -122.4430], // Damascus

  // East Multnomah County
  '97019': [45.5180, -122.2420], // Corbett
  '97024': [45.5440, -122.4410], // Fairview
  '97030': [45.5100, -122.4340], // Gresham central and north
  '97060': [45.5310, -122.3860], // Troutdale, Wood Village
  '97080': [45.4800, -122.3950], // Gresham south

  // Columbia County
  '97018': [45.8900, -122.8100], // Columbia City
  '97051': [45.8560, -122.8350], // St Helens
  '97053': [45.8200, -122.8700], // Warren
  '97056': [45.7660, -122.8930], // Scappoose

  // Yamhill County
  '97101': [45.0900, -123.2200], // Amity
  '97111': [45.2900, -123.1800], // Carlton
  '97114': [45.2200, -123.0800], // Dayton
  '97115': [45.2800, -123.0100], // Dundee
  '97127': [45.2440, -123.1140], // Lafayette
  '97128': [45.2100, -123.2000], // McMinnville
  '97132': [45.3200, -122.9700], // Newberg
  '97148': [45.3500, -123.2000], // Yamhill
  '97378': [45.0700, -123.3900], // Sheridan
  '97396': [45.1000, -123.5000], // Willamina

  // Marion and Polk counties (Salem area)
  '97020': [45.2200, -122.8400], // Donald
  '97026': [45.1100, -122.9000], // Gervais
  '97032': [45.1810, -122.8070], // Hubbard
  '97071': [45.1460, -122.8500], // Woodburn
  '97137': [45.2100, -122.9700], // St Paul
  '97301': [44.9500, -122.9900], // Salem central and northeast
  '97302': [44.9000, -123.0400], // South Salem
  '97303': [45.0100, -123.0250], // Keizer
  '97304': [44.9700, -123.0900], // West Salem
  '97305': [44.9900, -122.9400], // Salem northeast, Hayesville
  '97306': [44.8500, -123.0400], // South Salem, Sunnyslope
  '97317': [44.9000, -122.9300], // Salem southeast
  '97325': [44.8400, -122.8700], // Aumsville
  '97338': [44.9200, -123.3200], // Dallas
  '97344': [44.8700, -123.4700], // Falls City
  '97346': [44.7700, -122.3800], // Gates
  '97351': [44.8500, -123.1900], // Independence
  '97352': [44.7500, -123.0100], // Jefferson
  '97358': [44.8100, -122.4100], // Lyons
  '97360': [44.7500, -122.4700], // Mill City
  '97361': [44.8500, -123.2300], // Monmouth
  '97362': [45.0700, -122.8000], // Mount Angel
  '97371': [44.9800, -123.2100], // Rickreall
  '97375': [45.0300, -122.6700], // Scotts Mills
  '97381': [45.0000, -122.7800], // Silverton
  '97383': [44.8000, -122.7900], // Stayton
  '97385': [44.8300, -122.7900], // Sublimity
  '97392': [44.8400, -122.9500], // Turner

  // Clark County, WA (Vancouver)
  '98601': [45.9200, -122.4500], // Amboy
  '98604': [45.7900, -122.5300], // Battle Ground
  '98606': [45.7300, -122.4600], // Brush Prairie
  '98607': [45.5950, -122.4100], // Camas
  '98629': [45.8700, -122.6300], // La Center
  '98642': [45.8100, -122.7100], // Ridgefield
  '98660': [45.6400, -122.6900], // Vancouver downtown and west
  '98661': [45.6380, -122.6280], // Vancouver central (Fourth Plain to Mill Plain)
  '98662': [45.6850, -122.5800], // Vancouver Orchards west
  '98663': [45.6560, -122.6640], // Vancouver Rose Village, Hudson's Bay
  '98664': [45.6200, -122.5770], // Vancouver east central (Fircrest)
  '98665': [45.6800, -122.6620], // Hazel Dell south
  '98671': [45.5900, -122.3300], // Washougal
  '98674': [45.9100, -122.7400], // Woodland
  '98675': [45.8300, -122.3800], // Yacolt
  '98682': [45.6680, -122.4940], // Vancouver east (Orchards east)
  '98683': [45.6060, -122.5110], // Vancouver Cascade Park south
  '98684': [45.6320, -122.5130], // Vancouver Cascade Park north
  '98685': [45.7130, -122.6870], // Felida
  '98686': [45.7230, -122.6230], // Salmon Creek

  // Seattle, WA (seed data)
  '98101': [47.6114, -122.3305], // Downtown Seattle
};

/** State of a US ZIP by its first digits (only the states the tables above hold) */
export function zipState(zip: string): string | null {
  const p = Number(zip.slice(0, 3));
  if (p >= 970 && p <= 979) return 'OR';
  if (p >= 980 && p <= 994) return 'WA';
  if (p >= 900 && p <= 961) return 'CA';
  return null;
}

export const CITY_CENTROIDS: Readonly<Record<string, LatLng>> = {
  // Oregon: Portland metro
  'portland|OR': [45.5152, -122.6784],
  'beaverton|OR': [45.4871, -122.8037],
  'hillsboro|OR': [45.5229, -122.9898],
  'aloha|OR': [45.4943, -122.8671],
  'gresham|OR': [45.4983, -122.4302],
  'lake oswego|OR': [45.4207, -122.6706],
  'tigard|OR': [45.4312, -122.7715],
  'tualatin|OR': [45.3840, -122.7640],
  'west linn|OR': [45.3657, -122.6123],
  'oregon city|OR': [45.3573, -122.6068],
  'milwaukie|OR': [45.4462, -122.6393],
  'happy valley|OR': [45.4468, -122.5304],
  'clackamas|OR': [45.4076, -122.5704],
  'wilsonville|OR': [45.2998, -122.7737],
  'sherwood|OR': [45.3565, -122.8401],
  'king city|OR': [45.4026, -122.8040],
  'forest grove|OR': [45.5198, -123.1107],
  'cornelius|OR': [45.5199, -123.0598],
  'troutdale|OR': [45.5393, -122.3871],
  'fairview|OR': [45.5385, -122.4339],
  'wood village|OR': [45.5343, -122.4187],
  'gladstone|OR': [45.3807, -122.5948],
  'canby|OR': [45.2629, -122.6926],
  'sandy|OR': [45.3973, -122.2612],
  'estacada|OR': [45.2898, -122.3337],
  'molalla|OR': [45.1476, -122.5768],
  'boring|OR': [45.4301, -122.3748],
  'damascus|OR': [45.4176, -122.4590],
  'north plains|OR': [45.5973, -122.9934],
  'scappoose|OR': [45.7543, -122.8776],
  'st helens|OR': [45.8640, -122.8065],
  'newberg|OR': [45.3001, -122.9732],
  'mcminnville|OR': [45.2101, -123.1987],
  'dundee|OR': [45.2782, -123.0101],
  // Oregon: Salem area and the Willamette Valley
  'salem|OR': [44.9429, -123.0351],
  'keizer|OR': [44.9901, -123.0262],
  'woodburn|OR': [45.1437, -122.8554],
  'silverton|OR': [45.0051, -122.7834],
  'mount angel|OR': [45.0679, -122.8001],
  'dallas|OR': [44.9193, -123.3170],
  'monmouth|OR': [44.8485, -123.2340],
  'independence|OR': [44.8512, -123.1868],
  'stayton|OR': [44.8007, -122.7940],
  'turner|OR': [44.8434, -122.9529],
  'albany|OR': [44.6365, -123.1059],
  'corvallis|OR': [44.5646, -123.2620],
  'lebanon|OR': [44.5365, -122.9070],
  'eugene|OR': [44.0521, -123.0868],
  'springfield|OR': [44.0462, -123.0220],
  // Oregon: rest of the state
  'bend|OR': [44.0582, -121.3153],
  'redmond|OR': [44.2726, -121.1739],
  'medford|OR': [42.3265, -122.8756],
  'ashland|OR': [42.1946, -122.7095],
  'grants pass|OR': [42.4390, -123.3284],
  'klamath falls|OR': [42.2249, -121.7817],
  'roseburg|OR': [43.2165, -123.3417],
  'hood river|OR': [45.7054, -121.5215],
  'the dalles|OR': [45.5946, -121.1787],
  'astoria|OR': [46.1879, -123.8313],
  'seaside|OR': [45.9932, -123.9226],
  'cannon beach|OR': [45.8918, -123.9615],
  'tillamook|OR': [45.4562, -123.8440],
  'newport|OR': [44.6368, -124.0535],
  'lincoln city|OR': [44.9582, -124.0179],
  'coos bay|OR': [43.3665, -124.2179],
  'pendleton|OR': [45.6721, -118.7886],
  'hermiston|OR': [45.8404, -119.2895],
  'la grande|OR': [45.3246, -118.0877],
  'ontario|OR': [44.0266, -116.9629],
  'baker city|OR': [44.7749, -117.8344],
  // Washington: Clark County and southwest
  'vancouver|WA': [45.6387, -122.6615],
  'camas|WA': [45.5871, -122.3995],
  'washougal|WA': [45.5826, -122.3534],
  'battle ground|WA': [45.7807, -122.5334],
  'brush prairie|WA': [45.7332, -122.5462],
  'ridgefield|WA': [45.8151, -122.7426],
  'la center|WA': [45.8623, -122.6704],
  'woodland|WA': [45.9045, -122.7437],
  'yacolt|WA': [45.8657, -122.4065],
  'longview|WA': [46.1382, -122.9382],
  'kelso|WA': [46.1468, -122.9084],
  // Washington: rest of the state
  'seattle|WA': [47.6062, -122.3321],
  'tacoma|WA': [47.2529, -122.4443],
  'bellevue|WA': [47.6101, -122.2015],
  'redmond|WA': [47.6740, -122.1215],
  'kirkland|WA': [47.6815, -122.2087],
  'everett|WA': [47.9790, -122.2021],
  'olympia|WA': [47.0379, -122.9007],
  'spokane|WA': [47.6588, -117.4260],
  'yakima|WA': [46.6021, -120.5059],
  'kennewick|WA': [46.2112, -119.1372],
  'pasco|WA': [46.2396, -119.1006],
  'richland|WA': [46.2857, -119.2845],
  'bellingham|WA': [48.7519, -122.4787],
  'wenatchee|WA': [47.4235, -120.3103],
  'walla walla|WA': [46.0646, -118.3430],
  // California
  'los angeles|CA': [34.0522, -118.2437],
  'san francisco|CA': [37.7749, -122.4194],
  'oakland|CA': [37.8044, -122.2712],
  'berkeley|CA': [37.8715, -122.2730],
  'san jose|CA': [37.3382, -121.8863],
  'san diego|CA': [32.7157, -117.1611],
  'sacramento|CA': [38.5816, -121.4944],
  'fresno|CA': [36.7378, -119.7871],
  'long beach|CA': [33.7701, -118.1937],
  'santa monica|CA': [34.0195, -118.4912],
  'pasadena|CA': [34.1478, -118.1445],
  'irvine|CA': [33.6846, -117.8265],
  'anaheim|CA': [33.8366, -117.9143],
  'santa barbara|CA': [34.4208, -119.6982],
  'redding|CA': [40.5865, -122.3917],
  'eureka|CA': [40.8021, -124.1637],
  'chico|CA': [39.7285, -121.8375],
  // Elsewhere (test data)
  'reno|NV': [39.5296, -119.8138],
  'sparks|NV': [39.5349, -119.7527],
  'austin|TX': [30.2672, -97.7431],
  'salt lake city|UT': [40.7608, -111.8910],
  'anchorage|AK': [61.2181, -149.9003],
};
