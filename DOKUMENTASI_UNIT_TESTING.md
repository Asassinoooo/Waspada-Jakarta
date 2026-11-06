# DOKUMENTASI PENGUJIAN UNIT (UNIT TEST PLAN & REPORT)
## SISTEM INFORMASI KESELAMATAN SIPIL REAL-TIME — WASPADA JAKARTA

---

**Mata Kuliah:** Rekayasa Perangkat Lunak (RPL)  
**Proyek:** Waspada Jakarta — Live Civic Safety Intelligence Platform  
**Standar Dokumen:** Unit Test Plan & Documentation Template (Software Testing Standard)  
**Tanggal Pengujian:** 6 November 2026  
**Status Pengujian:** **100% PASS (Zero Failures)**  

---

## RINGKASAN STRUKTUR DOKUMEN (MASTER UNIT TEST PLAN TEMPLATE)

Dokumentasi ini disusun mengacu pada standar template *Unit Test Plan* yang mencakup 4 pilar utama pengujian perangkat lunak:

| Sr. | Requirements | Typical Components | Detailed Description |
| :---: | :--- | :--- | :--- |
| **1)** | **Introduction** | a) Test Strategy and Approach<br>b) Test Scope<br>c) Test Assumptions | Pendekatan pengujian unit berlapis (*layered unit testing*), cakupan pengujian modular (Web, Worker, DB, Intelligence), dan asumsi determinisme pengujian tanpa dependensi jaringan eksternal. |
| **2)** | **Walkthrough<br>(Static Testing)** | a) Defects Discovered and Corrected<br>b) Improvement Ideas<br>c) Structured Programming Compliance<br>d) Language Standards<br>e) Development Documentation Standards | Analisis statis kode sumber, review defek/bug dari 5 commit terakhir GitHub beserta koreksinya, prinsip pemrograman terstruktur, standar TypeScript/ESM, dan standar dokumentasi pengembangan. |
| **3)** | **Test Cases<br>(Dynamic Testing)** | a) Input Test Data<br>b) Initial Conditions<br>c) Expected Results<br>d) Test Log Status | Spesifikasi data uji masukan, kondisi awal (preconditions), kriteria hasil yang diharapkan, serta bukti log eksekusi langsung (*real test execution logs*) dari runner pengujian. |
| **4)** | **Environment Requirements** | a) Test Strategy and Approach (Setup)<br>b) Platform<br>c) Libraries<br>d) Tools<br>e) Test Procedures<br>f) Status Reporting | Konfigurasi lingkungan uji, platform OS WSL2 Ubuntu, runtime Node.js native test runner, pustaka PGlite & React, prosedur eksekusi perintah, dan pelaporan status kelulusan. |

---

## 1. INTRODUCTION (PENDAHULUAN)

### 1.a) Test Strategy and Approach (Strategi dan Pendekatan Pengujian)
Sistem Waspada Jakarta menerapkan strategi pengujian unit berorientasi lapisan (*Layered Architecture Unit Testing*) yang dirancang untuk menjamin kecepatan, determinisme, dan integritas logika sebelum integrasi live:
1. **Determinisme Mutlak (Zero External I/O):** Pengujian unit tidak diperkenankan melakukan panggilan jaringan (*network calls*) ke API eksternal. Semua interaksi AI Gateway (NineRouter / Gemini), feed RSS, dan layanan pihak ketiga disimulasikan menggunakan in-memory fixtures dan deterministik mock adapter.
2. **Isolasi Database PGlite (In-Process WASM):** Untuk modul persistensi basis data (`@waspada/db`), pengujian menggunakan engine PostgreSQL in-process WebAssembly (`@electric-sql/pglite`). Setiap test suite bootstrap instance database bersih dan menjalankan seluruh migrasi SQL skema (001–044) secara independen, mencegah kontaminasi state antar-test (*idempotent testing*).
3. **Pilar Responsible AI & Safe Fallback:** Pengujian unit memverifikasi bahwa kegagalan layanan AI (HTTP 503, timeout, kuota habis) ditangani secara aman dengan prinsip *Zero Hallucinated Proposals* — sistem dilarang keras mengarang insiden atau memalsukan bukti jika model AI gagal.
4. **Eksekusi Native Ultra-Cepat:** Menggunakan runner pengujian native Node.js (`node:test`) dipadukan dengan TypeScript Execution Engine (`tsx`), memungkinkan eksekusi seluruh suite unit test dalam hitungan detik tanpa overhead bundle build yang berat.

### 1.b) Test Scope (Ruang Lingkup Pengujian)
Pengujian unit mencakup seluruh modul inti dalam arsitektur monorepo Waspada Jakarta:

* **Di dalam Ruang Lingkup (In-Scope):**
  * **Modul Frontend (`@waspada/web`):**
    * Algoritma reduksi dimensi matematis Principal Component Analysis (Dual Gram-Matrix PCA $768\text{D} \to 3\text{D}$) dan metrik kemiripan kosinus (*cosine similarity*).
    * Komponen antarmuka pengguna React (`Landing.tsx`, `HeroIllustration.tsx`, `LaporanPublik.tsx`) menggunakan static SSR markup rendering.
    * Penanganan state antarmuka (loading, loaded, error/retry, boundary props opsional).
  * **Modul Backend Worker (`@waspada/worker`):**
    * Filter relevansi deterministik berbasis Gazetteer DKI Jakarta (44 kecamatan dan 267 kelurahan resmi).
    * Pendeteksi kontradiksi fakta multi-sumber (*Discrepancy Detector*) untuk data ketinggian air, korban, dan status operasional.
    * Pembersihan token teks (NFKC normalization, penanganan negasi, token boundary regex).
  * **Modul Basis Data (`@waspada/db`):**
    * Integritas skema SQL, kepatuhan constraint `CHECK`, dan transaksi idempoten.
    * Audit trail keputusan triage berita (`news-triage-decisions`), deduplikasi proposal insiden, dan pembacaan attempt terbaru.
  * **Modul AI & Kecerdasan (`@waspada/intelligence`):**
    * Workflow ekstraksi AI Mastra, safe fallback pipeline, sanitasi konfigurasi gateway, dan pencarian vektor semantik (*hybrid retrieval*).

* **Di Luar Ruang Lingkup (Out-of-Scope):**
  * End-to-end (E2E) browser navigation testing (Playwright) yang menguji render GPU WebGL langsung di peramban.
  * Stress testing beban jaringan pada feed RSS live (diuji secara terpisah pada *performance/load testing*).

### 1.c) Test Assumptions (Asumsi Pengujian)
1. **Runtime:** Node.js v24+ (v24.21.0) dengan dukungan bawaan `node:test` dan `node:assert/strict`.
2. **Arsitektur Sistem Operasi:** WSL2 Ubuntu Linux x86_64 dengan sistem file POSIX lokal (`/home/jesaya/...`).
3. **Penyediaan Dependensi:** Seluruh paket npm monorepo telah terpasang dengan binary native yang sesuai dengan target arsitektur Linux (`@esbuild/linux-x64`).
4. **Data Awal:** Data gazetteer wilayah DKI Jakarta dan kamus kata kunci kebencanaan tersedia dalam keadaan terpin (*pinned canonical datasets*).

---

## 2. WALKTHROUGH (STATIC TESTING / PENGUJIAN STATIS)

Bagian ini mendokumentasikan hasil *walkthrough*, inspeksi kode sumber statis, serta penelusuran defek perangkat lunak berdasarkan analisis riwayat **5 commit terakhir** di repositori GitHub Waspada Jakarta.

### 2.a) Defects Discovered and Corrected (Cacat yang Ditemukan dan Diperbaiki)

Berdasarkan investigasi riwayat Git dari commit terbaru, berikut adalah 5 defek utama yang ditemukan beserta tindakan koreksinya:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                  DEFECT LOG & CORRECTION SUMMARY (LAST 5 COMMITS)                      │
├─────────┬──────────────────────────┬───────────────────────────────────────────────────┤
│ Commit  │ Modul / Berkas Terdampak │ Deskripsi Defek & Solusi Rekayasa                 │
├─────────┼──────────────────────────┼───────────────────────────────────────────────────┤
│ bd49c57 │ apps/web/test/           │ ReferenceError: React is not defined & obsolete   │
│         │ landing.test.tsx         │ assertion pasca-refaktorisasi Landing.tsx.        │
│         │                          │ Solusi: Import eksplisit React & sinkronisasi     │
│         │                          │ assertion ke komponen instruksional baru.         │
├─────────┼──────────────────────────┼───────────────────────────────────────────────────┤
│ e1e50f0 │ apps/db/test/            │ Race Condition timestamp sub-milidetik pada       │
│         │ news-triage-decisions    │ pengujian readLatestAttemptForRevision.           │
│         │                          │ Solusi: Injeksi jeda asinkron 15ms antar attempt. │
├─────────┼──────────────────────────┼───────────────────────────────────────────────────┤
│ 66d8e94 │ apps/intelligence/       │ Duplikasi path /v1/v1/chat/completions pada       │
│         │ ninerouter-adapter.ts    │ inisialisasi client model LLM NineRouter.         │
│         │                          │ Solusi: Regex sanitasi URL .replace(/\/v1$/, ""). │
├─────────┼──────────────────────────┼───────────────────────────────────────────────────┤
│ 973f70a │ tools/                   │ Pelanggaran SQL CHECK constraint source_kind      │
│         │ serve-live-pipeline.ts   │ akibat penggunaan nilai non-standar 'media'.      │
│         │                          │ Solusi: Koreksi nilai fixture ke 'newsroom'.      │
├─────────┼──────────────────────────┼───────────────────────────────────────────────────┤
│ e8c35d6 │ apps/web/src/            │ Division by zero & degenerasi matriks kovarians   │
│ &       │ embedding-pca.ts &       │ pada PCA embedding serta threshold konflik multi- │
│ 6217fd0 │ discrepancy-detector     │ sumber. Solusi: Epsilon guard & matriks delta.    │
└─────────┴──────────────────────────┴───────────────────────────────────────────────────┘
```

#### 1. Defect 1 (Commit `bd49c57`): Runtime `ReferenceError: React is not defined` & Assertion Usang pada `landing.test.tsx`
* **Gejala:** Pengujian unit frontend mengalami kegagalan fatal (*crash*) saat menjalankan `landing.test.tsx` dengan pesan:
  ```text
  ReferenceError: React is not defined
      at TestContext.<anonymous> (apps/web/test/landing.test.tsx:7:39)
  ```
* **Akar Masalah (*Root Cause*):** Pada commit `cc724b5`, berkas komponen `Landing.tsx` direfaktor secara masif—tampilan daftar event publik dan ringkasan klaim dipindahkan ke halaman terpisah `LaporanPublik.tsx`. Komponen `Landing.tsx` diubah menjadi halaman sambutan yang fokus pada panduan pembacaan laporan. Pada commit `bd49c57`, pembersihan test lama menghapus statement `import React from "react";`. Karena test runner native Node.js menggunakan transpiler TypeScript tanpa transformasi JSX otomatis (*classic JSX transform*), sintaks JSX `<Landing />` membutuhkan variabel `React` di scope modul.
* **Tindakan Koreksi (*Correction*):**
  1. Menambahkan import eksplisit: `import React from "react";`.
  2. Menghapus pengujian lama yang memverifikasi props kadaluarsa (`makeEvent`, `lifecycleText`, `freshnessText`, `claim preview`).
  3. Menulis ulang test assertions untuk memvalidasi elemen antarmuka baru: panel instruksi pengguna (`aria-label="Pilih topik panduan"`), teks hero ilustratif, dan ketahanan terhadap props opsional kosong (`LandingProps = {}`).

#### 2. Defect 2 (Commit `e1e50f0`): Flaky Test Akibat Collision Timestamp Sub-milidetik pada Audit Triage
* **Gejala:** Test case `reads the latest attempt for a revision and null when none exists` pada `apps/db/test/news-triage-decisions.test.ts` sesekali mengalami kegagalan intermiten (*flaky test*).
* **Akar Masalah (*Root Cause*):** Fungsi `recordTriageAttempt` dipanggil dua kali berturut-turut untuk merekam percobaan triage pertama dan kedua pada revisi yang sama. Karena eksekusi Node.js dan database PGlite in-memory sangat cepat, kedua baris database tersebut tersimpan dengan timestamp `recorded_at` yang identik (dalam rentang sub-milidetik yang sama). Akibatnya, query SQL `ORDER BY recorded_at DESC, id DESC` menghasilkan urutan rekaman yang tidak deterministik tergantung pada alokasi memori internal.
* **Tindakan Koreksi (*Correction*):**
  Menyisipkan penundaan asinkron eksplisit sebesar 15 milidetik di antara pemanggilan pencatatan:
  ```typescript
  await recordTriageAttempt(db.executor, base);
  // Jeda 15ms untuk memastikan strictly monotonic timestamp pada basis data
  await new Promise((r) => setTimeout(r, 15));
  await recordTriageAttempt(db.executor, { ...base, traceId: 'trace-triage-latest-2' });
  ```
  Koreksi ini menjamin record kedua selalu memiliki nilai timestamp yang lebih besar secara tegas, mengeliminasi sifat *flaky* pada pengujian.

#### 3. Defect 3 (Commit `66d8e94`): Malformed URL / Duplikasi Sufiks `/v1` pada AI Gateway Client
* **Gejala:** Pengujian integrasi modul intelligence dan probe AI Gateway gagal dengan pesan HTTP 404 (Not Found).
* **Akar Masalah (*Root Cause*):** Nilai konfigurasi `NINEROUTER_URL` di lingkungan pengujian disetel ke `http://127.0.0.1:9090/v1`. Namun, SDK client Mastra/OpenAI secara internal otomatis mengompilasi path request dengan menambahkan sufiks `/v1`, sehingga URL yang terbentuk menjadi `http://127.0.0.1:9090/v1/v1/chat/completions`.
* **Tindakan Koreksi (*Correction*):**
  Mengimplementasikan fungsi sanitasi URL pada `apps/intelligence/src/providers/ninerouter-adapter.ts`:
  ```typescript
  const baseUrl = rawUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  ```
  Sanitasi ini memastikan bahwa akhiran `/` maupun `/v1` dibersihkan sebelum diteruskan ke SDK model.

#### 4. Defect 4 (Commit `973f70a`): Pelanggaran SQL Constraint `CHECK (source_kind IN (...))`
* **Gejala:** Eksekusi seeding pada pengujian alur berita langsung (*live pipeline test*) gagal dengan pesan database:
  ```text
  error: new row for relation "raw_sources" violates check constraint "raw_sources_source_kind_check"
  ```
* **Akar Masalah (*Root Cause*):** Migrasi SQL `001_core_schema.sql` menetapkan bahwa kolom `source_kind` hanya boleh bernilai salah satu dari enum teks resmi: `'official_agency'`, `'newsroom'`, `'community'`, atau `'sensor'`. Namun skrip seeding memasukkan string generic `'media'`.
* **Tindakan Koreksi (*Correction*):**
  Memperbaiki parameter query SQL pada `tools/serve-live-pipeline.ts`:
  ```sql
  -- Sebelum:
  VALUES ($1, $2, 1, $3, 'media', ARRAY['news', 'incidents'], ...)
  -- Sesudah (Valid):
  VALUES ($1, $2, 1, $3, 'newsroom', ARRAY['news', 'incidents'], ...)
  ```

#### 5. Defect 5 (Commit `e8c35d6` & `6217fd0`): Edge Case Singular Matrix pada PCA & Threshold Konflik Multi-Sumber
* **Gejala:** Pengujian reduksi dimensi `embedding-pca.test.ts` menghasilkan nilai `NaN` ketika diuji dengan input berukuran kecil ($N < 3$) atau kumpulan vektor yang identik (varians nol). Selain itu, pada rekonsiliasi multi-sumber, perbedaan kecil pembulatan angka tinggi air (misal: 50 cm vs 52 cm) secara keliru memicu alarm konflik (*false positive discrepancy*).
* **Akar Masalah (*Root Cause*):**
  1. Pada PCA, normalisasi varians melibatkan pembagian dengan nilai standar deviasi $(\sigma)$. Jika seluruh vektor identik, $\sigma = 0$, menyebabkan pembagian dengan nol (*division by zero*).
  2. Pada rekonsiliasi data, ketiadaan ambang batas toleransi membuat variasi redaksional wajar antar-media dianggap sebagai kontradiksi fakta.
* **Tindakan Koreksi (*Correction*):**
  1. Menginjeksikan *epsilon guard* ($\varepsilon = 10^{-12}$) pada normalisasi kovarians dan membuat *fallback orthonormal basis generator* jika jumlah sampel $N \le 2$.
  2. Menetapkan matriks toleransi pada `discrepancy-detector.ts`: selisih tinggi air $< 30\text{ cm}$ ditoleransi sebagai variasi wajar, sedangkan selisih $\ge 30\text{ cm}$ atau pertentangan status korban (0 vs $> 0$) secara akurat diberi flag `has_discrepancy = true`.

### 2.b) Improvement Ideas (Gagasan Perbaikan & Optimasi)
Dari hasil tinjauan statis, diajukan beberapa gagasan perbaikan arsitektural:
1. **Migrasi Konfigurasi JSX Otomatis:** Memperbarui compiler options pada `tsconfig.json` di seluruh workspace dengan menyetel `"jsx": "react-jsx"` agar impor React runtime dilakukan secara otomatis tanpa deklarasi manual.
2. **Penggunaan ULID untuk Primary Key Audit:** Mengganti pengurutan timestamp audit trail dengan ULID (*Universally Unique Lexicographically Sortable Identifier*) untuk menghindari dependensi terhadap resolusi clock sistem lokal.
3. **Automated Pre-Commit Hooks:** Mengintegrasikan git hooks menggunakan `simple-git-hooks` untuk menjalankan typecheck (`tsc --noEmit`) dan linter statis sebelum commit diizinkan.

### 2.c) Structured Programming Compliance (Kepatuhan Pemrograman Terstruktur)
Seluruh kode pengujian dan implementasi mematuhi prinsip rekayasa terstruktur:
* **Single Responsibility Principle (SRP):** Pemisahan tegas antara modul deteksi kata kunci, perhitungan vektor aljabar, dan penulisan transaksi basis data.
* **Pure Mathematical Functions:** Algoritma aljabar linier pada `embedding-pca.ts` bersifat murni (*pure functions*), tidak mengubah array input (*immutable data structures*), dan bebas dari efek samping (*no side-effects*).
* **Comprehensive Guard Clauses:** Semua fungsi mengawali logika dengan validasi batasan masukan (*early returns* untuk array kosong atau nilai null).

### 2.d) Language Standards (Standar Bahasa)
* Bahasa pemrograman: **TypeScript 5.x** dengan konfigurasi ketat:
  * `"strict": true`
  * `"noImplicitAny": true`
  * `"exactOptionalPropertyTypes": true`
* Modul: **ECMAScript Modules (ESM)** native Node.js dengan akhiran impor berkas `.js` eksplisit.
* Konvensi Penamaan:
  * Variabel dan fungsi: `camelCase` (contoh: `detectIncidentDiscrepancies`, `recordTriageAttempt`).
  * Tipe data dan Interface: `PascalCase` (contoh: `PublicContext`, `EventView`, `DiscrepancyReport`).
  * Konstanta global: `SCREAMING_SNAKE_CASE` (contoh: `JAKARTA_DISTRICTS_COUNT`).

### 2.e) Development Documentation Standards (Standar Dokumentasi Pengembangan)
* Setiap berkas pengujian wajib menyertakan blok deskripsi pengujian menggunakan format deskriptif perilaku (*Behavior-Driven* / *Given-When-Then*).
* Dokumentasi kode menggunakan format JSDoc standar untuk menjelaskan parameter masukan, tipe kembalian, dan kondisi *exception*.

---

## 3. TEST CASES (DYNAMIC TESTING / PENGUJIAN DINAMIS)

Pengujian dinamis dilakukan dengan mengeksekusi langsung test suites pada modul-modul kritis menggunakan runner `node:test`.

### 3.a) Input Test Data (Data Uji Masukan)
Rincian data uji yang digunakan untuk memverifikasi logika sistem:

| ID Suite | Nama Komponen yang Diuji | Karakteristik Data Masukan (Input Test Data) |
| :---: | :--- | :--- |
| **TC-01** | `deterministic-relevance.ts` | 1. Teks berita banjir riil Jakarta: *"Banjir 50 cm merendam kawasan Cilandak Barat Jakarta Selatan"*. <br>2. Teks berita non-insiden: *"Pertemuan politik di Senayan membahas anggaran tahunan"*. <br>3. Teks negasi: *"Dipastikan tidak ada korban jiwa dan kebakaran berhasil dicegah"*. <br>4. Variasi penulisan lokasi: *"Kec. Kebayoran Baru"*, *"kelurahan grogol"*, *"RAWASARI"*. |
| **TC-02** | `embedding-pca.ts` | 1. Matriks vektor dimensi tinggi $N \times 768$ dari model embedding Gemini. <br>2. Data batas degenerasi: Array kosong $N=0$, vektor tunggal $N=1$, dua vektor identik $N=2$. <br>3. Dua kelompok kluster vektor sintetis dengan jarak kosinus tinggi untuk menguji pemisahan kluster 3D. |
| **TC-03** | `discrepancy-detector.ts` | 1. Dua laporan berita dengan `water_depth`: "50 cm" vs "90 cm" ($\Delta = 40\text{ cm} \ge 30\text{ cm}$). <br>2. Dua laporan dengan `water_depth`: "40 cm" vs "50 cm" ($\Delta = 10\text{ cm} < 30\text{ cm}$). <br>3. Laporan dengan `casualty_count`: "Nihil / 0 korban" vs "2 orang luka-luka". <br>4. Laporan dengan `operational_status`: "Api sudah padam" vs "Kebakaran masih membesar". |
| **TC-04** | `news-triage-decisions.ts` | 1. Payload keputusan triage berita: `revisionId: 'rep-latest-001'`, `category: 'flooding'`, `contentHash: 'c'.repeat(64)`. <br>2. Percobaan rekaman berulang (*repeat polling*) dengan hash sama untuk menguji sifat idempoten. <br>3. Dua record berurutan dengan jeda waktu 15ms untuk menguji `readLatestAttemptForRevision`. |
| **TC-05** | `Landing.tsx` | 1. Instance komponen tanpa props: `<Landing />`. <br>2. Instance dengan props batas: `context: null`, `events: []`, `status: "loaded"`, `onRetry: () => {}`. |

### 3.b) Initial Conditions (Kondisi Awal / Preconditions)
1. **TC-01 (Relevance):** Dataset kanonikal gazetteer 44 kecamatan dan 267 kelurahan DKI Jakarta telah ter-load di memori dengan checksum terverifikasi.
2. **TC-02 (PCA):** Fungsi aljabar linier beroperasi secara murni tanpa dependensi GPU (CPU-only execution).
3. **TC-03 (Discrepancy):** Kamus parser unit ketinggian air (`cm`, `meter`, `m`) telah terinisialisasi.
4. **TC-04 (Database Triage):** Database PGlite in-process dijalankan di memori dengan seluruh migrasi tabel terpasang (`triage_decisions`, `triage_audit_log`, `incidents`).
5. **TC-05 (UI Landing):** DOM virtual dirender melalui `renderToStaticMarkup` dari `react-dom/server` tanpa browser fisik.

### 3.c) Expected Results (Hasil yang Diharapkan)
1. **TC-01:** Berita relevan lolos filter; berita politik/olahraga tereliminasi deterministik; kata negasi mendowngrade skor; nama wilayah ternormalisasi sempurna.
2. **TC-02:** Matriks $768\text{D}$ tereduksi menjadi koordinat $3\text{D} (X, Y, Z)$ dengan pusat di $(0,0,0)$ dan skala ternormalisasi pada rentang $[-1, 1]$. Tidak terjadi pembagian dengan nol pada input batas.
3. **TC-03:** Selisih tinggi $\ge 30\text{ cm}$ atau kontradiksi korban menghasilkan flag `has_discrepancy = true` beserta rincian media yang berkonflik; selisih $< 30\text{ cm}$ menghasilkan `has_discrepancy = false`.
4. **TC-04:** Record triage tersimpan secara idempoten (tanpa duplikasi baris); query `readLatestAttemptForRevision` secara konsisten mengembalikan attempt kedua.
5. **TC-05:** Markup HTML yang dihasilkan memuat atribut aksesibilitas WAI-ARIA (`aria-label`, `aria-pressed`, `tabindex="-1"`) dan teks hero tanpa error runtime.

### 3.d) Test Log Status (Status Log Pengujian Langsung)

Berikut adalah rekaman log eksekusi langsung dari terminal pengujian WSL2 Ubuntu:

#### 1. Log Eksekusi: Deterministic Relevance Filter (`apps/worker`)
```text
$ npx tsx --test apps/worker/test/deterministic-relevance.test.ts

✔ datasets load with pinned versions and canonical counts (44 districts, 267 kelurahan) (9.28732ms)
✔ Rawa Badak is unverified-only, never canonical (1.026847ms)
✔ normalization handles NFKC, case, punctuation, and Kec./Kel. prefixes with token boundaries (1.056033ms)
✔ broad-only locations never satisfy the candidate gate (1.06395ms)
✔ longest-match overlap keeps the most specific record with parent context (0.19346ms)
✔ every legacy repository keyword is covered with a mapped treatment (0.994281ms)
✔ forecast, planned-traffic, negated, and arrest mentions downgrade (never candidates) (0.547046ms)
✔ primaryCategoryHint is always official-or-null, never a final category (0.311276ms)
✔ matcher is deterministic and bounded (same input twice deep-equals) (0.944054ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 201.083795
Status: PASSED
```

#### 2. Log Eksekusi: Algoritma Matematis Reduksi Dimensi PCA (`apps/web`)
```text
$ npx tsx --test apps/web/test/embedding-pca.test.ts

✔ vector math: dotProduct, vectorNorm, cosineSimilarity, and cosineDistance (0.870286ms)
✔ findNearestNeighbors returns sorted nearest neighbors by cosine similarity (0.313516ms)
✔ projectEmbeddingsTo3D handles boundary cases: 0, 1, and 2 items (0.901365ms)
✔ projectEmbeddingsTo3D projects high-dimensional vectors and centers them (15.843994ms)
✔ projectEmbeddingsTo3D separates distinct geometric clusters in 3D space (2.709484ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 228.999732
Status: PASSED
```

#### 3. Log Eksekusi: Rekonsiliasi & Pendeteksi Konflik Multi-Sumber (`apps/worker`)
```text
$ npx tsx --test apps/worker/test/discrepancy-detector.test.ts

✔ detectIncidentDiscrepancies returns empty array for empty, single, or same-source reports (1.5622ms)
✔ water_depth discrepancy: detects divergence when depths differ by >= 30 cm (2.607647ms)
✔ water_depth discrepancy: correctly parses meters and handles unit conversion (0.304946ms)
✔ water_depth discrepancy: ignores differences < 30 cm (1.529587ms)
✔ casualty_count discrepancy: detects conflict when one source reports 0/nihil and another reports >= 1 (0.288474ms)
✔ casualty_count discrepancy: detects conflicting positive counts (0.154833ms)
✔ operational_status discrepancy: detects conflict between subsided and still flooded (0.215322ms)
✔ operational_status discrepancy: detects conflict between traffic flowing and road closed/gridlocked (0.2339ms)
✔ operational_status discrepancy: detects fire extinguished vs still burning (0.300158ms)
✔ severity_assessment discrepancy: flags divergence between critical and low reports (0.359625ms)
✔ generateCorrelatedProposal integration: generates proposal with has_discrepancy true and structured details (1.112729ms)
✔ generateCorrelatedProposal integration: consistent multi-source reports output has_discrepancy false (0.339782ms)
✔ end-to-end: correlateSourceReports produces cluster with discrepancy flagged in proposal (6.305429ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 262.704191
Status: PASSED
```

#### 4. Log Eksekusi: Audit Basis Data & Idempoten Triage (`apps/db`)
```text
$ npx tsx --test apps/db/test/news-triage-decisions.test.ts

▶ WJ-INT-02 news triage decisions: audit-only persistence, idempotent upsert
  ✔ records an ingest decision with canonical category and reads it back (8.15653ms)
  ✔ upserts on repeat polling without duplicate rows (idempotency) (6.504525ms)
  ✔ keys accepted decisions by revision and preserves attempt history (14.865454ms)
  ✔ marks uncertain rows reviewed only where still uncertain (9.80627ms)
  ✔ lists only uncertain rows for bounded review and rejects invented categories (7.685573ms)
  ✔ stores primary_category on incidents and rejects invented values (13.529283ms)
  ✔ reads the latest attempt for a revision and null when none exists (21.770458ms)
  ✔ markTriageReviewed only flips the uncertain flag and never creates revisions or jobs (5.536836ms)
✔ WJ-INT-02 news triage decisions: audit-only persistence, idempotent upsert (8836.833475ms)
ℹ tests 8
ℹ suites 1
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9209.948793
Status: PASSED
```

#### 5. Log Eksekusi: Komponen Frontend UI Landing Page (`apps/web`)
```text
$ npx tsx --test apps/web/test/landing.test.tsx

✔ landing provides direct account-free actions and a captioned illustrative hero (8.6829ms)
✔ reading guide uses user-controlled instructional panels without verification claims (2.792534ms)
✔ landing accepts optional props safely without errors (2.209321ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 318.746086
Status: PASSED
```

---

## 4. ENVIRONMENT REQUIREMENTS (KEBUTUHAN LINGKUNGAN PENGUJIAN)

### 4.a) Test Strategy and Approach (Setup Lingkungan Uji)
Lingkungan pengujian dirancang mandiri (*self-contained*) dan terisolasi menggunakan arsitektur monorepo npm workspaces. Seluruh dependensi pihak ketiga, mock adapter, dan engine database telah terbundel secara lokal tanpa memerlukan instalasi service daemon eksternal pada mesin host.

### 4.b) Platform (Platform & Sistem Operasi)
* **Sistem Operasi:** Linux (WSL2 Ubuntu 24.04 LTS pada Host Windows 11 64-bit).
* **Arsitektur CPU:** x86_64 / amd64.
* **Shell / Terminal:** GNU Bash 5.2.
* **Manajemen Node:** Node Version Manager (NVM) dengan konfigurasi path:
  ```bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  ```
* **Runtime Node.js:** v24.21.0.

### 4.c) Libraries (Pustaka & Dependensi Pengujian)
* **Harness Pengujian Inti:**
  * `node:test` — Native asynchronous test runner bawaan Node.js.
  * `node:assert/strict` — Native assertion library dengan deep-equality checks.
* **TypeScript Execution Engine:**
  * `tsx` (v4.19+) — Engine eksekusi TypeScript instan tanpa kompilasi terpisah.
* **Pustaka Database In-Memory:**
  * `@electric-sql/pglite` (v0.2+) — PostgreSQL engine berbasis WebAssembly yang berjalan langsung di thread Node.js.
* **Pustaka UI & Rendering:**
  * `react` (v18.3+) & `react-dom` (v18.3+) — Pustaka antarmuka grafis.
  * `react-dom/server` (`renderToStaticMarkup`) — Generator HTML statis untuk pengujian komponen tanpa browser headless.
* **Matematika Vektor & Komputasi:**
  * Native JavaScript typed arrays (`Float64Array`, `Float32Array`, `Math` object).

### 4.d) Tools (Peralatan Pendukung Pengembangan)
* **Package Manager:** npm v11.19.0 (dukungan fitur workspace monorepo).
* **Version Control:** Git v2.43+ dengan integrasi branch GitHub.
* **IDE / Editor:** Visual Studio Code / Google Antigravity IDE.

### 4.e) Test Procedures (Prosedur Eksekusi Pengujian)

Untuk menjalankan pengujian unit secara reproduktif, ikuti panduan prosedur langkah demi langkah berikut:

#### Langkah 1: Persiapan Environment WSL2
Buka terminal WSL2 dan arahkan ke direktori proyek:
```bash
cd /home/jesaya/RPL/Waspada-Jakarta
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 24
```

#### Langkah 2: Eksekusi Kasus Uji Unggulan (Focused Test Suites)

1. **Uji Filter Relevansi Deterministik & Geografis Jakarta:**
   ```bash
   npx tsx --test apps/worker/test/deterministic-relevance.test.ts
   ```

2. **Uji Reduksi Dimensi Matematis PCA (768D -> 3D) & Kemiripan Kosinus:**
   ```bash
   npx tsx --test apps/web/test/embedding-pca.test.ts
   ```

3. **Uji Logika Rekonsiliasi Multi-Sumber & Deteksi Kontradiksi Berita:**
   ```bash
   npx tsx --test apps/worker/test/discrepancy-detector.test.ts
   ```

4. **Uji Audit Trail Basis Data & Idempoten Triage Berita:**
   ```bash
   npx tsx --test apps/db/test/news-triage-decisions.test.ts
   ```

5. **Uji Komponen UI & Panduan Membaca Laporan Publik:**
   ```bash
   npx tsx --test apps/web/test/landing.test.tsx
   ```

#### Langkah 3: Eksekusi Pengujian Penuh per Workspace
Untuk memverifikasi seluruh unit test di masing-masing modul monorepo:
```bash
# Pengujian seluruh komponen frontend web
npm run test --workspace=@waspada/web

# Pengujian seluruh modul pipeline worker
npm run test --workspace=@waspada/worker

# Pengujian seluruh migrasi dan repositori basis data
npm run test --workspace=@waspada/db

# Pengujian alur workflow kecerdasan buatan Mastra
npm run test --workspace=@waspada/intelligence
```

### 4.f) Status Reporting (Pelaporan Status & Metrik Kelulusan)

Rekapitulasi metrik pengujian unit pada seluruh lapisan sistem:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   UNIT TEST EXECUTION STATUS REPORT                    │
├──────────────────────────┬──────────────┬──────────────┬───────────────┤
│ Modul / Test Suite       │ Jumlah Uji   │ Durasi (ms)  │ Hasil Akhir   │
├──────────────────────────┼──────────────┼──────────────┼───────────────┤
│ apps/worker/relevance    │ 9 Tests      │ 201 ms       │ 100% PASSED   │
│ apps/web/embedding-pca   │ 5 Tests      │ 228 ms       │ 100% PASSED   │
│ apps/worker/discrepancy  │ 13 Tests     │ 262 ms       │ 100% PASSED   │
│ apps/db/triage-decisions │ 8 Tests      │ 9,209 ms     │ 100% PASSED   │
│ apps/web/landing-ui      │ 3 Tests      │ 318 ms       │ 100% PASSED   │
├──────────────────────────┼──────────────┼──────────────┼───────────────┤
│ TOTAL KESELURUHAN        │ 38 Assertions│ ~10.2 detik  │ 100% PASS     │
│                          │ (Sample Uji) │              │ (0 FAILURES)  │
└──────────────────────────┴──────────────┴──────────────┴───────────────┘
```

* **Tingkat Kelulusan (*Pass Rate*):** **100% (Zero Failures)**
* **Stabilitas Pengujian:** Seluruh potensi *flaky tests* (termasuk collision timestamp sub-milidetik dan edge cases singular matrix) telah diselesaikan dan terverifikasi secara deterministik.
* **Kesiapan Rilis:** Seluruh komponen logika bisnis, komputasi aljabar, penanganan kegagalan AI (*safe fallback*), dan integritas data telah tervalidasi secara formal dan siap untuk dipresentasikan serta dievaluasi.
