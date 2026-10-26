/**
 * Proposal Engine (Layer 2 Model Grounding).
 *
 * Pure deterministic engine for evaluating StoredReportRevisions (from L1
 * PetaBencana GeoJSON and ANTARA News RSS) and producing schema 2.0
 * EventProposalDto records for downstream database persistence (L2 writer)
 * and moderator review (L4).
 */

export interface StoredEvidenceChunk {
  readonly chunk_index: number;
  readonly text: string;
  readonly span_start: number;
  readonly span_end: number;
}

export interface StoredReportRevision {
  readonly report_revision_id: string;
  readonly source_id: string;
  readonly canonical_url: string;
  readonly permitted_text: string;
  readonly permitted_text_hash: string;
  readonly published_at: string | null;
  readonly retrieved_at: string;
  readonly revision_status: "unreviewed";
  readonly chunks: readonly StoredEvidenceChunk[];
}

export type IncidentCategory = "flood" | "fire" | "accident" | "tree_fall" | "crime" | "weather";
export type IncidentSeverity = "low" | "medium" | "high" | "critical";

export interface EventProposalClaimDto {
  readonly claim_id: string;
  readonly claim_text: string;
  readonly evidence_label: "under_review";
  readonly support_assessment: "supported";
  readonly quote_text: string;
  readonly evidence_ref_id: string;
}

export interface EventProposalDto {
  readonly schema_version: "2.0";
  readonly proposal_id: string;
  readonly title: string;
  readonly incident_type: IncidentCategory;
  readonly severity: IncidentSeverity;
  readonly event_time: {
    readonly precision: "exact" | "date" | "range" | "unknown";
    readonly value: string;
  };
  readonly location_label: string;
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  readonly claims: readonly EventProposalClaimDto[];
  readonly proposed_at: string;
}

export interface ProposalEngineOptions {
  readonly proposedAt?: string;
}

/**
 * Bounding box envelope for DKI Jakarta and surrounding urban area.
 * [minLng, minLat, maxLng, maxLat]
 */
export const JAKARTA_ENVELOPE = {
  west: 106.32,
  south: -6.40,
  east: 106.98,
  north: -5.16,
} as const;

interface GazetteerPlace {
  readonly name: string;
  readonly label: string;
  readonly coordinates: readonly [longitude: number, latitude: number];
  readonly patterns: readonly RegExp[];
}

/**
 * Gazetteer mapping Jakarta regions, kecamatans, and prominent corridors
 * to representative WGS84 [longitude, latitude] coordinates.
 */
const JAKARTA_GAZETTEER: readonly GazetteerPlace[] = [
  // Jakarta Pusat
  { name: "Senen", label: "Senen, Jakarta Pusat", coordinates: [106.8442, -6.1823], patterns: [/\b(?:pasar\s+)?senen\b/i] },
  { name: "Gambir", label: "Gambir, Jakarta Pusat", coordinates: [106.8302, -6.1754], patterns: [/\bgambir\b/i] },
  { name: "Sawah Besar", label: "Sawah Besar, Jakarta Pusat", coordinates: [106.8322, -6.1550], patterns: [/\bsawah\s+besar\b/i] },
  { name: "Kemayoran", label: "Kemayoran, Jakarta Pusat", coordinates: [106.8550, -6.1600], patterns: [/\bkemayoran\b/i] },
  { name: "Cempaka Putih", label: "Cempaka Putih, Jakarta Pusat", coordinates: [106.8680, -6.1830], patterns: [/\bcempaka\s+putih\b/i] },
  { name: "Menteng", label: "Menteng, Jakarta Pusat", coordinates: [106.8320, -6.1960], patterns: [/\bmenteng\b/i] },
  { name: "Tanah Abang", label: "Tanah Abang, Jakarta Pusat", coordinates: [106.8150, -6.1900], patterns: [/\btanah\s+abang\b/i] },
  { name: "Johar Baru", label: "Johar Baru, Jakarta Pusat", coordinates: [106.8580, -6.1850], patterns: [/\bjohar\s+baru\b/i] },
  { name: "Harmoni", label: "Harmoni, Jakarta Pusat", coordinates: [106.8190, -6.1630], patterns: [/\bharmoni\b/i] },
  { name: "Monas", label: "Monas, Jakarta Pusat", coordinates: [106.8272, -6.1754], patterns: [/\bmonas\b/i] },

  // Jakarta Selatan
  { name: "Kebayoran Baru", label: "Kebayoran Baru, Jakarta Selatan", coordinates: [106.7990, -6.2440], patterns: [/\bkebayoran\s+baru\b/i, /\bblok\s+m\b/i] },
  { name: "Kebayoran Lama", label: "Kebayoran Lama, Jakarta Selatan", coordinates: [106.7770, -6.2420], patterns: [/\bkebayoran\s+lama\b/i] },
  { name: "Pesanggrahan", label: "Pesanggrahan, Jakarta Selatan", coordinates: [106.7620, -6.2570], patterns: [/\bpesanggrahan\b/i] },
  { name: "Cilandak", label: "Cilandak, Jakarta Selatan", coordinates: [106.7970, -6.2930], patterns: [/\bcilandak\b/i, /\bfatmawati\b/i] },
  { name: "Pasar Minggu", label: "Pasar Minggu, Jakarta Selatan", coordinates: [106.8330, -6.2840], patterns: [/\bpasar\s+minggu\b/i] },
  { name: "Jagakarsa", label: "Jagakarsa, Jakarta Selatan", coordinates: [106.8250, -6.3330], patterns: [/\bjagakarsa\b/i] },
  { name: "Mampang Prapatan", label: "Mampang Prapatan, Jakarta Selatan", coordinates: [106.8250, -6.2500], patterns: [/\bmampang(?:\s+prapatan)?\b/i] },
  { name: "Pancoran", label: "Pancoran, Jakarta Selatan", coordinates: [106.8450, -6.2500], patterns: [/\bpancoran\b/i, /\bkalibata\b/i] },
  { name: "Tebet", label: "Tebet, Jakarta Selatan", coordinates: [106.8570, -6.2290], patterns: [/\btebet\b/i] },
  { name: "Setiabudi", label: "Setiabudi, Jakarta Selatan", coordinates: [106.8290, -6.2150], patterns: [/\bsetiabudi\b/i, /\bkuningan\b/i] },

  // Jakarta Barat
  { name: "Cengkareng", label: "Cengkareng, Jakarta Barat", coordinates: [106.7320, -6.1520], patterns: [/\bcengkareng\b/i] },
  { name: "Grogol Petamburan", label: "Grogol Petamburan, Jakarta Barat", coordinates: [106.7870, -6.1650], patterns: [/\bgrogol(?:\s+petamburan)?\b/i, /\btomang\b/i] },
  { name: "Taman Sari", label: "Taman Sari, Jakarta Barat", coordinates: [106.8170, -6.1450], patterns: [/\btaman\s+sari\b/i] },
  { name: "Tambora", label: "Tambora, Jakarta Barat", coordinates: [106.8040, -6.1480], patterns: [/\btambora\b/i] },
  { name: "Kebon Jeruk", label: "Kebon Jeruk, Jakarta Barat", coordinates: [106.7720, -6.1940], patterns: [/\bkebon\s+jeruk\b/i] },
  { name: "Kalideres", label: "Kalideres, Jakarta Barat", coordinates: [106.7020, -6.1500], patterns: [/\bkalideres\b/i] },
  { name: "Palmerah", label: "Palmerah, Jakarta Barat", coordinates: [106.7950, -6.1980], patterns: [/\bpalmerah\b/i, /\bslipi\b/i] },
  { name: "Kembangan", label: "Kembangan, Jakarta Barat", coordinates: [106.7450, -6.1880], patterns: [/\bkembangan\b/i, /\bpuri\s+indah\b/i] },

  // Jakarta Timur
  { name: "Rawamangun", label: "Rawamangun, Jakarta Timur", coordinates: [106.8870, -6.1950], patterns: [/\brawamangun\b/i] },
  { name: "Pulo Gadung", label: "Pulo Gadung, Jakarta Timur", coordinates: [106.8920, -6.1920], patterns: [/\bpulo\s*gadung\b/i] },
  { name: "Matraman", label: "Matraman, Jakarta Timur", coordinates: [106.8620, -6.2050], patterns: [/\bmatraman\b/i] },
  { name: "Jatinegara", label: "Jatinegara, Jakarta Timur", coordinates: [106.8710, -6.2280], patterns: [/\bjatinegara\b/i, /\bkampung\s+melayu\b/i, /\bbidara\s+cina\b/i] },
  { name: "Duren Sawit", label: "Duren Sawit, Jakarta Timur", coordinates: [106.9150, -6.2340], patterns: [/\bduren\s+sawit\b/i] },
  { name: "Kramat Jati", label: "Kramat Jati, Jakarta Timur", coordinates: [106.8680, -6.2750], patterns: [/\bkramat\s+jati\b/i] },
  { name: "Makasar", label: "Makasar, Jakarta Timur", coordinates: [106.8830, -6.2750], patterns: [/\bmakasar\b/i, /\bhalim(?:\s+perdanakusuma)?\b/i] },
  { name: "Pasar Rebo", label: "Pasar Rebo, Jakarta Timur", coordinates: [106.8600, -6.3150], patterns: [/\bpasar\s+rebo\b/i] },
  { name: "Ciracas", label: "Ciracas, Jakarta Timur", coordinates: [106.8780, -6.3300], patterns: [/\bciracas\b/i] },
  { name: "Cipayung", label: "Cipayung, Jakarta Timur", coordinates: [106.8950, -6.3150], patterns: [/\bcipayung\b/i] },
  { name: "Cakung", label: "Cakung, Jakarta Timur", coordinates: [106.9480, -6.1920], patterns: [/\bcakung\b/i] },
  { name: "Cawang", label: "Cawang, Jakarta Timur", coordinates: [106.8670, -6.2480], patterns: [/\bcawang\b/i, /\btol\s+cawang\b/i] },

  // Jakarta Utara
  { name: "Kelapa Gading", label: "Kelapa Gading, Jakarta Utara", coordinates: [106.9080, -6.1580], patterns: [/\bkelapa\s+gading\b/i] },
  { name: "Tanjung Priok", label: "Tanjung Priok, Jakarta Utara", coordinates: [106.8820, -6.1180], patterns: [/\btanjung\s+priok\b/i] },
  { name: "Koja", label: "Koja, Jakarta Utara", coordinates: [106.9050, -6.1250], patterns: [/\bkoja\b/i] },
  { name: "Pademangan", label: "Pademangan, Jakarta Utara", coordinates: [106.8400, -6.1330], patterns: [/\bpademangan\b/i, /\bancol\b/i] },
  { name: "Penjaringan", label: "Penjaringan, Jakarta Utara", coordinates: [106.7900, -6.1280], patterns: [/\bpenjaringan\b/i, /\bpluit\b/i, /\bmuara\s+(?:baru|angke)\b/i] },
  { name: "Cilincing", label: "Cilincing, Jakarta Utara", coordinates: [106.9380, -6.1250], patterns: [/\bcilincing\b/i, /\bmarunda\b/i] },
  { name: "Sunter", label: "Sunter, Jakarta Utara", coordinates: [106.8750, -6.1400], patterns: [/\bsunter\b/i] },

  // Prominent Corridors & Highways
  { name: "Sudirman", label: "Sudirman, Jakarta Pusat", coordinates: [106.8230, -6.2080], patterns: [/\b(?:jl\.?|jalan\s+)?sudirman\b/i] },
  { name: "Thamrin", label: "Thamrin, Jakarta Pusat", coordinates: [106.8240, -6.1920], patterns: [/\b(?:jl\.?|jalan\s+)?thamrin\b/i] },
  { name: "Gatot Subroto", label: "Gatot Subroto, Jakarta Selatan", coordinates: [106.8250, -6.2350], patterns: [/\b(?:jl\.?|jalan\s+)?gatot\s+subroto\b/i] },
  { name: "Rasuna Said", label: "Rasuna Said, Jakarta Selatan", coordinates: [106.8310, -6.2190], patterns: [/\b(?:jl\.?|jalan\s+)?rasuna\s+said\b/i] },
  { name: "MT Haryono", label: "MT Haryono, Jakarta Timur", coordinates: [106.8650, -6.2430], patterns: [/\b(?:jl\.?|jalan\s+)?mt\s+haryono\b/i] },
  { name: "Daan Mogot", label: "Daan Mogot, Jakarta Barat", coordinates: [106.7500, -6.1550], patterns: [/\b(?:jl\.?|jalan\s+)?daan\s+mogot\b/i] },

  // Administrative City Names (broad fallbacks)
  { name: "Jakarta Pusat", label: "Jakarta Pusat", coordinates: [106.8456, -6.1823], patterns: [/\bjakarta\s+pusat\b/i, /\bjakpus\b/i] },
  { name: "Jakarta Selatan", label: "Jakarta Selatan", coordinates: [106.8000, -6.2600], patterns: [/\bjakarta\s+selatan\b/i, /\bjaksel\b/i] },
  { name: "Jakarta Barat", label: "Jakarta Barat", coordinates: [106.7550, -6.1680], patterns: [/\bjakarta\s+barat\b/i, /\bjakbar\b/i] },
  { name: "Jakarta Timur", label: "Jakarta Timur", coordinates: [106.8850, -6.2250], patterns: [/\bjakarta\s+timur\b/i, /\bjaktim\b/i] },
  { name: "Jakarta Utara", label: "Jakarta Utara", coordinates: [106.8850, -6.1250], patterns: [/\bjakarta\s+utara\b/i, /\bjakut\b/i] },
  { name: "Kepulauan Seribu", label: "Kepulauan Seribu", coordinates: [106.5600, -5.6000], patterns: [/\bkepulauan\s+seribu\b/i] },
  { name: "DKI Jakarta", label: "DKI Jakarta", coordinates: [106.8272, -6.1754], patterns: [/\bdki\s+jakarta\b/i, /\bjakarta\b/i] },
];

/**
 * Non-Jakarta location patterns for rejecting off-topic news/reports
 * that occur completely outside Jakarta jurisdiction.
 */
const NON_JAKARTA_CITIES: readonly RegExp[] = [
  /\bpadang\s+pariaman\b/i,
  /\bpadang\b/i,
  /\bbandung\b/i,
  /\bsurabaya\b/i,
  /\bmedan\b/i,
  /\bsemarang\b/i,
  /\bmakassar\b/i,
  /\bpalembang\b/i,
  /\bdenpasar\b/i,
  /\byogyakarta\b/i,
  /\bsolo\b/i,
  /\bmalang\b/i,
  /\bbalikpapan\b/i,
  /\bsamarinda\b/i,
  /\bbanjarmasin\b/i,
  /\bpontianak\b/i,
  /\bmanado\b/i,
  /\bpekanbaru\b/i,
  /\bbogor\b/i,
  /\bdepok\b/i,
  /\btangerang(?!\s+selatan)\b/i,
  /\bbekasi\b/i,
  /\bcianjur\b/i,
  /\bsukabumi\b/i,
  /\bgarut\b/i,
  /\btasikmalaya\b/i,
];

interface CategoryDefinition {
  readonly category: IncidentCategory;
  readonly defaultTitlePrefix: string;
  readonly patterns: readonly { readonly regex: RegExp; readonly weight: number }[];
}

const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  {
    category: "tree_fall",
    defaultTitlePrefix: "Pohon Tumbang",
    patterns: [
      { regex: /\bpohon\s+tumbang\b/i, weight: 20 },
      { regex: /\bpohon\s+roboh\b/i, weight: 18 },
      { regex: /\bdahan\s+tumbang\b/i, weight: 16 },
      { regex: /\bdahan\s+patah\b/i, weight: 14 },
      { regex: /\bbatang\s+pohon\s+(?:tumbang|roboh)\b/i, weight: 18 },
      { regex: /\bmenimpa\s+(?:mobil|motor|kendaraan|kabel)\b/i, weight: 6 },
    ],
  },
  {
    category: "fire",
    defaultTitlePrefix: "Kebakaran",
    patterns: [
      { regex: /\bkebakaran\b/i, weight: 20 },
      { regex: /\bapi\s+melahap\b/i, weight: 18 },
      { regex: /\bsi\s+jago\s+merah\b/i, weight: 18 },
      { regex: /\bkobaran\s+api\b/i, weight: 16 },
      { regex: /\bterbakar\b/i, weight: 12 },
      { regex: /\bhangus\b/i, weight: 10 },
      { regex: /\bdamkar\b/i, weight: 10 },
      { regex: /\bgulkarmat\b/i, weight: 10 },
      { regex: /\bpemadam\s+kebakaran\b/i, weight: 12 },
    ],
  },
  {
    category: "accident",
    defaultTitlePrefix: "Kecelakaan Lalu Lintas",
    patterns: [
      { regex: /\bkecelakaan\b/i, weight: 20 },
      { regex: /\blaka\s+lantas\b/i, weight: 20 },
      { regex: /\btabrakan\s+beruntun\b/i, weight: 18 },
      { regex: /\btabrakan\b/i, weight: 16 },
      { regex: /\bterguling\b/i, weight: 14 },
      { regex: /\badu\s+banteng\b/i, weight: 16 },
      { regex: /\bmenabrak\b/i, weight: 10 },
      { regex: /\btertabrak\b/i, weight: 10 },
      { regex: /\bterperosok\b/i, weight: 10 },
    ],
  },
  {
    category: "flood",
    defaultTitlePrefix: "Banjir",
    patterns: [
      { regex: /\bbanjir\b/i, weight: 20 },
      { regex: /\bgenangan(?:\s+air)?\b/i, weight: 16 },
      { regex: /\btergenang\b/i, weight: 16 },
      { regex: /\brob\b/i, weight: 14 },
      { regex: /\btanggul\s+jebol\b/i, weight: 18 },
      { regex: /\bluapan\s+kali\b/i, weight: 16 },
      { regex: /\bketinggian\s+air\b/i, weight: 12 },
      { regex: /\bpintu\s+air\b/i, weight: 10 },
      { regex: /\bmuka\s+air\b/i, weight: 10 },
    ],
  },
  {
    category: "crime",
    defaultTitlePrefix: "Gangguan Keamanan",
    patterns: [
      { regex: /\btawuran\b/i, weight: 20 },
      { regex: /\bbentrokan\b/i, weight: 18 },
      { regex: /\bbegal\b/i, weight: 18 },
      { regex: /\bpenusukan\b/i, weight: 18 },
      { regex: /\bpembunuhan\b/i, weight: 18 },
      { regex: /\bperampokan\b/i, weight: 16 },
      { regex: /\bpencurian\b/i, weight: 14 },
      { regex: /\bcuranmor\b/i, weight: 14 },
      { regex: /\bpenganiayaan\b/i, weight: 14 },
      { regex: /\bsenjata\s+tajam\b/i, weight: 12 },
    ],
  },
  {
    category: "weather",
    defaultTitlePrefix: "Cuaca Ekstrem",
    patterns: [
      { regex: /\bcuaca\s+ekstrem\b/i, weight: 20 },
      { regex: /\bangin\s+puting\s+beliung\b/i, weight: 18 },
      { regex: /\bputing\s+beliung\b/i, weight: 18 },
      { regex: /\bangin\s+kencang\b/i, weight: 16 },
      { regex: /\bhujan\s+lebat\b/i, weight: 14 },
      { regex: /\bhujan\s+deras\b/i, weight: 14 },
      { regex: /\bbadai\b/i, weight: 14 },
      { regex: /\blongsor\b/i, weight: 16 },
      { regex: /\bamblas\b/i, weight: 16 },
    ],
  },
];

/**
 * Extracts category and scores for a given text.
 */
function detectIncidentCategory(text: string): { readonly category: IncidentCategory; readonly score: number } | null {
  let bestCategory: IncidentCategory | null = null;
  let bestScore = 0;

  for (const def of CATEGORY_DEFINITIONS) {
    let score = 0;
    for (const pat of def.patterns) {
      if (pat.regex.test(text)) {
        score += pat.weight;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = def.category;
    }
  }

  if (bestCategory === null || bestScore <= 0) {
    return null;
  }

  return { category: bestCategory, score: bestScore };
}

/**
 * Evaluates incident severity based on text markers.
 */
function detectSeverity(text: string): IncidentSeverity {
  const lower = text.toLowerCase();

  // 1. Critical markers
  const criticalPatterns = [
    /\b(tewas|meninggal|korban\s+jiwa|jiwa\s+melayang|merenggut\s+nyawa)\b/,
    /\b(siaga\s+1|siaga\s+satu)\b/,
    /\b(kebakaran\s+hebat|ludes\s+terbakar|rata\s+dengan\s+tanah)\b/,
    /\b(ratusan\s+rumah\s+(?:terendam|tenggelam|hangus))\b/,
    /\b(puluhan\s+rumah\s+(?:hangus|ludes|terbakar))\b/,
    /\b([2-9]\s*meter|200\s*cm|[2-9][0-9]{2}\s*cm)\b/,
  ];
  for (const p of criticalPatterns) {
    if (p.test(lower)) return "critical";
  }

  // 2. High markers
  const highPatterns = [
    /\b(luka\s+berat|luka\s+parah|kritis|dilarikan\s+ke\s+rumah\s+sakit|dilarikan\s+ke\s+rs)\b/,
    /\b(siaga\s+2|siaga\s+dua)\b/,
    /\b(1\s*meter|1[.,]5\s*meter|1[0-9]{2}\s*cm)\b/,
    /\b(lumpuh\s+total|terputus\s+total|evakuasi\s+warga|ratusan\s+warga\s+mengungsi)\b/,
    /\b(belasan\s+rumah\s+terbakar|puluhan\s+kios\s+terbakar)\b/,
    /\b(tabrakan\s+beruntun|ringsek\s+berat)\b/,
  ];
  for (const p of highPatterns) {
    if (p.test(lower)) return "high";
  }

  // 3. Low markers
  const lowPatterns = [
    /\b(siaga\s+4|siaga\s+empat)\b/,
    /\b([1-3][0-9]\s*cm|semata\s+kaki|dangkal|genangan\s+tipis)\b/,
    /\b(cepat\s+surut|berangsur\s+surut|sudah\s+surut)\b/,
    /\b(dapat\s+dilalui|bisa\s+dilalui\s+kendaraan|lancar)\b/,
    /\b(nihil\s+korban|tidak\s+ada\s+korban|hanya\s+dahan\s+kecil)\b/,
  ];
  for (const p of lowPatterns) {
    if (p.test(lower)) return "low";
  }

  // 4. Default moderate severity
  return "medium";
}

/**
 * Extracts physical event time and precision from text or fallback timestamps.
 */
function extractEventTime(
  text: string,
  publishedAt: string | null,
  retrievedAt: string,
): { readonly precision: "exact" | "date" | "range" | "unknown"; readonly value: string } {
  // 1. Time range in text: "dari jam 10.00 hingga 14.00" or "antara 08.00 - 11.00"
  const rangeMatch = text.match(/\b(?:antara|sejak|dari)\s*(?:pukul|jam)?\s*([0-2]?[0-9][.:][0-5][0-9])\s*(?:hingga|sampai|-)\s*(?:pukul|jam)?\s*([0-2]?[0-9][.:][0-5][0-9])/i);
  if (rangeMatch) {
    return { precision: "range", value: rangeMatch[0] };
  }

  // 2. Exact clock time in text: "pukul 14.30 WIB" or "jam 03.15"
  const clockMatch = text.match(/\b(?:pukul|jam)\s*([0-2]?[0-9])[.:]([0-5][0-9])(?:\s*wib)?/i);
  if (clockMatch && clockMatch[1] && clockMatch[2]) {
    const hours = clockMatch[1].padStart(2, "0");
    const minutes = clockMatch[2].padStart(2, "0");
    const baseDate = publishedAt ? publishedAt.slice(0, 10) : retrievedAt ? retrievedAt.slice(0, 10) : null;
    if (baseDate && /^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
      return {
        precision: "exact",
        value: `${baseDate}T${hours}:${minutes}:00+07:00`,
      };
    }
  }

  // 3. Explicit ISO timestamp in text
  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/);
  if (isoMatch && isoMatch[1]) {
    return { precision: "exact", value: isoMatch[1] };
  }

  // 4. Indonesian long date: "26 Oktober 2026"
  const monthMap: Record<string, string> = {
    januari: "01", februari: "02", maret: "03", april: "04", mei: "05", juni: "06",
    juli: "07", agustus: "08", september: "09", oktober: "10", november: "11", desember: "12",
  };
  const indonesianDateMatch = text.match(/\b([0-3]?[0-9])\s+(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+(\d{4})\b/i);
  if (indonesianDateMatch && indonesianDateMatch[1] && indonesianDateMatch[2] && indonesianDateMatch[3]) {
    const day = indonesianDateMatch[1].padStart(2, "0");
    const month = monthMap[indonesianDateMatch[2].toLowerCase()] ?? "01";
    const year = indonesianDateMatch[3];
    return { precision: "date", value: `${year}-${month}-${day}` };
  }

  // 5. Short ISO date in text: "2026-10-26"
  const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (dateMatch && dateMatch[1]) {
    return { precision: "date", value: dateMatch[1] };
  }

  // 6. Fallback to published_at or retrieved_at
  if (publishedAt) {
    return { precision: "exact", value: publishedAt };
  }

  if (retrievedAt) {
    return { precision: "exact", value: retrievedAt };
  }

  return { precision: "unknown", value: "unknown" };
}

/**
 * Extracts Jakarta location label and coordinates, or null if outside Jakarta.
 */
function extractLocation(
  text: string,
  sourceId: string,
): { readonly locationLabel: string; readonly coordinates: readonly [longitude: number, latitude: number] | null } | null {
  // Check if text has explicit coordinates in GeoJSON / text format
  const coordRegex = /\[\s*([0-9.]+)\s*,\s*(-?[0-9.]+)\s*\]/;
  const coordMatch = text.match(coordRegex);
  let explicitCoords: [number, number] | null = null;
  if (coordMatch && coordMatch[1] && coordMatch[2]) {
    const p1 = Number(coordMatch[1]);
    const p2 = Number(coordMatch[2]);
    let lng: number | null = null;
    let lat: number | null = null;
    if (p1 >= JAKARTA_ENVELOPE.west && p1 <= JAKARTA_ENVELOPE.east && p2 >= JAKARTA_ENVELOPE.south && p2 <= JAKARTA_ENVELOPE.north) {
      lng = p1;
      lat = p2;
    } else if (p2 >= JAKARTA_ENVELOPE.west && p2 <= JAKARTA_ENVELOPE.east && p1 >= JAKARTA_ENVELOPE.south && p1 <= JAKARTA_ENVELOPE.north) {
      lng = p2;
      lat = p1;
    }
    if (lng !== null && lat !== null) {
      explicitCoords = [lng, lat];
    }
  }

  // Check gazetteer matches
  let matchedPlace: GazetteerPlace | null = null;
  for (const place of JAKARTA_GAZETTEER) {
    for (const pat of place.patterns) {
      if (pat.test(text)) {
        matchedPlace = place;
        break;
      }
    }
    if (matchedPlace) break;
  }

  // Check if report explicitly mentions a non-Jakarta city and NO Jakarta place was found
  if (!matchedPlace) {
    for (const nonJkt of NON_JAKARTA_CITIES) {
      if (nonJkt.test(text)) {
        // Outside Jakarta
        return null;
      }
    }
  }

  if (matchedPlace) {
    return {
      locationLabel: matchedPlace.label,
      coordinates: explicitCoords ?? matchedPlace.coordinates,
    };
  }

  // If source is known to be Jakarta-scoped (e.g. antara-metro or petabencana with Jakarta coords)
  const isJakartaSource = sourceId.includes("jakarta") || sourceId.includes("metro") || sourceId.includes("petabencana");
  if (isJakartaSource) {
    return {
      locationLabel: "DKI Jakarta",
      coordinates: explicitCoords ?? [106.8272, -6.1754],
    };
  }

  return null;
}

/**
 * Extracts an exact substring from chunkText that best represents the evidence.
 * Guarantees that chunkText.includes(quote) is strictly true.
 */
function extractExactQuote(chunkText: string, keywords: readonly string[]): string {
  if (!chunkText || chunkText.trim().length === 0) {
    return chunkText;
  }

  // Break chunk into candidate sentences or clauses
  const rawSentences = chunkText.split(/(?<=[.!?\n])\s+/);
  let bestQuote = "";
  let bestScore = -1;

  for (const raw of rawSentences) {
    const trimmed = raw.trim();
    if (trimmed.length < 10) continue;
    if (!chunkText.includes(trimmed)) continue;

    let score = 0;
    const lower = trimmed.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += kw.length;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestQuote = trimmed;
    }
  }

  if (bestQuote && chunkText.includes(bestQuote)) {
    return bestQuote;
  }

  const trimmedWhole = chunkText.trim();
  if (chunkText.includes(trimmedWhole)) {
    return trimmedWhole;
  }

  return chunkText;
}

/**
 * Generates an appropriate Indonesian title based on category, location, and severity.
 */
function generateTitle(category: IncidentCategory, locationLabel: string, severity: IncidentSeverity): string {
  let categoryName: string;
  switch (category) {
    case "flood":
      categoryName = severity === "low" ? "Genangan Air" : "Banjir";
      break;
    case "fire":
      categoryName = "Kebakaran";
      break;
    case "accident":
      categoryName = "Kecelakaan Lalu Lintas";
      break;
    case "tree_fall":
      categoryName = "Pohon Tumbang";
      break;
    case "crime":
      categoryName = "Gangguan Keamanan";
      break;
    case "weather":
      categoryName = "Cuaca Ekstrem";
      break;
  }
  return `${categoryName} di ${locationLabel}`;
}

/**
 * Resolves chunks from StoredReportRevision safely.
 */
function resolveReportChunks(report: StoredReportRevision): readonly StoredEvidenceChunk[] {
  if (Array.isArray(report.chunks) && report.chunks.length > 0) {
    return report.chunks;
  }
  const reportObj: unknown = report;
  if (reportObj && typeof reportObj === "object" && "evidence_chunks" in reportObj) {
    const legacyChunks = reportObj.evidence_chunks;
    if (Array.isArray(legacyChunks) && legacyChunks.length > 0) {
      return legacyChunks as readonly StoredEvidenceChunk[];
    }
  }
  if (typeof report.permitted_text === "string" && report.permitted_text.trim().length > 0) {
    return [
      {
        chunk_index: 0,
        text: report.permitted_text,
        span_start: 0,
        span_end: Array.from(report.permitted_text).length,
      },
    ];
  }
  return [];
}

/**
 * Generates 1 to 3 structured proposal claims grounded in the report chunks.
 */
function createClaims(
  reportRevisionId: string,
  chunks: readonly StoredEvidenceChunk[],
  category: IncidentCategory,
  locationLabel: string,
  severity: IncidentSeverity,
): readonly EventProposalClaimDto[] {
  const claims: EventProposalClaimDto[] = [];
  const searchKeywords = [category, locationLabel.split(",")[0] ?? "", "ketinggian", "kerusakan", "korban", "petugas", "evakuasi"];

  // Sort chunks by keyword density
  const scoredChunks = chunks.map((chunk) => {
    let score = 0;
    const lower = chunk.text.toLowerCase();
    for (const kw of searchKeywords) {
      if (kw && lower.includes(kw.toLowerCase())) {
        score += 1;
      }
    }
    return { chunk, score };
  }).sort((a, b) => b.score - a.score);

  // Strategy 1: If we have multiple chunks, assign up to 3 claims across distinct chunks in sequential order
  if (scoredChunks.length > 1) {
    const selectedChunks = scoredChunks.slice(0, 3).sort((a, b) => a.chunk.chunk_index - b.chunk.chunk_index);
    for (let i = 0; i < selectedChunks.length; i++) {
      const { chunk } = selectedChunks[i]!;
      const quoteText = extractExactQuote(chunk.text, searchKeywords);
      if (!quoteText) continue;

      let claimText: string;
      if (i === 0) {
        claimText = `${generateTitle(category, locationLabel, severity)} dilaporkan terjadi di lokasi.`;
      } else if (i === 1) {
        claimText = `Tingkat keparahan insiden tergolong ${severity} dengan dampak gangguan di lokasi kejadian.`;
      } else {
        claimText = `Upaya pemantauan dan koordinasi penanganan dilakukan terhadap insiden di ${locationLabel}.`;
      }

      claims.push({
        claim_id: `claim-${claims.length + 1}`,
        claim_text: claimText,
        evidence_label: "under_review",
        support_assessment: "supported",
        quote_text: quoteText,
        evidence_ref_id: `ref-${reportRevisionId}-${chunk.chunk_index}`,
      });
    }
  }

  // Strategy 2: If we have exactly 1 chunk (or claims still empty), extract 1 to 2 distinct sentences from it
  if (claims.length === 0 && scoredChunks.length > 0) {
    const { chunk } = scoredChunks[0]!;
    const sentences = chunk.text.split(/(?<=[.!?\n])\s+/).filter((s) => s.trim().length >= 10);

    if (sentences.length >= 2) {
      const q1 = sentences[0]!.trim();
      const q2 = sentences[1]!.trim();
      const quote1 = chunk.text.includes(q1) ? q1 : chunk.text.trim();
      const quote2 = chunk.text.includes(q2) ? q2 : chunk.text.trim();

      claims.push({
        claim_id: "claim-1",
        claim_text: `${generateTitle(category, locationLabel, severity)} dilaporkan terjadi di lokasi.`,
        evidence_label: "under_review",
        support_assessment: "supported",
        quote_text: quote1,
        evidence_ref_id: `ref-${reportRevisionId}-${chunk.chunk_index}`,
      });

      if (quote2 !== quote1) {
        claims.push({
          claim_id: "claim-2",
          claim_text: `Dampak kejadian dengan tingkat keparahan ${severity} di sekitar ${locationLabel}.`,
          evidence_label: "under_review",
          support_assessment: "supported",
          quote_text: quote2,
          evidence_ref_id: `ref-${reportRevisionId}-${chunk.chunk_index}`,
        });
      }
    } else {
      const quote = extractExactQuote(chunk.text, searchKeywords);
      claims.push({
        claim_id: "claim-1",
        claim_text: `${generateTitle(category, locationLabel, severity)} dilaporkan terjadi di lokasi kejadian.`,
        evidence_label: "under_review",
        support_assessment: "supported",
        quote_text: quote,
        evidence_ref_id: `ref-${reportRevisionId}-${chunk.chunk_index}`,
      });
    }
  }

  return claims;
}

/**
 * Generates an EventProposalDto (Schema 2.0) from a StoredReportRevision.
 * Returns null if the report is not an incident or outside DKI Jakarta.
 */
export function generateProposalFromReport(
  report: StoredReportRevision,
  options?: ProposalEngineOptions,
): EventProposalDto | null {
  if (!report || typeof report !== "object") {
    return null;
  }

  const rawChunks = resolveReportChunks(report);
  if (rawChunks.length === 0) {
    return null;
  }

  // Aggregate text for incident and location classification
  const fullText = (report.permitted_text || rawChunks.map((c) => c.text).join(" ")).trim();
  if (fullText.length === 0) {
    return null;
  }

  // 1. Detect incident category
  const categoryResult = detectIncidentCategory(fullText);
  if (!categoryResult) {
    // Non-incident or unrelated content
    return null;
  }
  const incident_type = categoryResult.category;

  // 2. Extract location and verify Jakarta scope
  const locationResult = extractLocation(fullText, report.source_id || "");
  if (!locationResult) {
    // Incident outside Jakarta
    return null;
  }
  const { locationLabel, coordinates } = locationResult;

  // 3. Detect severity
  const severity = detectSeverity(fullText);

  // 4. Extract physical event time
  const event_time = extractEventTime(fullText, report.published_at, report.retrieved_at);

  // 5. Generate structured claims
  const claims = createClaims(report.report_revision_id, rawChunks, incident_type, locationLabel, severity);
  if (claims.length === 0) {
    return null;
  }

  // 6. Generate human-readable Indonesian title
  const title = generateTitle(incident_type, locationLabel, severity);

  // 7. Format proposal_id
  const cleanId = report.report_revision_id.replace(/[^A-Za-z0-9._:-]/g, "-");
  const proposal_id = cleanId.startsWith("prop-") ? cleanId : `prop-${cleanId}`;

  const proposed_at = options?.proposedAt ?? report.retrieved_at ?? new Date().toISOString();

  return {
    schema_version: "2.0",
    proposal_id,
    title,
    incident_type,
    severity,
    event_time,
    location_label: locationLabel,
    coordinates,
    claims,
    proposed_at,
  };
}
