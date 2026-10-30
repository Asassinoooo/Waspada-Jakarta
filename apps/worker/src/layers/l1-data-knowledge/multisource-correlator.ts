/**
 * Multi-Source Correlator (Layer 1 Data Knowledge).
 *
 * Provides pure spatio-temporal correlation and duplicate suppression across
 * heterogeneous report revisions (PetaBencana citizen reports, ANTARA RSS feeds,
 * BMKG weather alerts).
 *
 * Correlation criteria:
 * 1. Spatial proximity: Haversine distance <= 1,200m OR shared Jakarta kelurahan/kecamatan toponym.
 * 2. Temporal proximity: Time delta <= 4 hours between observation/publication times.
 * 3. Category compatibility: Hazard types match or align (e.g., flood + heavy rain weather).
 * 4. Deduplication: Duplicate reports from the same source within 6 hours are suppressed.
 */

export type IncidentCategory = "flood" | "fire" | "accident" | "tree_fall" | "crime" | "weather";

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

/** Frozen Contract 1: Correlated Incident Cluster */
export interface CorrelatedIncidentCluster {
  readonly cluster_id: string;
  readonly primary_category: IncidentCategory;
  readonly location_label: string;
  readonly coordinates: readonly [number, number] | null;
  readonly reports: readonly StoredReportRevision[];
  readonly is_multi_source: boolean;
  readonly sources: readonly string[];
}

export const JAKARTA_CORRELATION_LIMITS = {
  maxSpatialDistanceMeters: 1200,
  maxTemporalWindowMs: 4 * 60 * 60 * 1000, // 4 hours
  duplicateWindowMs: 6 * 60 * 60 * 1000,   // 6 hours
} as const;

export const JAKARTA_ENVELOPE = {
  west: 106.32,
  south: -6.40,
  east: 106.98,
  north: -5.16,
} as const;

export interface JakartaToponym {
  readonly key: string;
  readonly name: string;
  readonly label: string;
  readonly coordinates: readonly [longitude: number, latitude: number];
  readonly patterns: readonly RegExp[];
}

/**
 * Toponyms covering Jakarta kecamatans, major kelurahans, and key transit corridors.
 */
export const JAKARTA_TOPONYMS: readonly JakartaToponym[] = [
  // ==========================================
  // High-Precision Corridors & Micro-Landmarks (Priority Matches)
  // ==========================================
  // Tollways & Interchanges
  {
    key: "simpang_susun_semanggi",
    name: "Simpang Susun Semanggi",
    label: "Simpang Susun Semanggi, Jakarta Selatan",
    coordinates: [106.8156, -6.2201],
    patterns: [/\bsimpang\s+susun\s+semanggi\b/i, /\bsemanggi\b/i],
  },
  {
    key: "tol_cawang_interchange",
    name: "Tol Cawang Interchange",
    label: "Tol Cawang Interchange, Jakarta Timur",
    coordinates: [106.8710, -6.2420],
    patterns: [/\btol\s+cawang\s+interchange\b/i, /\bsimpang\s+susun\s+cawang\b/i, /\binterchange\s+cawang\b/i],
  },
  {
    key: "tomang_interchange",
    name: "Tomang Interchange / Slipi",
    label: "Tomang Interchange, Jakarta Barat",
    coordinates: [106.7940, -6.1770],
    patterns: [/\btomang\s+interchange\b/i, /\bsimpang\s+susun\s+tomang\b/i, /\binterchange\s+tomang\b/i],
  },
  {
    key: "tol_jorr_tb_simatupang",
    name: "Tol JORR TB Simatupang",
    label: "Tol JORR TB Simatupang, Jakarta Selatan",
    coordinates: [106.8350, -6.2950],
    patterns: [/\b(?:tol\s+)?jorr\s+tb\s+simatupang\b/i, /\btol\s+tb\s+simatupang\b/i, /\bjorr\s+simatupang\b/i],
  },
  {
    key: "tol_jagorawi_cawang_cibubur",
    name: "Tol Jagorawi Cawang-Cibubur",
    label: "Tol Jagorawi Cawang-Cibubur, Jakarta Timur",
    coordinates: [106.8850, -6.3100],
    patterns: [/\btol\s+jagorawi(?:\s+cawang[- ]cibubur)?\b/i, /\bjagorawi\b/i],
  },
  {
    key: "tol_pelabuhan_pluit_interchange",
    name: "Tol Pelabuhan / Pluit Interchange",
    label: "Tol Pelabuhan Pluit Interchange, Jakarta Utara",
    coordinates: [106.7860, -6.1240],
    patterns: [/\btol\s+pelabuhan\b/i, /\bpluit\s+interchange\b/i, /\bsimpang\s+susun\s+pluit\b/i],
  },
  {
    key: "tol_wiyoto_wiyono_cempaka_putih",
    name: "Tol Wiyoto Wiyono Cempaka Putih",
    label: "Tol Wiyoto Wiyono Cempaka Putih, Jakarta Pusat",
    coordinates: [106.8780, -6.1730],
    patterns: [/\btol\s+wiyoto\s+wiyono\b/i, /\binterchange\s+cempaka\s+putih\b/i],
  },
  {
    key: "tol_kembangan_interchange",
    name: "Tol Kembangan Interchange",
    label: "Tol Kembangan Interchange, Jakarta Barat",
    coordinates: [106.7380, -6.1870],
    patterns: [/\b(?:tol\s+)?kembangan\s+interchange\b/i, /\bsimpang\s+susun\s+kembangan\b/i],
  },
  {
    key: "tol_tb_simatupang_cilandak",
    name: "Tol TB Simatupang Cilandak",
    label: "Tol TB Simatupang Cilandak, Jakarta Selatan",
    coordinates: [106.8020, -6.2940],
    patterns: [/\btol\s+cilandak\b/i, /\btol\s+simatupang\b/i],
  },

  // Underpasses & Flyovers
  {
    key: "underpass_dukuh_atas",
    name: "Underpass Dukuh Atas",
    label: "Underpass Dukuh Atas, Jakarta Pusat",
    coordinates: [106.8210, -6.2010],
    patterns: [/\bunderpass\s+dukuh\s+atas\b/i, /\bterowongan\s+dukuh\s+atas\b/i],
  },
  {
    key: "underpass_casablanca",
    name: "Underpass Casablanca",
    label: "Underpass Casablanca, Jakarta Selatan",
    coordinates: [106.8380, -6.2230],
    patterns: [/\bunderpass\s+casablanca\b/i, /\bterowongan\s+casablanca\b/i, /\bcasablanca\b/i],
  },
  {
    key: "underpass_senen",
    name: "Underpass Senen",
    label: "Underpass Senen, Jakarta Pusat",
    coordinates: [106.8430, -6.1780],
    patterns: [/\bunderpass\s+senen\b/i, /\bterowongan\s+senen\b/i],
  },
  {
    key: "underpass_mampang_kuningan",
    name: "Underpass Mampang-Kuningan",
    label: "Underpass Mampang-Kuningan, Jakarta Selatan",
    coordinates: [106.8280, -6.2420],
    patterns: [/\bunderpass\s+mampang(?:-kuningan)?\b/i, /\bterowongan\s+mampang\b/i],
  },
  {
    key: "underpass_matraman",
    name: "Underpass Matraman",
    label: "Underpass Matraman, Jakarta Timur",
    coordinates: [106.8610, -6.2020],
    patterns: [/\bunderpass\s+matraman\b/i, /\bterowongan\s+matraman\b/i],
  },
  {
    key: "underpass_kebayoran_lama",
    name: "Underpass Kebayoran Lama",
    label: "Underpass Kebayoran Lama, Jakarta Selatan",
    coordinates: [106.7770, -6.2370],
    patterns: [/\bunderpass\s+kebayoran\s+lama\b/i, /\bterowongan\s+kebayoran\s+lama\b/i],
  },
  {
    key: "underpass_pramuka",
    name: "Underpass Pramuka",
    label: "Underpass Pramuka, Jakarta Timur",
    coordinates: [106.8650, -6.1950],
    patterns: [/\bunderpass\s+pramuka\b/i, /\bterowongan\s+pramuka\b/i],
  },
  {
    key: "underpass_kuningan",
    name: "Underpass Kuningan",
    label: "Underpass Kuningan, Jakarta Selatan",
    coordinates: [106.8270, -6.2350],
    patterns: [/\bunderpass\s+kuningan\b/i, /\bterowongan\s+kuningan\b/i],
  },
  {
    key: "flyover_roxy_cideng",
    name: "Flyover Roxy / Cideng",
    label: "Flyover Roxy, Jakarta Barat",
    coordinates: [106.8080, -6.1660],
    patterns: [/\bflyover\s+roxy\b/i, /\bflyover\s+cideng\b/i, /\bjembatan\s+layang\s+roxy\b/i],
  },
  {
    key: "flyover_pancoran",
    name: "Flyover Pancoran",
    label: "Flyover Pancoran, Jakarta Selatan",
    coordinates: [106.8430, -6.2430],
    patterns: [/\bflyover\s+pancoran\b/i, /\bjembatan\s+layang\s+pancoran\b/i],
  },
  {
    key: "flyover_antasari",
    name: "Flyover Antasari",
    label: "Flyover Antasari, Jakarta Selatan",
    coordinates: [106.8050, -6.2620],
    patterns: [/\bflyover\s+antasari\b/i, /\bjlnt\s+antasari\b/i, /\bjembatan\s+layang\s+antasari\b/i, /\bantasari\b/i],
  },
  {
    key: "flyover_klender",
    name: "Flyover Klender",
    label: "Flyover Klender, Jakarta Timur",
    coordinates: [106.8990, -6.2140],
    patterns: [/\bflyover\s+klender\b/i, /\bjembatan\s+layang\s+klender\b/i],
  },
  {
    key: "flyover_saharjo_tebet",
    name: "Flyover Saharjo Tebet",
    label: "Flyover Saharjo, Jakarta Selatan",
    coordinates: [106.8510, -6.2190],
    patterns: [/\bflyover\s+saharjo\b/i, /\bjembatan\s+layang\s+saharjo\b/i],
  },
  {
    key: "flyover_rawamangun",
    name: "Flyover Rawamangun",
    label: "Flyover Rawamangun, Jakarta Timur",
    coordinates: [106.8840, -6.1930],
    patterns: [/\bflyover\s+rawamangun\b/i, /\bjembatan\s+layang\s+rawamangun\b/i],
  },

  // Transit Hubs & Rail Crossings
  {
    key: "stasiun_manggarai_transit",
    name: "Stasiun Manggarai Transit",
    label: "Stasiun Manggarai Transit, Jakarta Selatan",
    coordinates: [106.8500, -6.2098],
    patterns: [/\b(?:stasiun|st\.)\s+manggarai\b/i, /\bmanggarai\s+(?:transit|hub)\b/i, /\bmanggarai\b/i],
  },
  {
    key: "stasiun_tanah_abang_transit",
    name: "Stasiun Tanah Abang Transit",
    label: "Stasiun Tanah Abang Transit, Jakarta Pusat",
    coordinates: [106.8110, -6.1856],
    patterns: [/\b(?:stasiun|st\.)\s+tanah\s+abang\b/i],
  },
  {
    key: "stasiun_jatinegara",
    name: "Stasiun Jatinegara",
    label: "Stasiun Jatinegara, Jakarta Timur",
    coordinates: [106.8670, -6.2150],
    patterns: [/\b(?:stasiun|st\.)\s+jatinegara\b/i],
  },
  {
    key: "halte_csw_asean",
    name: "Halte CSW / ASEAN MRT Interchange",
    label: "Halte CSW ASEAN MRT, Jakarta Selatan",
    coordinates: [106.7985, -6.2395],
    patterns: [/\bhalte\s+csw\b/i, /\bcsw\s+asean\b/i, /\bmrt\s+asean\b/i, /\binterchange\s+csw\b/i, /\bsimpang\s+csw\b/i, /\bcsw\b/i],
  },
  {
    key: "halte_bundaran_hi_astra",
    name: "Halte Bundaran HI Astra",
    label: "Halte Bundaran HI Astra, Jakarta Pusat",
    coordinates: [106.8230, -6.1930],
    patterns: [/\bhalte\s+bundaran\s+hi\b/i, /\bmrt\s+bundaran\s+hi\b/i, /\bbundaran\s+hi\s+astra\b/i],
  },
  {
    key: "halte_harmoni_central",
    name: "Halte Harmoni Central",
    label: "Halte Harmoni Central, Jakarta Pusat",
    coordinates: [106.8190, -6.1640],
    patterns: [/\bhalte\s+harmoni\b/i, /\bharmoni\s+central\b/i, /\bcentral\s+harmoni\b/i],
  },
  {
    key: "terminal_bus_kampung_rambutan",
    name: "Terminal Bus Kampung Rambutan",
    label: "Terminal Kampung Rambutan, Jakarta Timur",
    coordinates: [106.8760, -6.3090],
    patterns: [/\bterminal\s+(?:bus\s+)?kampung\s+rambutan\b/i, /\bkampung\s+rambutan\b/i],
  },
  {
    key: "terminal_bus_pulo_gebang",
    name: "Terminal Bus Pulo Gebang",
    label: "Terminal Pulo Gebang, Jakarta Timur",
    coordinates: [106.9530, -6.2120],
    patterns: [/\bterminal\s+(?:bus\s+)?pulo\s*gebang\b/i, /\bpulo\s*gebang\b/i],
  },
  {
    key: "terminal_bus_kalideres",
    name: "Terminal Bus Kalideres",
    label: "Terminal Kalideres, Jakarta Barat",
    coordinates: [106.7020, -6.1550],
    patterns: [/\bterminal\s+(?:bus\s+)?kalideres\b/i],
  },
  {
    key: "stasiun_pasar_senen",
    name: "Stasiun Pasar Senen",
    label: "Stasiun Pasar Senen, Jakarta Pusat",
    coordinates: [106.8440, -6.1740],
    patterns: [/\b(?:stasiun|st\.)\s+(?:pasar\s+)?senen\b/i],
  },
  {
    key: "stasiun_sudirman_transit",
    name: "Stasiun Sudirman Transit",
    label: "Stasiun Sudirman Transit, Jakarta Pusat",
    coordinates: [106.8220, -6.2020],
    patterns: [/\b(?:stasiun|st\.)\s+sudirman\b/i, /\bmrt\s+dukuh\s+atas\b/i],
  },
  {
    key: "halte_tosari",
    name: "Halte Tosari",
    label: "Halte Tosari, Jakarta Pusat",
    coordinates: [106.8225, -6.1980],
    patterns: [/\bhalte\s+tosari\b/i],
  },
  {
    key: "halte_monas_mrt",
    name: "Halte Monas MRT",
    label: "Halte Monas MRT, Jakarta Pusat",
    coordinates: [106.8240, -6.1780],
    patterns: [/\bhalte\s+monas\b/i, /\bmrt\s+monas\b/i],
  },

  // Regional & District Toponyms
  // Jakarta Selatan
  {
    key: "mampang",
    name: "Mampang Prapatan",
    label: "Mampang Prapatan, Jakarta Selatan",
    coordinates: [106.8250, -6.2500],
    patterns: [/\bmampang(?:\s+prapatan)?\b/i],
  },
  {
    key: "kemang",
    name: "Kemang",
    label: "Kemang, Jakarta Selatan",
    coordinates: [106.8150, -6.2600],
    patterns: [/\bkemang(?:\s+raya)?\b/i, /\bbangka\b/i],
  },
  {
    key: "kebayoran_baru",
    name: "Kebayoran Baru",
    label: "Kebayoran Baru, Jakarta Selatan",
    coordinates: [106.7990, -6.2440],
    patterns: [/\bkebayoran\s+baru\b/i, /\bblok\s+m\b/i, /\bsenopati\b/i],
  },
  {
    key: "kebayoran_lama",
    name: "Kebayoran Lama",
    label: "Kebayoran Lama, Jakarta Selatan",
    coordinates: [106.7770, -6.2420],
    patterns: [/\bkebayoran\s+lama\b/i, /\bpondok\s+pinang\b/i],
  },
  {
    key: "pesanggrahan",
    name: "Pesanggrahan",
    label: "Pesanggrahan, Jakarta Selatan",
    coordinates: [106.7620, -6.2570],
    patterns: [/\bpesanggrahan\b/i, /\bbintaro\b/i, /\bpetukangan\b/i],
  },
  {
    key: "cilandak",
    name: "Cilandak",
    label: "Cilandak, Jakarta Selatan",
    coordinates: [106.7970, -6.2930],
    patterns: [/\bcilandak\b/i, /\bfatmawati\b/i, /\blebak\s+bulus\b/i, /\bpondok\s+labu\b/i],
  },
  {
    key: "pasar_minggu",
    name: "Pasar Minggu",
    label: "Pasar Minggu, Jakarta Selatan",
    coordinates: [106.8330, -6.2840],
    patterns: [/\bpasar\s+minggu\b/i, /\bpejaten\b/i, /\bragunan\b/i, /\bjatipadang\b/i],
  },
  {
    key: "jagakarsa",
    name: "Jagakarsa",
    label: "Jagakarsa, Jakarta Selatan",
    coordinates: [106.8250, -6.3330],
    patterns: [/\bjagakarsa\b/i, /\blenteng\s+agung\b/i, /\btanjung\s+barat\b/i, /\bsrengseng\s+sawah\b/i],
  },
  {
    key: "pancoran",
    name: "Pancoran",
    label: "Pancoran, Jakarta Selatan",
    coordinates: [106.8450, -6.2500],
    patterns: [/\bpancoran\b/i, /\bkalibata\b/i, /\bduren\s+tiga\b/i],
  },
  {
    key: "tebet",
    name: "Tebet",
    label: "Tebet, Jakarta Selatan",
    coordinates: [106.8570, -6.2290],
    patterns: [/\btebet\b/i, /\bmanggarai\b/i, /\bbukit\s+duri\b/i],
  },
  {
    key: "setiabudi",
    name: "Setiabudi",
    label: "Setiabudi, Jakarta Selatan",
    coordinates: [106.8290, -6.2150],
    patterns: [/\bsetiabudi\b/i, /\bkuningan\b/i, /\bkaret\b/i],
  },

  // Jakarta Timur
  {
    key: "rawamangun",
    name: "Rawamangun",
    label: "Rawamangun, Jakarta Timur",
    coordinates: [106.8870, -6.1950],
    patterns: [/\brawamangun\b/i],
  },
  {
    key: "pulo_gadung",
    name: "Pulo Gadung",
    label: "Pulo Gadung, Jakarta Timur",
    coordinates: [106.8920, -6.1920],
    patterns: [/\bpulo\s*gadung\b/i, /\bkayu\s+putih\b/i],
  },
  {
    key: "matraman",
    name: "Matraman",
    label: "Matraman, Jakarta Timur",
    coordinates: [106.8620, -6.2050],
    patterns: [/\bmatraman\b/i, /\butan\s+kayu\b/i],
  },
  {
    key: "jatinegara",
    name: "Jatinegara",
    label: "Jatinegara, Jakarta Timur",
    coordinates: [106.8710, -6.2280],
    patterns: [/\bjatinegara\b/i, /\bkampung\s+melayu\b/i, /\bbidara\s+cina\b/i, /\bcipinang\b/i],
  },
  {
    key: "duren_sawit",
    name: "Duren Sawit",
    label: "Duren Sawit, Jakarta Timur",
    coordinates: [106.9150, -6.2340],
    patterns: [/\bduren\s+sawit\b/i, /\bpondok\s+kelapa\b/i, /\bpondok\s+bambu\b/i, /\bklender\b/i],
  },
  {
    key: "kramat_jati",
    name: "Kramat Jati",
    label: "Kramat Jati, Jakarta Timur",
    coordinates: [106.8680, -6.2750],
    patterns: [/\bkramat\s+jati\b/i, /\bcililitan\b/i, /\bcawang\b/i, /\btol\s+cawang\b/i],
  },
  {
    key: "makasar",
    name: "Makasar",
    label: "Makasar, Jakarta Timur",
    coordinates: [106.8830, -6.2750],
    patterns: [/\bmakasar\b/i, /\bhalim(?:\s+perdanakusuma)?\b/i, /\bpinang\s+ranti\b/i],
  },
  {
    key: "pasar_rebo",
    name: "Pasar Rebo",
    label: "Pasar Rebo, Jakarta Timur",
    coordinates: [106.8600, -6.3150],
    patterns: [/\bpasar\s+rebo\b/i, /\bpekayon\b/i, /\bgedong\b/i],
  },
  {
    key: "ciracas",
    name: "Ciracas",
    label: "Ciracas, Jakarta Timur",
    coordinates: [106.8780, -6.3300],
    patterns: [/\bciracas\b/i, /\bcibubur\b/i, /\bkelapa\s+dua\s+wetan\b/i],
  },
  {
    key: "cipayung",
    name: "Cipayung",
    label: "Cipayung, Jakarta Timur",
    coordinates: [106.8950, -6.3150],
    patterns: [/\bcipayung\b/i, /\bbambu\s+apus\b/i, /\blubang\s+buaya\b/i],
  },
  {
    key: "cakung",
    name: "Cakung",
    label: "Cakung, Jakarta Timur",
    coordinates: [106.9480, -6.1920],
    patterns: [/\bcakung\b/i, /\bpulo\s+gebang\b/i, /\bpenggilingan\b/i],
  },

  // Jakarta Barat
  {
    key: "cengkareng",
    name: "Cengkareng",
    label: "Cengkareng, Jakarta Barat",
    coordinates: [106.7320, -6.1520],
    patterns: [/\bcengkareng\b/i, /\brawa\s+buaya\b/i, /\bkapuk\b/i],
  },
  {
    key: "grogol",
    name: "Grogol Petamburan",
    label: "Grogol Petamburan, Jakarta Barat",
    coordinates: [106.7870, -6.1650],
    patterns: [/\bgrogol(?:\s+petamburan)?\b/i, /\btomang\b/i, /\bjelambar\b/i, /\btanjung\s+duren\b/i],
  },
  {
    key: "taman_sari",
    name: "Taman Sari",
    label: "Taman Sari, Jakarta Barat",
    coordinates: [106.8170, -6.1450],
    patterns: [/\btaman\s+sari\b/i, /\bglodok\b/i, /\bpinangsia\b/i],
  },
  {
    key: "tambora",
    name: "Tambora",
    label: "Tambora, Jakarta Barat",
    coordinates: [106.8040, -6.1480],
    patterns: [/\btambora\b/i, /\bangke\b/i, /\bjembatan\s+besi\b/i, /\bjembatan\s+lima\b/i],
  },
  {
    key: "kebon_jeruk",
    name: "Kebon Jeruk",
    label: "Kebon Jeruk, Jakarta Barat",
    coordinates: [106.7720, -6.1940],
    patterns: [/\bkebon\s+jeruk\b/i, /\bkedoya\b/i, /\bsukabumi\s+selatan\b/i],
  },
  {
    key: "kalideres",
    name: "Kalideres",
    label: "Kalideres, Jakarta Barat",
    coordinates: [106.7020, -6.1500],
    patterns: [/\bkalideres\b/i, /\bsemanan\b/i, /\btegal\s+alur\b/i],
  },
  {
    key: "palmerah",
    name: "Palmerah",
    label: "Palmerah, Jakarta Barat",
    coordinates: [106.7950, -6.1980],
    patterns: [/\bpalmerah\b/i, /\bslipi\b/i, /\bkemanggisan\b/i],
  },
  {
    key: "kembangan",
    name: "Kembangan",
    label: "Kembangan, Jakarta Barat",
    coordinates: [106.7450, -6.1880],
    patterns: [/\bkembangan\b/i, /\bpuri\s+indah\b/i, /\bmeruya\b/i, /\bjoglo\b/i],
  },

  // Jakarta Utara
  {
    key: "kelapa_gading",
    name: "Kelapa Gading",
    label: "Kelapa Gading, Jakarta Utara",
    coordinates: [106.9080, -6.1580],
    patterns: [/\bkelapa\s+gading\b/i, /\bpegangsaan\s+dua\b/i],
  },
  {
    key: "tanjung_priok",
    name: "Tanjung Priok",
    label: "Tanjung Priok, Jakarta Utara",
    coordinates: [106.8820, -6.1180],
    patterns: [/\btanjung\s+priok\b/i, /\bsunter\b/i, /\bwarakas\b/i],
  },
  {
    key: "koja",
    name: "Koja",
    label: "Koja, Jakarta Utara",
    coordinates: [106.9050, -6.1250],
    patterns: [/\bkoja\b/i, /\blagoa\b/i, /\brawa\s+badak\b/i],
  },
  {
    key: "pademangan",
    name: "Pademangan",
    label: "Pademangan, Jakarta Utara",
    coordinates: [106.8400, -6.1330],
    patterns: [/\bpademangan\b/i, /\bancol\b/i],
  },
  {
    key: "penjaringan",
    name: "Penjaringan",
    label: "Penjaringan, Jakarta Utara",
    coordinates: [106.7900, -6.1280],
    patterns: [/\bpenjaringan\b/i, /\bpluit\b/i, /\bmuara\s+(?:baru|angke|karang)\b/i, /\bkamal\s+muara\b/i],
  },
  {
    key: "cilincing",
    name: "Cilincing",
    label: "Cilincing, Jakarta Utara",
    coordinates: [106.9380, -6.1250],
    patterns: [/\bcilincing\b/i, /\bmarunda\b/i, /\brorotan\b/i],
  },

  // Jakarta Pusat
  {
    key: "senen",
    name: "Senen",
    label: "Senen, Jakarta Pusat",
    coordinates: [106.8442, -6.1823],
    patterns: [/\b(?:pasar\s+)?senen\b/i, /\bkramat\b/i, /\bkwitang\b/i],
  },
  {
    key: "gambir",
    name: "Gambir",
    label: "Gambir, Jakarta Pusat",
    coordinates: [106.8302, -6.1754],
    patterns: [/\bgambir\b/i, /\bmonas\b/i, /\bmedan\s+merdeka\b/i],
  },
  {
    key: "sawah_besar",
    name: "Sawah Besar",
    label: "Sawah Besar, Jakarta Pusat",
    coordinates: [106.8322, -6.1550],
    patterns: [/\bsawah\s+besar\b/i, /\bpasar\s+baru\b/i, /\bmangga\s+dua\b/i],
  },
  {
    key: "kemayoran",
    name: "Kemayoran",
    label: "Kemayoran, Jakarta Pusat",
    coordinates: [106.8550, -6.1600],
    patterns: [/\bkemayoran\b/i, /\bserdang\b/i],
  },
  {
    key: "cempaka_putih",
    name: "Cempaka Putih",
    label: "Cempaka Putih, Jakarta Pusat",
    coordinates: [106.8680, -6.1830],
    patterns: [/\bcempaka\s+putih\b/i, /\brawasari\b/i],
  },
  {
    key: "menteng",
    name: "Menteng",
    label: "Menteng, Jakarta Pusat",
    coordinates: [106.8320, -6.1960],
    patterns: [/\bmenteng\b/i, /\bcikini\b/i, /\bgondangdia\b/i],
  },
  {
    key: "tanah_abang",
    name: "Tanah Abang",
    label: "Tanah Abang, Jakarta Pusat",
    coordinates: [106.8150, -6.1900],
    patterns: [/\btanah\s+abang\b/i, /\bpetamburan\b/i, /\bbendungan\s+hilir\b/i, /\bbenhil\b/i, /\bpejompongan\b/i],
  },
  {
    key: "johar_baru",
    name: "Johar Baru",
    label: "Johar Baru, Jakarta Pusat",
    coordinates: [106.8580, -6.1850],
    patterns: [/\bjohar\s+baru\b/i, /\bkampung\s+rawa\b/i],
  },
  {
    key: "harmoni",
    name: "Harmoni",
    label: "Harmoni, Jakarta Pusat",
    coordinates: [106.8190, -6.1630],
    patterns: [/\bharmoni\b/i],
  },

  // Prominent Corridors
  {
    key: "gatot_subroto",
    name: "Gatot Subroto",
    label: "Gatot Subroto, Jakarta Selatan",
    coordinates: [106.8250, -6.2350],
    patterns: [/\b(?:jl\.?|jalan\s+)?gatot\s+subroto\b/i],
  },
  {
    key: "sudirman",
    name: "Sudirman",
    label: "Sudirman, Jakarta Pusat",
    coordinates: [106.8230, -6.2080],
    patterns: [/\b(?:jl\.?|jalan\s+)?sudirman\b/i],
  },
  {
    key: "thamrin",
    name: "Thamrin",
    label: "Thamrin, Jakarta Pusat",
    coordinates: [106.8240, -6.1920],
    patterns: [/\b(?:jl\.?|jalan\s+)?thamrin\b/i],
  },
  {
    key: "rasuna_said",
    name: "Rasuna Said",
    label: "Rasuna Said, Jakarta Selatan",
    coordinates: [106.8310, -6.2190],
    patterns: [/\b(?:jl\.?|jalan\s+)?rasuna\s+said\b/i],
  },
  {
    key: "mt_haryono",
    name: "MT Haryono",
    label: "MT Haryono, Jakarta Timur",
    coordinates: [106.8650, -6.2430],
    patterns: [/\b(?:jl\.?|jalan\s+)?mt\s+haryono\b/i],
  },
  {
    key: "daan_mogot",
    name: "Daan Mogot",
    label: "Daan Mogot, Jakarta Barat",
    coordinates: [106.7500, -6.1550],
    patterns: [/\b(?:jl\.?|jalan\s+)?daan\s+mogot\b/i],
  },
  // Kepulauan Seribu
  {
    key: "kepulauan_seribu",
    name: "Kepulauan Seribu",
    label: "Kepulauan Seribu, DKI Jakarta",
    coordinates: [106.5200, -5.7800],
    patterns: [/\bkepulauan\s+seribu\b/i, /\bpulau\s+tidung\b/i, /\bpulau\s+pramuka\b/i, /\bpulau\s+pari\b/i, /\bpulau\s+harapan\b/i, /\bpulau\s+untung\s+jawa\b/i],
  },
  // Wilayah Administrasi Umum & Singkatan
  {
    key: "jakarta_pusat",
    name: "Jakarta Pusat",
    label: "Jakarta Pusat, DKI Jakarta",
    coordinates: [106.8340, -6.1800],
    patterns: [/\bjakarta\s+pusat\b/i, /\bjakpus\b/i],
  },
  {
    key: "jakarta_selatan",
    name: "Jakarta Selatan",
    label: "Jakarta Selatan, DKI Jakarta",
    coordinates: [106.8100, -6.2600],
    patterns: [/\bjakarta\s+selatan\b/i, /\bjaksel\b/i],
  },
  {
    key: "jakarta_barat",
    name: "Jakarta Barat",
    label: "Jakarta Barat, DKI Jakarta",
    coordinates: [106.7500, -6.1600],
    patterns: [/\bjakarta\s+barat\b/i, /\bjakbar\b/i],
  },
  {
    key: "jakarta_timur",
    name: "Jakarta Timur",
    label: "Jakarta Timur, DKI Jakarta",
    coordinates: [106.8800, -6.2300],
    patterns: [/\bjakarta\s+timur\b/i, /\bjaktim\b/i],
  },
  {
    key: "jakarta_utara",
    name: "Jakarta Utara",
    label: "Jakarta Utara, DKI Jakarta",
    coordinates: [106.8900, -6.1300],
    patterns: [/\bjakarta\s+utara\b/i, /\bjakut\b/i],
  },
];

/**
 * Administrative parent region mapping connecting Jakarta kecamatans/districts
 * to their respective administrative city (Kota Administrasi).
 */
export const DISTRICT_PARENT_MAP: Readonly<Record<string, string>> = Object.freeze({
  // Jakarta Selatan
  mampang: "jakarta_selatan",
  kemang: "jakarta_selatan",
  kebayoran_baru: "jakarta_selatan",
  kebayoran_lama: "jakarta_selatan",
  pesanggrahan: "jakarta_selatan",
  cilandak: "jakarta_selatan",
  pasar_minggu: "jakarta_selatan",
  jagakarsa: "jakarta_selatan",
  pancoran: "jakarta_selatan",
  tebet: "jakarta_selatan",
  setiabudi: "jakarta_selatan",
  rasuna_said: "jakarta_selatan",
  kalibata: "jakarta_selatan",
  blok_m: "jakarta_selatan",
  senayan: "jakarta_selatan",
  fatmawati: "jakarta_selatan",
  lebak_bulus: "jakarta_selatan",
  pondok_indah: "jakarta_selatan",

  // Jakarta Timur
  rawamangun: "jakarta_timur",
  pulo_gadung: "jakarta_timur",
  matraman: "jakarta_timur",
  jatinegara: "jakarta_timur",
  duren_sawit: "jakarta_timur",
  kramat_jati: "jakarta_timur",
  makasar: "jakarta_timur",
  pasar_rebo: "jakarta_timur",
  ciracas: "jakarta_timur",
  cipayung: "jakarta_timur",
  cakung: "jakarta_timur",
  mt_haryono: "jakarta_timur",
  cawang: "jakarta_timur",
  cibubur: "jakarta_timur",

  // Jakarta Barat
  cengkareng: "jakarta_barat",
  grogol: "jakarta_barat",
  grogol_petamburan: "jakarta_barat",
  taman_sari: "jakarta_barat",
  tambora: "jakarta_barat",
  kebon_jeruk: "jakarta_barat",
  kalideres: "jakarta_barat",
  palmerah: "jakarta_barat",
  kembangan: "jakarta_barat",
  slipi: "jakarta_barat",
  tomang: "jakarta_barat",
  daan_mogot: "jakarta_barat",

  // Jakarta Pusat
  gambir: "jakarta_pusat",
  sawah_besar: "jakarta_pusat",
  kemayoran: "jakarta_pusat",
  senen: "jakarta_pusat",
  cempaka_putih: "jakarta_pusat",
  menteng: "jakarta_pusat",
  tanah_abang: "jakarta_pusat",
  johar_baru: "jakarta_pusat",
  monas: "jakarta_pusat",
  thamrin: "jakarta_pusat",
  sudirman: "jakarta_pusat",
  harmoni: "jakarta_pusat",
  pejompongan: "jakarta_pusat",
  benhil: "jakarta_pusat",
  glodok: "jakarta_pusat",

  // Jakarta Utara
  tanjung_priok: "jakarta_utara",
  kelapa_gading: "jakarta_utara",
  koja: "jakarta_utara",
  cilincing: "jakarta_utara",
  pademangan: "jakarta_utara",
  penjaringan: "jakarta_utara",
  pluit: "jakarta_utara",
  ancol: "jakarta_utara",

  // Kepulauan Seribu
  pulau_tidung: "kepulauan_seribu",
  pulau_pramuka: "kepulauan_seribu",
  pulau_pari: "kepulauan_seribu",
  pulau_harapan: "kepulauan_seribu",
  pulau_untung_jawa: "kepulauan_seribu",
});

export function getToponymParentRegion(toponymKey: string): string | null {
  return DISTRICT_PARENT_MAP[toponymKey] ?? null;
}
/**
 * Non-Jakarta location patterns for rejecting off-topic reports.
 */
export const NON_JAKARTA_CITIES: readonly RegExp[] = [
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
  /\bbogor\b/i,
  /\bdepok\b/i,
  /\btangerang(?!\s+selatan)\b/i,
  /\bbekasi\b/i,
  /\bcianjur\b/i,
  /\bsukabumi\b/i,
];

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
 * Finds matching Jakarta toponym from text.
 */
export function findJakartaToponym(text: string): JakartaToponym | null {
  for (const toponym of JAKARTA_TOPONYMS) {
    for (const pattern of toponym.patterns) {
      if (pattern.test(text)) {
        return toponym;
      }
    }
  }
  return null;
}

/**
 * Extracts coordinate and location metadata from a report revision.
 */
export function extractReportLocation(
  report: StoredReportRevision,
): {
  readonly locationLabel: string;
  readonly coordinates: readonly [number, number] | null;
  readonly toponymKey?: string;
} | null {
  const text = report.permitted_text;

  // 1. Explicit bracketed coordinates: [lon, lat] or [lat, lon]
  const coordRegex = /\[\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*\]/;
  const match = text.match(coordRegex);
  let explicitCoords: [number, number] | null = null;
  if (match && match[1] && match[2]) {
    const p1 = Number(match[1]);
    const p2 = Number(match[2]);
    if (
      p1 >= JAKARTA_ENVELOPE.west &&
      p1 <= JAKARTA_ENVELOPE.east &&
      p2 >= JAKARTA_ENVELOPE.south &&
      p2 <= JAKARTA_ENVELOPE.north
    ) {
      explicitCoords = [p1, p2];
    } else if (
      p2 >= JAKARTA_ENVELOPE.west &&
      p2 <= JAKARTA_ENVELOPE.east &&
      p1 >= JAKARTA_ENVELOPE.south &&
      p1 <= JAKARTA_ENVELOPE.north
    ) {
      explicitCoords = [p2, p1];
    }
  }

  // 2. Gazetteer toponym match
  const matchedToponym = findJakartaToponym(text);

  // 3. Reject if explicitly mentions non-Jakarta city and no Jakarta toponym found
  if (!matchedToponym && !explicitCoords) {
    for (const nonJkt of NON_JAKARTA_CITIES) {
      if (nonJkt.test(text)) {
        return null;
      }
    }
  }

  if (matchedToponym) {
    return {
      locationLabel: matchedToponym.label,
      coordinates: explicitCoords ?? matchedToponym.coordinates,
      toponymKey: matchedToponym.key,
    };
  }

  if (explicitCoords) {
    return {
      locationLabel: "DKI Jakarta",
      coordinates: explicitCoords,
    };
  }

  const isJakartaScopedSource =
    report.source_id.includes("jakarta") ||
    report.source_id.includes("metro") ||
    report.source_id.includes("petabencana");

  if (isJakartaScopedSource) {
    return {
      locationLabel: "DKI Jakarta",
      coordinates: [106.8272, -6.1754],
    };
  }

  return null;
}

/**
 * Extracts a numeric Unix epoch millisecond timestamp for temporal comparisons.
 */
export function extractReportTimestamp(report: StoredReportRevision): number {
  if (report.published_at) {
    const parsed = Date.parse(report.published_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const matchRfc = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/.exec(
    report.permitted_text,
  );
  if (matchRfc) {
    const parsed = Date.parse(matchRfc[0]);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const parsedRetrieved = Date.parse(report.retrieved_at);
  if (!Number.isNaN(parsedRetrieved)) return parsedRetrieved;

  return Date.now();
}

/**
 * Categorizes a report based on keyword patterns.
 */
export function detectReportCategory(report: StoredReportRevision): IncidentCategory | null {
  const text = report.permitted_text.toLowerCase();

  const rules: readonly { readonly category: IncidentCategory; readonly weight: number; readonly regex: RegExp }[] = [
    { category: "tree_fall", weight: 20, regex: /\b(pohon\s+tumbang|dahan\s+patah|batang\s+pohon\s+roboh)\b/i },
    { category: "fire", weight: 20, regex: /\b(kebakaran|si\s+jago\s+merah|kobaran\s+api|damkar|gulkarmat|hangus\s+terbakar)\b/i },
    {
      category: "accident",
      weight: 22,
      regex: /\b(kecelakaan|laka\s+lantas|tabrakan\s+beruntun|tabrakan|terguling|adu\s+banteng|rekayasa\s+(?:lalu\s+lintas|lalin)|penutupan\s+jalan|pengalihan\s+arus|contraflow|macet\s+(?:total|parah)|antrean\s+kendaraan|truk\s+terguling|transjakarta\s+dialihkan|rute\s+distop|krl\s+anjlok|gangguan\s+persinyalan|krl\s+tertahan|underpass\s+tergenang|jalan\s+amblas|catenary\s+putus)\b/i,
    },
    { category: "flood", weight: 20, regex: /\b(banjir|genangan(?:\s+air)?|tergenang|tanggul\s+jebol|rob|luapan\s+kali)\b/i },
    { category: "crime", weight: 20, regex: /\b(tawuran|bentrokan|begal|penusukan|perampokan|curanmor|tewas|meninggal|pembunuhan|jenazah|korban|terbunuh)/i },
    { category: "weather", weight: 20, regex: /\b(cuaca\s+ekstrem|puting\s+beliung|angin\s+kencang|hujan\s+lebat|hujan\s+deras|badai|longsor|gempa(?:\s+bumi)?|getaran\s+gempa)\b/i },
  ];

  let bestCat: IncidentCategory | null = null;
  let bestWeight = 0;

  for (const rule of rules) {
    if (rule.regex.test(text) && rule.weight > bestWeight) {
      bestWeight = rule.weight;
      bestCat = rule.category;
    }
  }

  // Fallback checking source_id or canonical_url
  if (!bestCat) {
    if (report.source_id.includes("petabencana") || report.canonical_url.includes("flood")) {
      bestCat = "flood";
    }
  }

  return bestCat;
}

/**
 * Checks category compatibility between two reports.
 */
export function areCategoriesCompatible(
  catA: IncidentCategory,
  catB: IncidentCategory,
  textA: string = "",
  textB: string = "",
): boolean {
  if (catA === catB) return true;

  // Flood and Weather cross-compatibility
  if (
    (catA === "flood" && catB === "weather") ||
    (catA === "weather" && catB === "flood")
  ) {
    const combined = `${textA} ${textB}`.toLowerCase();
    if (
      combined.includes("banjir") ||
      combined.includes("genangan") ||
      combined.includes("tergenang") ||
      combined.includes("hujan")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if two location descriptors are spatially proximate (Haversine <= 1,200m OR shared toponym).
 */
export function areLocationsProximate(
  locA: { readonly locationLabel: string; readonly coordinates: readonly [number, number] | null; readonly toponymKey?: string } | null,
  locB: { readonly locationLabel: string; readonly coordinates: readonly [number, number] | null; readonly toponymKey?: string } | null,
): boolean {
  if (!locA || !locB) return false;

  // 1. Shared toponym match (exact match or parent administrative region match)
  if (locA.toponymKey && locB.toponymKey) {
    if (locA.toponymKey === locB.toponymKey) {
      return true;
    }
    const parentA = getToponymParentRegion(locA.toponymKey);
    const parentB = getToponymParentRegion(locB.toponymKey);
    if (parentA === locB.toponymKey || parentB === locA.toponymKey) {
      return true;
    }
    // Sibling kecamatans within the same administrative region if spatial distance <= 2,500m
    if (parentA && parentA === parentB && locA.coordinates && locB.coordinates) {
      const dist = haversineDistanceMeters(locA.coordinates, locB.coordinates);
      if (dist <= 2500) {
        return true;
      }
    }
  }

  // 2. Haversine distance match (<= 1,200m)
  if (locA.coordinates && locB.coordinates) {
    const dist = haversineDistanceMeters(locA.coordinates, locB.coordinates);
    if (dist <= JAKARTA_CORRELATION_LIMITS.maxSpatialDistanceMeters) {
      return true;
    }
  }

  return false;
}

/**
 * Suppresses duplicate reports from the same source within 6 hours.
 */
export function suppressDuplicateReports(
  reports: readonly StoredReportRevision[],
): readonly StoredReportRevision[] {
  const accepted: StoredReportRevision[] = [];

  for (const report of reports) {
    let isDuplicate = false;
    const repCat = detectReportCategory(report);
    const repTime = extractReportTimestamp(report);
    const repLoc = extractReportLocation(report);

    for (const existing of accepted) {
      if (existing.source_id !== report.source_id) {
        continue;
      }

      // Exact ID / hash duplicates
      if (
        existing.report_revision_id === report.report_revision_id ||
        existing.canonical_url === report.canonical_url ||
        existing.permitted_text_hash === report.permitted_text_hash
      ) {
        isDuplicate = true;
        break;
      }

      // Same source reporting on same incident within 6-hour duplicate window
      const existCat = detectReportCategory(existing);
      if (
        repCat &&
        existCat &&
        areCategoriesCompatible(repCat, existCat, report.permitted_text, existing.permitted_text)
      ) {
        const existTime = extractReportTimestamp(existing);
        const timeDiff = Math.abs(repTime - existTime);
        if (timeDiff <= JAKARTA_CORRELATION_LIMITS.duplicateWindowMs) {
          const existLoc = extractReportLocation(existing);
          if (areLocationsProximate(repLoc, existLoc)) {
            isDuplicate = true;
            break;
          }
        }
      }
    }

    if (!isDuplicate) {
      accepted.push(report);
    }
  }

  return accepted;
}

interface MutableCluster {
  cluster_id: string;
  primary_category: IncidentCategory;
  location_label: string;
  coordinates: [number, number] | null;
  toponymKey?: string;
  hasExactCoordinates: boolean;
  reports: StoredReportRevision[];
  sources: Set<string>;
  earliestTimestamp: number;
}

/**
 * Correlates source report revisions across distinct sources into incident clusters.
 *
 * Enforces:
 * - Spatial proximity (Haversine <= 1,200m or shared Jakarta kelurahan/kecamatan toponym)
 * - Temporal proximity (Observation/publication delta <= 4 hours)
 * - Category compatibility (Same incident category or compatible hazard types)
 * - Deduplication (Duplicate reports from the same source within 6 hours suppressed)
 */
export function correlateSourceReports(
  reports: readonly StoredReportRevision[],
): CorrelatedIncidentCluster[] {
  if (!Array.isArray(reports) || reports.length === 0) {
    return [];
  }

  // Step 1: Suppress duplicate reports from the same source within 6 hours
  const deduplicated = suppressDuplicateReports(reports);

  const clusters: MutableCluster[] = [];

  for (const report of deduplicated) {
    const category = detectReportCategory(report);
    if (!category) {
      // Discard non-incident report
      continue;
    }

    const location = extractReportLocation(report);
    if (!location) {
      // Discard report outside Jakarta
      continue;
    }

    const timestamp = extractReportTimestamp(report);
    const hasExactCoords = Boolean(
      report.permitted_text.match(/\[\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*\]/),
    );

    // Find best correlating existing cluster
    let matchedCluster: MutableCluster | null = null;

    for (const cluster of clusters) {
      // Category compatibility
      if (!areCategoriesCompatible(cluster.primary_category, category, cluster.reports[0]?.permitted_text, report.permitted_text)) {
        continue;
      }

      // Temporal proximity (<= 4 hours)
      const timeDiff = Math.abs(timestamp - cluster.earliestTimestamp);
      if (timeDiff > JAKARTA_CORRELATION_LIMITS.maxTemporalWindowMs) {
        continue;
      }

      // Spatial proximity (<= 1,200m or shared toponym)
      const clusterLoc = {
        locationLabel: cluster.location_label,
        coordinates: cluster.coordinates,
        toponymKey: cluster.toponymKey,
      };
      if (areLocationsProximate(clusterLoc, location)) {
        matchedCluster = cluster;
        break;
      }
    }

    if (matchedCluster) {
      matchedCluster.reports.push(report);
      matchedCluster.sources.add(report.source_id);

      // Upgrade coordinates to exact GPS coordinates if available
      if (hasExactCoords && location.coordinates && !matchedCluster.hasExactCoordinates) {
        matchedCluster.coordinates = [location.coordinates[0], location.coordinates[1]];
        matchedCluster.hasExactCoordinates = true;
      }

      // If cluster label was generic (DKI Jakarta or parent administrative city) and this report has a more specific child district, upgrade label and coordinates
      const currentParent = matchedCluster.toponymKey ? getToponymParentRegion(matchedCluster.toponymKey) : null;
      const isCurrentParent = !currentParent;
      const newParent = location.toponymKey ? getToponymParentRegion(location.toponymKey) : null;

      if (
        matchedCluster.location_label === "DKI Jakarta" ||
        (isCurrentParent && newParent === matchedCluster.toponymKey)
      ) {
        matchedCluster.location_label = location.locationLabel;
        matchedCluster.toponymKey = location.toponymKey;
        if (location.coordinates && !matchedCluster.hasExactCoordinates) {
          matchedCluster.coordinates = [location.coordinates[0], location.coordinates[1]];
        }
      }
      if (timestamp < matchedCluster.earliestTimestamp) {
        matchedCluster.earliestTimestamp = timestamp;
      }
    } else {
      const slugLocation = location.locationLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const clusterId = `cluster-${category}-${slugLocation}-${timestamp}`;

      clusters.push({
        cluster_id: clusterId,
        primary_category: category,
        location_label: location.locationLabel,
        coordinates: location.coordinates ? [location.coordinates[0], location.coordinates[1]] : null,
        toponymKey: location.toponymKey,
        hasExactCoordinates: hasExactCoords,
        reports: [report],
        sources: new Set([report.source_id]),
        earliestTimestamp: timestamp,
      });
    }
  }

  // Convert to frozen CorrelatedIncidentCluster array
  return clusters.map((c) => ({
    cluster_id: c.cluster_id,
    primary_category: c.primary_category,
    location_label: c.location_label,
    coordinates: c.coordinates,
    reports: c.reports,
    is_multi_source: c.sources.size >= 2,
    sources: Array.from(c.sources),
  }));
}
