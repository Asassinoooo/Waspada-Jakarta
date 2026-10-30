/**
 * Consolidated Geographic Gazetteer for Jakarta Urban Area.
 *
 * Provides a single canonical source of truth for:
 * - DKI Jakarta bounding envelope
 * - Precision micro-landmarks (toll interchanges, underpasses, flyovers, transit hubs)
 * - Administrative kecamatans/districts
 * - Haversine distance calculations
 *
 * These geographic references serve as supporting evidence and spatial hints
 * for model interpretation and semantic correlation, never as an exhaustive gate.
 */

export const JAKARTA_ENVELOPE = {
  west: 106.32,
  south: -6.40,
  east: 106.98,
  north: -5.16,
} as const;

export interface GazetteerPlace {
  readonly name: string;
  readonly label: string;
  readonly coordinates: readonly [longitude: number, latitude: number];
  readonly patterns: readonly RegExp[];
  readonly key?: string;
}

/**
 * Calculates great-circle Haversine distance in meters between two WGS84 coordinates.
 */
export function haversineDistanceMeters(
  coord1: readonly [number, number],
  coord2: readonly [number, number],
): number {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  const R = 6371000;
  const radPerDeg = Math.PI / 180;
  const dLat = (lat2 - lat1) * radPerDeg;
  const dLon = (lon2 - lon1) * radPerDeg;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * radPerDeg) * Math.cos(lat2 * radPerDeg) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Validates whether coordinates fall within the DKI Jakarta envelope.
 */
export function isCoordinateInJakarta(
  coordinates: readonly [number, number] | null | undefined,
): boolean {
  if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
    return false;
  }
  const [lng, lat] = coordinates;
  if (
    typeof lng !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat)
  ) {
    return false;
  }
  return (
    lng >= JAKARTA_ENVELOPE.west &&
    lng <= JAKARTA_ENVELOPE.east &&
    lat >= JAKARTA_ENVELOPE.south &&
    lat <= JAKARTA_ENVELOPE.north
  );
}

/**
 * Canonical gazetteer mapping Jakarta corridors, interchanges, transit hubs,
 * and kecamatans to representative coordinates.
 */
export const JAKARTA_GAZETTEER: readonly GazetteerPlace[] = [
  // ==========================================
  // High-Precision Corridors & Micro-Landmarks (Priority Matches)
  // ==========================================
  // Tollways & Interchanges
  {
    name: "Simpang Susun Semanggi",
    label: "Simpang Susun Semanggi, Jakarta Selatan",
    coordinates: [106.8156, -6.2201],
    patterns: [/\bsimpang\s+susun\s+semanggi\b/i, /\bsemanggi\b/i],
    key: "simpang_susun_semanggi",
  },
  {
    name: "Tol Cawang Interchange",
    label: "Tol Cawang Interchange, Jakarta Timur",
    coordinates: [106.8710, -6.2420],
    patterns: [/\btol\s+cawang\s+interchange\b/i, /\bsimpang\s+susun\s+cawang\b/i, /\binterchange\s+cawang\b/i],
    key: "tol_cawang_interchange",
  },
  {
    name: "Tomang Interchange / Slipi",
    label: "Tomang Interchange, Jakarta Barat",
    coordinates: [106.7940, -6.1770],
    patterns: [/\btomang\s+interchange\b/i, /\bsimpang\s+susun\s+tomang\b/i, /\binterchange\s+tomang\b/i],
    key: "tomang_interchange",
  },
  {
    name: "Tol JORR TB Simatupang",
    label: "Tol JORR TB Simatupang, Jakarta Selatan",
    coordinates: [106.8350, -6.2950],
    patterns: [/\b(?:tol\s+)?jorr\s+tb\s+simatupang\b/i, /\btol\s+tb\s+simatupang\b/i, /\bjorr\s+simatupang\b/i],
    key: "tol_jorr_tb_simatupang",
  },
  {
    name: "Tol Jagorawi Cawang-Cibubur",
    label: "Tol Jagorawi Cawang-Cibubur, Jakarta Timur",
    coordinates: [106.8850, -6.3100],
    patterns: [/\btol\s+jagorawi(?:\s+cawang[- ]cibubur)?\b/i, /\bjagorawi\b/i],
    key: "tol_jagorawi_cawang_cibubur",
  },
  {
    name: "Tol Pelabuhan / Pluit Interchange",
    label: "Tol Pelabuhan Pluit Interchange, Jakarta Utara",
    coordinates: [106.7860, -6.1240],
    patterns: [/\btol\s+pelabuhan\b/i, /\bpluit\s+interchange\b/i, /\bsimpang\s+susun\s+pluit\b/i],
    key: "tol_pelabuhan_pluit_interchange",
  },
  {
    name: "Tol Wiyoto Wiyono Cempaka Putih",
    label: "Tol Wiyoto Wiyono Cempaka Putih, Jakarta Pusat",
    coordinates: [106.8780, -6.1730],
    patterns: [/\btol\s+wiyoto\s+wiyono\b/i, /\binterchange\s+cempaka\s+putih\b/i],
    key: "tol_wiyoto_wiyono_cempaka_putih",
  },
  {
    name: "Tol Kembangan Interchange",
    label: "Tol Kembangan Interchange, Jakarta Barat",
    coordinates: [106.7380, -6.1870],
    patterns: [/\b(?:tol\s+)?kembangan\s+interchange\b/i, /\bsimpang\s+susun\s+kembangan\b/i],
    key: "tol_kembangan_interchange",
  },
  {
    name: "Tol TB Simatupang Cilandak",
    label: "Tol TB Simatupang Cilandak, Jakarta Selatan",
    coordinates: [106.8020, -6.2940],
    patterns: [/\btol\s+cilandak\b/i, /\btol\s+simatupang\b/i],
    key: "tol_tb_simatupang_cilandak",
  },

  // Underpasses & Flyovers
  {
    name: "Underpass Dukuh Atas",
    label: "Underpass Dukuh Atas, Jakarta Pusat",
    coordinates: [106.8210, -6.2010],
    patterns: [/\bunderpass\s+dukuh\s+atas\b/i, /\bterowongan\s+dukuh\s+atas\b/i],
    key: "underpass_dukuh_atas",
  },
  {
    name: "Underpass Casablanca",
    label: "Underpass Casablanca, Jakarta Selatan",
    coordinates: [106.8380, -6.2230],
    patterns: [/\bunderpass\s+casablanca\b/i, /\bterowongan\s+casablanca\b/i, /\bcasablanca\b/i],
    key: "underpass_casablanca",
  },
  {
    name: "Underpass Senen",
    label: "Underpass Senen, Jakarta Pusat",
    coordinates: [106.8430, -6.1780],
    patterns: [/\bunderpass\s+senen\b/i, /\bterowongan\s+senen\b/i],
    key: "underpass_senen",
  },
  {
    name: "Underpass Mampang-Kuningan",
    label: "Underpass Mampang-Kuningan, Jakarta Selatan",
    coordinates: [106.8280, -6.2420],
    patterns: [/\bunderpass\s+mampang(?:-kuningan)?\b/i, /\bterowongan\s+mampang\b/i],
    key: "underpass_mampang_kuningan",
  },
  {
    name: "Underpass Matraman",
    label: "Underpass Matraman, Jakarta Timur",
    coordinates: [106.8610, -6.2020],
    patterns: [/\bunderpass\s+matraman\b/i, /\bterowongan\s+matraman\b/i],
    key: "underpass_matraman",
  },
  {
    name: "Underpass Kebayoran Lama",
    label: "Underpass Kebayoran Lama, Jakarta Selatan",
    coordinates: [106.7770, -6.2370],
    patterns: [/\bunderpass\s+kebayoran\s+lama\b/i, /\bterowongan\s+kebayoran\s+lama\b/i],
    key: "underpass_kebayoran_lama",
  },
  {
    name: "Underpass Pramuka",
    label: "Underpass Pramuka, Jakarta Timur",
    coordinates: [106.8650, -6.1950],
    patterns: [/\bunderpass\s+pramuka\b/i, /\bterowongan\s+pramuka\b/i],
    key: "underpass_pramuka",
  },
  {
    name: "Underpass Kuningan",
    label: "Underpass Kuningan, Jakarta Selatan",
    coordinates: [106.8270, -6.2350],
    patterns: [/\bunderpass\s+kuningan\b/i, /\bterowongan\s+kuningan\b/i],
    key: "underpass_kuningan",
  },
  {
    name: "Flyover Roxy / Cideng",
    label: "Flyover Roxy, Jakarta Barat",
    coordinates: [106.8080, -6.1660],
    patterns: [/\bflyover\s+roxy\b/i, /\bflyover\s+cideng\b/i, /\bjembatan\s+layang\s+roxy\b/i],
    key: "flyover_roxy_cideng",
  },
  {
    name: "Flyover Pancoran",
    label: "Flyover Pancoran, Jakarta Selatan",
    coordinates: [106.8430, -6.2430],
    patterns: [/\bflyover\s+pancoran\b/i, /\bjembatan\s+layang\s+pancoran\b/i],
    key: "flyover_pancoran",
  },
  {
    name: "Flyover Antasari",
    label: "Flyover Antasari, Jakarta Selatan",
    coordinates: [106.8050, -6.2620],
    patterns: [/\bflyover\s+antasari\b/i, /\bjlnt\s+antasari\b/i, /\bjembatan\s+layang\s+antasari\b/i, /\bantasari\b/i],
    key: "flyover_antasari",
  },
  {
    name: "Flyover Klender",
    label: "Flyover Klender, Jakarta Timur",
    coordinates: [106.8990, -6.2140],
    patterns: [/\bflyover\s+klender\b/i, /\bjembatan\s+layang\s+klender\b/i],
    key: "flyover_klender",
  },
  {
    name: "Flyover Saharjo Tebet",
    label: "Flyover Saharjo, Jakarta Selatan",
    coordinates: [106.8510, -6.2190],
    patterns: [/\bflyover\s+saharjo\b/i, /\bjembatan\s+layang\s+saharjo\b/i],
    key: "flyover_saharjo_tebet",
  },
  {
    name: "Flyover Rawamangun",
    label: "Flyover Rawamangun, Jakarta Timur",
    coordinates: [106.8840, -6.1930],
    patterns: [/\bflyover\s+rawamangun\b/i, /\bjembatan\s+layang\s+rawamangun\b/i],
    key: "flyover_rawamangun",
  },

  // Transit Hubs & Rail Crossings
  {
    name: "Stasiun Manggarai Transit",
    label: "Stasiun Manggarai Transit, Jakarta Selatan",
    coordinates: [106.8500, -6.2098],
    patterns: [/\b(?:stasiun|st\.)\s+manggarai\b/i, /\bmanggarai\s+(?:transit|hub)\b/i, /\bmanggarai\b/i],
    key: "stasiun_manggarai",
  },
  {
    name: "Stasiun Tanah Abang Transit",
    label: "Stasiun Tanah Abang Transit, Jakarta Pusat",
    coordinates: [106.8110, -6.1856],
    patterns: [/\b(?:stasiun|st\.)\s+tanah\s+abang\b/i],
    key: "stasiun_tanah_abang",
  },
  {
    name: "Stasiun Jatinegara",
    label: "Stasiun Jatinegara, Jakarta Timur",
    coordinates: [106.8670, -6.2150],
    patterns: [/\b(?:stasiun|st\.)\s+jatinegara\b/i],
    key: "stasiun_jatinegara",
  },
  {
    name: "Halte CSW / ASEAN MRT Interchange",
    label: "Halte CSW ASEAN MRT, Jakarta Selatan",
    coordinates: [106.7985, -6.2395],
    patterns: [/\bhalte\s+csw\b/i, /\bcsw\s+asean\b/i, /\bmrt\s+asean\b/i, /\binterchange\s+csw\b/i, /\bsimpang\s+csw\b/i, /\bcsw\b/i],
    key: "halte_csw",
  },
  {
    name: "Halte Bundaran HI Astra",
    label: "Halte Bundaran HI Astra, Jakarta Pusat",
    coordinates: [106.8230, -6.1930],
    patterns: [/\bhalte\s+bundaran\s+hi\b/i, /\bmrt\s+bundaran\s+hi\b/i, /\bbundaran\s+hi\s+astra\b/i],
    key: "halte_bundaran_hi",
  },
  {
    name: "Halte Harmoni Central",
    label: "Halte Harmoni Central, Jakarta Pusat",
    coordinates: [106.8190, -6.1640],
    patterns: [/\bhalte\s+harmoni\b/i, /\bharmoni\s+central\b/i, /\bcentral\s+harmoni\b/i],
    key: "halte_harmoni",
  },
  {
    name: "Terminal Bus Kampung Rambutan",
    label: "Terminal Kampung Rambutan, Jakarta Timur",
    coordinates: [106.8760, -6.3090],
    patterns: [/\bterminal\s+(?:bus\s+)?kampung\s+rambutan\b/i, /\bkampung\s+rambutan\b/i],
    key: "terminal_kampung_rambutan",
  },
  {
    name: "Terminal Bus Pulo Gebang",
    label: "Terminal Pulo Gebang, Jakarta Timur",
    coordinates: [106.9530, -6.2120],
    patterns: [/\bterminal\s+(?:bus\s+)?pulo\s*gebang\b/i, /\bpulo\s*gebang\b/i],
    key: "terminal_pulo_gebang",
  },
  {
    name: "Terminal Bus Kalideres",
    label: "Terminal Kalideres, Jakarta Barat",
    coordinates: [106.7020, -6.1550],
    patterns: [/\bterminal\s+(?:bus\s+)?kalideres\b/i],
    key: "terminal_kalideres",
  },
  {
    name: "Stasiun Pasar Senen",
    label: "Stasiun Pasar Senen, Jakarta Pusat",
    coordinates: [106.8440, -6.1740],
    patterns: [/\b(?:stasiun|st\.)\s+(?:pasar\s+)?senen\b/i],
    key: "stasiun_senen",
  },
  {
    name: "Stasiun Sudirman Transit",
    label: "Stasiun Sudirman Transit, Jakarta Pusat",
    coordinates: [106.8220, -6.2020],
    patterns: [/\b(?:stasiun|st\.)\s+sudirman\b/i, /\bmrt\s+dukuh\s+atas\b/i],
    key: "stasiun_sudirman",
  },
  {
    name: "Halte Tosari",
    label: "Halte Tosari, Jakarta Pusat",
    coordinates: [106.8225, -6.1980],
    patterns: [/\bhalte\s+tosari\b/i],
    key: "halte_tosari",
  },
  {
    name: "Halte Monas MRT",
    label: "Halte Monas MRT, Jakarta Pusat",
    coordinates: [106.8240, -6.1780],
    patterns: [/\bhalte\s+monas\b/i, /\bmrt\s+monas\b/i],
    key: "halte_monas",
  },

  // Regional & District Fallbacks
  // Jakarta Pusat
  { name: "Senen", label: "Senen, Jakarta Pusat", coordinates: [106.8442, -6.1823], patterns: [/\b(?:pasar\s+)?senen\b/i], key: "senen" },
  { name: "Gambir", label: "Gambir, Jakarta Pusat", coordinates: [106.8302, -6.1754], patterns: [/\bgambir\b/i], key: "gambir" },
  { name: "Sawah Besar", label: "Sawah Besar, Jakarta Pusat", coordinates: [106.8322, -6.1550], patterns: [/\bsawah\s+besar\b/i], key: "sawah_besar" },
  { name: "Kemayoran", label: "Kemayoran, Jakarta Pusat", coordinates: [106.8550, -6.1600], patterns: [/\bkemayoran\b/i], key: "kemayoran" },
  { name: "Cempaka Putih", label: "Cempaka Putih, Jakarta Pusat", coordinates: [106.8680, -6.1830], patterns: [/\bcempaka\s+putih\b/i], key: "cempaka_putih" },
  { name: "Menteng", label: "Menteng, Jakarta Pusat", coordinates: [106.8320, -6.1960], patterns: [/\bmenteng\b/i], key: "menteng" },
  { name: "Tanah Abang", label: "Tanah Abang, Jakarta Pusat", coordinates: [106.8150, -6.1900], patterns: [/\btanah\s+abang\b/i], key: "tanah_abang" },
  { name: "Johar Baru", label: "Johar Baru, Jakarta Pusat", coordinates: [106.8580, -6.1850], patterns: [/\bjohar\s+baru\b/i], key: "johar_baru" },
  { name: "Harmoni", label: "Harmoni, Jakarta Pusat", coordinates: [106.8190, -6.1630], patterns: [/\bharmoni\b/i], key: "harmoni" },
  { name: "Monas", label: "Monas, Jakarta Pusat", coordinates: [106.8272, -6.1754], patterns: [/\bmonas\b/i], key: "monas" },

  // Jakarta Selatan
  { name: "Kemang", label: "Kemang, Jakarta Selatan", coordinates: [106.8150, -6.2650], patterns: [/\bkemang(?:\s+raya)?\b/i], key: "kemang" },
  { name: "Kebayoran Baru", label: "Kebayoran Baru, Jakarta Selatan", coordinates: [106.7990, -6.2440], patterns: [/\bkebayoran\s+baru\b/i, /\bblok\s+m\b/i], key: "kebayoran_baru" },
  { name: "Kebayoran Lama", label: "Kebayoran Lama, Jakarta Selatan", coordinates: [106.7770, -6.2420], patterns: [/\bkebayoran\s+lama\b/i], key: "kebayoran_lama" },
  { name: "Pesanggrahan", label: "Pesanggrahan, Jakarta Selatan", coordinates: [106.7620, -6.2570], patterns: [/\bpesanggrahan\b/i], key: "pesanggrahan" },
  { name: "Cilandak", label: "Cilandak, Jakarta Selatan", coordinates: [106.7970, -6.2930], patterns: [/\bcilandak\b/i, /\bfatmawati\b/i], key: "cilandak" },
  { name: "Pasar Minggu", label: "Pasar Minggu, Jakarta Selatan", coordinates: [106.8330, -6.2840], patterns: [/\bpasar\s+minggu\b/i], key: "pasar_minggu" },
  { name: "Jagakarsa", label: "Jagakarsa, Jakarta Selatan", coordinates: [106.8250, -6.3330], patterns: [/\bjagakarsa\b/i], key: "jagakarsa" },
  { name: "Mampang Prapatan", label: "Mampang Prapatan, Jakarta Selatan", coordinates: [106.8250, -6.2500], patterns: [/\bmampang(?:\s+prapatan)?\b/i], key: "mampang" },
  { name: "Pancoran", label: "Pancoran, Jakarta Selatan", coordinates: [106.8450, -6.2500], patterns: [/\bpancoran\b/i, /\bkalibata\b/i], key: "pancoran" },
  { name: "Tebet", label: "Tebet, Jakarta Selatan", coordinates: [106.8570, -6.2290], patterns: [/\btebet\b/i], key: "tebet" },
  { name: "Setiabudi", label: "Setiabudi, Jakarta Selatan", coordinates: [106.8290, -6.2150], patterns: [/\bsetiabudi\b/i, /\bkuningan\b/i], key: "setiabudi" },

  // Jakarta Barat
  { name: "Cengkareng", label: "Cengkareng, Jakarta Barat", coordinates: [106.7320, -6.1520], patterns: [/\bcengkareng\b/i], key: "cengkareng" },
  { name: "Grogol Petamburan", label: "Grogol Petamburan, Jakarta Barat", coordinates: [106.7870, -6.1650], patterns: [/\bgrogol(?:\s+petamburan)?\b/i, /\btomang\b/i], key: "grogol" },
  { name: "Taman Sari", label: "Taman Sari, Jakarta Barat", coordinates: [106.8170, -6.1450], patterns: [/\btaman\s+sari\b/i], key: "taman_sari" },
  { name: "Tambora", label: "Tambora, Jakarta Barat", coordinates: [106.8040, -6.1480], patterns: [/\btambora\b/i], key: "tambora" },
  { name: "Kebon Jeruk", label: "Kebon Jeruk, Jakarta Barat", coordinates: [106.7720, -6.1940], patterns: [/\bkebon\s+jeruk\b/i], key: "kebon_jeruk" },
  { name: "Kalideres", label: "Kalideres, Jakarta Barat", coordinates: [106.7020, -6.1500], patterns: [/\bkalideres\b/i], key: "kalideres" },
  { name: "Palmerah", label: "Palmerah, Jakarta Barat", coordinates: [106.7950, -6.1980], patterns: [/\bpalmerah\b/i, /\bslipi\b/i], key: "palmerah" },
  { name: "Kembangan", label: "Kembangan, Jakarta Barat", coordinates: [106.7450, -6.1880], patterns: [/\bkembangan\b/i, /\bpuri\s+indah\b/i], key: "kembangan" },

  // Jakarta Timur
  { name: "Rawamangun", label: "Rawamangun, Jakarta Timur", coordinates: [106.8870, -6.1950], patterns: [/\brawamangun\b/i], key: "rawamangun" },
  { name: "Pulo Gadung", label: "Pulo Gadung, Jakarta Timur", coordinates: [106.8920, -6.1920], patterns: [/\bpulo\s*gadung\b/i], key: "pulo_gadung" },
  { name: "Matraman", label: "Matraman, Jakarta Timur", coordinates: [106.8620, -6.2050], patterns: [/\bmatraman\b/i], key: "matraman" },
  { name: "Jatinegara", label: "Jatinegara, Jakarta Timur", coordinates: [106.8710, -6.2280], patterns: [/\bjatinegara\b/i, /\bkampung\s+melayu\b/i, /\bbidara\s+cina\b/i], key: "jatinegara" },
  { name: "Duren Sawit", label: "Duren Sawit, Jakarta Timur", coordinates: [106.9150, -6.2340], patterns: [/\bduren\s+sawit\b/i], key: "duren_sawit" },
  { name: "Kramat Jati", label: "Kramat Jati, Jakarta Timur", coordinates: [106.8680, -6.2750], patterns: [/\bkramat\s+jati\b/i], key: "kramat_jati" },
  { name: "Makasar", label: "Makasar, Jakarta Timur", coordinates: [106.8830, -6.2750], patterns: [/\bmakasar\b/i, /\bhalim(?:\s+perdanakusuma)?\b/i], key: "makasar" },
  { name: "Pasar Rebo", label: "Pasar Rebo, Jakarta Timur", coordinates: [106.8600, -6.3150], patterns: [/\bpasar\s+rebo\b/i], key: "pasar_rebo" },
  { name: "Ciracas", label: "Ciracas, Jakarta Timur", coordinates: [106.8780, -6.3300], patterns: [/\bciracas\b/i], key: "ciracas" },
  { name: "Cipayung", label: "Cipayung, Jakarta Timur", coordinates: [106.8950, -6.3150], patterns: [/\bcipayung\b/i], key: "cipayung" },
  { name: "Cakung", label: "Cakung, Jakarta Timur", coordinates: [106.9480, -6.1920], patterns: [/\bcakung\b/i], key: "cakung" },
  { name: "Cawang", label: "Cawang, Jakarta Timur", coordinates: [106.8670, -6.2480], patterns: [/\bcawang\b/i, /\btol\s+cawang\b/i], key: "cawang" },

  // Jakarta Utara
  { name: "Kelapa Gading", label: "Kelapa Gading, Jakarta Utara", coordinates: [106.9080, -6.1580], patterns: [/\bkelapa\s+gading\b/i], key: "kelapa_gading" },
  { name: "Tanjung Priok", label: "Tanjung Priok, Jakarta Utara", coordinates: [106.8820, -6.1180], patterns: [/\btanjung\s+priok\b/i], key: "tanjung_priok" },
  { name: "Koja", label: "Koja, Jakarta Utara", coordinates: [106.9050, -6.1250], patterns: [/\bkoja\b/i], key: "koja" },
  { name: "Pademangan", label: "Pademangan, Jakarta Utara", coordinates: [106.8400, -6.1330], patterns: [/\bpademangan\b/i, /\bancol\b/i], key: "pademangan" },
  { name: "Penjaringan", label: "Penjaringan, Jakarta Utara", coordinates: [106.7900, -6.1280], patterns: [/\bpenjaringan\b/i, /\bpluit\b/i, /\bmuara\s+(?:baru|angke)\b/i], key: "penjaringan" },
  { name: "Cilincing", label: "Cilincing, Jakarta Utara", coordinates: [106.9380, -6.1250], patterns: [/\bcilincing\b/i, /\bmarunda\b/i], key: "cilincing" },
  { name: "Sunter", label: "Sunter, Jakarta Utara", coordinates: [106.8750, -6.1400], patterns: [/\bsunter\b/i], key: "sunter" },

  // Prominent Corridors & Highways
  { name: "Sudirman", label: "Sudirman, Jakarta Pusat", coordinates: [106.8230, -6.2080], patterns: [/\b(?:jl\.?|jalan\s+)?sudirman\b/i], key: "sudirman" },
  { name: "Thamrin", label: "Thamrin, Jakarta Pusat", coordinates: [106.8240, -6.1920], patterns: [/\b(?:jl\.?|jalan\s+)?thamrin\b/i], key: "thamrin" },
  { name: "Gatot Subroto", label: "Gatot Subroto, Jakarta Selatan", coordinates: [106.8250, -6.2350], patterns: [/\b(?:jl\.?|jalan\s+)?gatot\s+subroto\b/i], key: "gatot_subroto" },
  { name: "Rasuna Said", label: "Rasuna Said, Jakarta Selatan", coordinates: [106.8310, -6.2190], patterns: [/\b(?:jl\.?|jalan\s+)?rasuna\s+said\b/i], key: "rasuna_said" },
  { name: "MT Haryono", label: "MT Haryono, Jakarta Timur", coordinates: [106.8650, -6.2430], patterns: [/\b(?:jl\.?|jalan\s+)?mt\s+haryono\b/i], key: "mt_haryono" },
  { name: "Daan Mogot", label: "Daan Mogot, Jakarta Barat", coordinates: [106.7500, -6.1550], patterns: [/\b(?:jl\.?|jalan\s+)?daan\s+mogot\b/i], key: "daan_mogot" },

  // Administrative City Names (broad fallbacks)
  { name: "Jakarta Pusat", label: "Jakarta Pusat", coordinates: [106.8456, -6.1823], patterns: [/\bjakarta\s+pusat\b/i, /\bjakpus\b/i], key: "jakarta_pusat" },
  { name: "Jakarta Selatan", label: "Jakarta Selatan", coordinates: [106.8000, -6.2600], patterns: [/\bjakarta\s+selatan\b/i, /\bjaksel\b/i], key: "jakarta_selatan" },
  { name: "Jakarta Barat", label: "Jakarta Barat", coordinates: [106.7550, -6.1680], patterns: [/\bjakarta\s+barat\b/i, /\bjakbar\b/i], key: "jakarta_barat" },
  { name: "Jakarta Timur", label: "Jakarta Timur", coordinates: [106.8850, -6.2250], patterns: [/\bjakarta\s+timur\b/i, /\bjaktim\b/i], key: "jakarta_timur" },
  { name: "Jakarta Utara", label: "Jakarta Utara", coordinates: [106.8850, -6.1250], patterns: [/\bjakarta\s+utara\b/i, /\bjakut\b/i], key: "jakarta_utara" },
  { name: "Kepulauan Seribu", label: "Kepulauan Seribu", coordinates: [106.5600, -5.6000], patterns: [/\bkepulauan\s+seribu\b/i], key: "kepulauan_seribu" },
  { name: "DKI Jakarta", label: "DKI Jakarta", coordinates: [106.8272, -6.1754], patterns: [/\bdki\s+jakarta\b/i, /\bjakarta\b/i], key: "dki_jakarta" },
];

export const JAKARTA_TOPONYMS = JAKARTA_GAZETTEER;

/**
 * Searches for a matching Jakarta gazetteer place in text.
 */
export function findGazetteerPlace(text: string): GazetteerPlace | null {
  for (const place of JAKARTA_GAZETTEER) {
    for (const pattern of place.patterns) {
      if (pattern.test(text)) {
        return place;
      }
    }
  }
  return null;
}

export const findJakartaToponym = findGazetteerPlace;

/**
 * Extracts coordinate hint and location label from free text or explicit brackets.
 */
export function extractCoordinatesHint(
  text: string,
): { readonly coordinates: readonly [number, number] | null; readonly label: string } | null {
  // 1. Explicit bracketed coordinates: [lon, lat] or [lat, lon]
  const coordRegex = /\[\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*\]/;
  const match = text.match(coordRegex);
  if (match && match[1] && match[2]) {
    const p1 = Number(match[1]);
    const p2 = Number(match[2]);
    if (
      p1 >= JAKARTA_ENVELOPE.west &&
      p1 <= JAKARTA_ENVELOPE.east &&
      p2 >= JAKARTA_ENVELOPE.south &&
      p2 <= JAKARTA_ENVELOPE.north
    ) {
      return { coordinates: [p1, p2], label: `[${p1}, ${p2}]` };
    }
    if (
      p2 >= JAKARTA_ENVELOPE.west &&
      p2 <= JAKARTA_ENVELOPE.east &&
      p1 >= JAKARTA_ENVELOPE.south &&
      p1 <= JAKARTA_ENVELOPE.north
    ) {
      return { coordinates: [p2, p1], label: `[${p2}, ${p1}]` };
    }
  }

  // 2. Gazetteer lookup
  const place = findGazetteerPlace(text);
  if (place) {
    return { coordinates: place.coordinates, label: place.label };
  }

  return null;
}
