# DOKUMENTASI PENGUJIAN UNIT (UNIT TEST PLAN & REPORT)
## SISTEM INFORMASI KESELAMATAN SIPIL REAL-TIME — WASPADA JAKARTA

---

**Mata Kuliah:** Rekayasa Perangkat Lunak (RPL)  
**Proyek:** Waspada Jakarta — Live Civic Safety Intelligence Platform  
**Standar Dokumen:** Unit Test Plan & Documentation Template (Software Testing Standard)  
**Tanggal Pengujian:** 12 November 2026 (CI run 117086838832, commit cec9358)  
**Status Pengujian:** 0 gagal pada seluruh langkah uji yang tercatat di log CI (2.034 tes/kasus). Kesimpulan run keseluruhan (sukses/gagal) belum dikonfirmasi dari halaman GitHub Actions; lihat 4.f.  

---

## RINGKASAN STRUKTUR DOKUMEN (MASTER UNIT TEST PLAN TEMPLATE)

Dokumentasi ini disusun mengacu pada standar template *Unit Test Plan* yang mencakup 4 pilar utama pengujian perangkat lunak:

| Sr. | Requirements | Typical Components | Detailed Description |
| :---: | :--- | :--- | :--- |
| **1)** | **Introduction** | a) Test Strategy and Approach<br>b) Test Scope<br>c) Test Assumptions | Pendekatan pengujian unit berlapis (*layered unit testing*), cakupan pengujian modular (Web, Worker, DB, Intelligence), dan asumsi determinisme pengujian tanpa dependensi jaringan eksternal. |
| **2)** | **Walkthrough<br>(Static Testing)** | a) Defects Discovered and Corrected<br>b) Improvement Ideas<br>c) Structured Programming Compliance<br>d) Language Standards<br>e) Development Documentation Standards | Analisis statis kode sumber, review defek/bug dari riwayat commit GitHub yang diverifikasi (dua commit `fix`) beserta koreksinya, prinsip pemrograman terstruktur, standar TypeScript/ESM, dan standar dokumentasi pengembangan. |
| **3)** | **Test Cases<br>(Dynamic Testing)** | a) Input Test Data<br>b) Initial Conditions<br>c) Expected Results<br>d) Test Log Status | Spesifikasi data uji masukan, kondisi awal (preconditions), kriteria hasil yang diharapkan, serta bukti log eksekusi dari runner pengujian (log CI; log lokal ditandai *belum disimpan*). |
| **4)** | **Environment Requirements** | a) Test Strategy and Approach (Setup)<br>b) Platform<br>c) Libraries<br>d) Tools<br>e) Test Procedures<br>f) Status Reporting | Konfigurasi lingkungan uji, platform OS WSL2 Ubuntu, runtime Node.js native test runner, pustaka PGlite & React, prosedur eksekusi perintah, dan pelaporan status kelulusan. |

---

## 1. INTRODUCTION (PENDAHULUAN)

### 1.a) Test Strategy and Approach (Strategi dan Pendekatan Pengujian)
Sistem Waspada Jakarta menerapkan strategi pengujian unit berorientasi lapisan (*Layered Architecture Unit Testing*) yang dirancang untuk menjamin kecepatan, determinisme, dan integritas logika sebelum integrasi live:
1. **Determinisme Mutlak (Zero External I/O):** Pengujian unit tidak diperkenankan melakukan panggilan jaringan (*network calls*) ke API eksternal. Semua interaksi AI Gateway (NineRouter / Gemini), feed RSS, dan layanan pihak ketiga disimulasikan menggunakan in-memory fixtures dan deterministik mock adapter.
2. **Isolasi Database PGlite (In-Process WASM):** Untuk modul persistensi basis data (`@waspada/db`), pengujian menggunakan engine PostgreSQL in-process WebAssembly (`@electric-sql/pglite`). Setiap test suite bootstrap instance database bersih dan menjalankan seluruh migrasi SQL skema (001–047) secara independen, mencegah kontaminasi state antar-test (*idempotent testing*).
3. **Pilar Responsible AI & Safe Fallback:** Pengujian unit memverifikasi bahwa kegagalan layanan AI (HTTP 503, timeout, kuota habis) ditangani secara aman dengan prinsip *Zero Hallucinated Proposals* — sistem dilarang keras mengarang insiden atau memalsukan bukti jika model AI gagal.
4. **Eksekusi Native Ultra-Cepat:** Menggunakan runner pengujian native Node.js (`node:test`) dipadukan dengan TypeScript Execution Engine (`tsx`), memungkinkan eksekusi seluruh suite unit test dalam hitungan detik tanpa overhead bundle build yang berat.

### 1.b) Test Scope (Ruang Lingkup Pengujian)
Pengujian unit mencakup seluruh modul inti dalam arsitektur monorepo Waspada Jakarta:

* **Di dalam Ruang Lingkup (In-Scope):**
  * **Modul Frontend (`@waspada/web`):**
    * Algoritma reduksi dimensi matematis Principal Component Analysis (Dual Gram-Matrix PCA $768\text{D} \to 3\text{D}$) dan metrik kemiripan kosinus (*cosine similarity*).
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
  * Pengujian komponen UI landing page. Pengujian ini dihapus pada commit `b0a18c5` bersama komponen `Landing.tsx` dan tidak lagi termasuk dalam dokumen ini.

### 1.c) Test Assumptions (Asumsi Pengujian)
1. **Runtime:** Node.js 24. CI memakai Node 24 (`.github/workflows/ci.yml`); tidak ada berkas yang mengunci versi patch (tidak ada `.nvmrc`, field `engines`, maupun `packageManager`). Dukungan bawaan `node:test` dan `node:assert/strict`.
2. **Arsitektur Sistem Operasi:** WSL2 Ubuntu Linux x86_64 dengan sistem file POSIX lokal (bukan path Windows).
3. **Penyediaan Dependensi:** Seluruh paket npm monorepo telah terpasang dengan binary native yang sesuai dengan target arsitektur Linux (`@esbuild/linux-x64`).
4. **Data Awal:** Data gazetteer wilayah DKI Jakarta dan kamus kata kunci kebencanaan tersedia dalam keadaan terpin (*pinned canonical datasets*).

---

## 2. WALKTHROUGH (STATIC TESTING / PENGUJIAN STATIS)

Bagian ini mendokumentasikan hasil *walkthrough*, inspeksi kode sumber statis, serta penelusuran defek perangkat lunak berdasarkan analisis riwayat commit di repositori GitHub Waspada Jakarta. Sebuah commit hanya dihitung sebagai defek jika subjeknya berawalan `fix`, sesuai pemeriksaan `git show -s`.

### 2.a) Defects Discovered and Corrected (Cacat yang Ditemukan dan Diperbaiki)

Penelusuran riwayat Git menemukan dua commit ber-subjek `fix` yang memperbaiki defek dan dapat diverifikasi dari diff-nya. Berikut adalah dua defek beserta tindakan koreksinya. Commit lain yang awalnya ditafsirkan sebagai defek dikeluarkan dari daftar dan dicatat di bawah tabel.

| Commit | Modul / Berkas Terdampak | Deskripsi Defek & Solusi Rekayasa |
| :---: | :--- | :--- |
| `66d8e94` | `apps/intelligence/src/providers/ninerouter-adapter.ts` | Duplikasi sufiks `/v1` pada URL model Mastra. Solusi: sanitasi `baseUrl` dengan `.replace(/\/v1$/, "")`. |
| `973f70a` | `tools/serve-live-pipeline.ts` | Nilai `'media'` melanggar CHECK `source_kind` pada `waspada.source_registry`. Solusi: nilai diubah ke `'newsroom'`. |

#### 1. Defect 1 (Commit `66d8e94`): Duplikasi Sufiks `/v1` pada URL AI Gateway Client
* **Subjek commit:** `fix(intelligence): normalize baseUrl to avoid duplicate /v1 suffix in Mastra model URL`
* **Gejala:** Pengujian integrasi modul intelligence dan probe AI Gateway gagal dengan pesan HTTP 404 (Not Found). *Gejala ini tidak tercatat di commit dan belum diverifikasi ulang.*
* **Akar Masalah (*Root Cause*):** Nilai konfigurasi `NINEROUTER_URL` disetel ke `http://127.0.0.1:9090/v1`. SDK client Mastra/OpenAI menambahkan sufiks `/v1` sendiri, sehingga URL yang terbentuk menjadi `http://127.0.0.1:9090/v1/v1/chat/completions`.
* **Tindakan Koreksi (*Correction*):** Baris inisialisasi `baseUrl` pada `getNineRouterConfig()` di `apps/intelligence/src/providers/ninerouter-adapter.ts` diubah menjadi:
  ```typescript
  const baseUrl = rawUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  ```
  Sanitasi ini memastikan bahwa akhiran `/` maupun `/v1` dibersihkan sebelum diteruskan ke SDK model.

#### 2. Defect 2 (Commit `973f70a`): Pelanggaran CHECK Constraint `source_kind` pada Seed Sumber Live
* **Subjek commit:** `fix(LIVE-TEST): use newsroom source_kind to satisfy check constraint`
* **Gejala:** Seeding sumber RSS pada `tools/serve-live-pipeline.ts` ditolak database karena nilai `source_kind` tidak memenuhi CHECK constraint. Pesan galat lengkap tidak tercatat di commit.
* **Akar Masalah (*Root Cause*):** Migrasi `apps/db/migrations/001_foundation.sql` mendefinisikan kolom `source_kind` pada tabel `waspada.source_registry` dengan CHECK yang hanya mengizinkan `'authority'`, `'operator'`, `'newsroom'`, `'institution'`, `'crowdsourced_platform'`, dan `'other'`. Nilai `'media'` yang dipakai oleh seed tidak termasuk dalam daftar tersebut.
* **Tindakan Koreksi (*Correction*):** Parameter INSERT ke `waspada.source_registry` pada `tools/serve-live-pipeline.ts` diubah:
  ```sql
  -- Sebelum:
  VALUES ($1, $2, 1, $3, 'media', ARRAY['news', 'incidents'], ...)
  -- Sesudah (valid):
  VALUES ($1, $2, 1, $3, 'newsroom', ARRAY['news', 'incidents'], ...)
  ```

#### Commit yang Dikeluarkan dari Daftar Defek
* `bd49c57` (*frontend cleanup unit testing*): subjeknya bukan `fix`. Commit ini mengubah komponen `Landing.tsx` dan berkas uji UI-nya. Baris `import React` pada `Landing.tsx` tidak diubah (hanya muncul sebagai konteks diff), sehingga klaim bahwa commit ini menghapus import React tidak didukung diff. Berkas uji UI tersebut dihapus pada commit `b0a18c5`, sehingga defek ini tidak lagi dicatat.
* `e1e50f0` (*Created new frontend demo pages*): commit fitur. Di dalamnya ada satu baris jeda `setTimeout` 15 ms pada `apps/db/test/news-triage-decisions.test.ts`, tetapi commit ini juga menambah halaman demo, mengubah `tools/serve-live-pipeline.ts`, dan menambah berkas dokumentasi ini. Ini bukan perbaikan defek yang terisolasi.
* `e8c35d6` (*feat(VIS-01): 3D embedding chunk visualization*) dan `6217fd0` (*feat(CORR-01): multi-source incident corroboration*): commit fitur. Klaim sebelumnya tentang `NaN` pada PCA, epsilon guard, dan ambang 30 cm tidak dapat dipetakan ke diff kedua commit ini sebagai perbaikan. `embedding-pca.ts` ditambahkan oleh `e8c35d6`. Berkas `correlated-proposal-engine.ts` (tempat `detectIncidentDiscrepancies`) tidak diubah oleh kedua commit ini.

### 2.b) Improvement Ideas (Gagasan Perbaikan & Optimasi)
Dari hasil tinjauan statis, diajukan beberapa gagasan perbaikan arsitektural:
1. **Konfigurasi JSX Otomatis:** `"jsx": "react-jsx"` sudah disetel pada `apps/web/tsconfig.json`, sehingga impor React tidak perlu dideklarasikan manual di berkas TSX. Gagasan ini hanya berlaku jika workspace lain juga memakai JSX.
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
  * `noImplicitAny` tercakup oleh `strict` (tidak disetel terpisah). Opsi `exactOptionalPropertyTypes` tidak diaktifkan pada tsconfig repositori.
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
| **TC-03** | `correlated-proposal-engine.ts` (`detectIncidentDiscrepancies`) | 1. Dua laporan berita dengan `water_depth`: "50 cm" vs "90 cm" ($\Delta = 40\text{ cm} \ge 30\text{ cm}$). <br>2. Dua laporan dengan `water_depth`: "40 cm" vs "50 cm" ($\Delta = 10\text{ cm} < 30\text{ cm}$). <br>3. Laporan dengan `casualty_count`: "Nihil / 0 korban" vs "2 orang luka-luka". <br>4. Laporan dengan `operational_status`: "Api sudah padam" vs "Kebakaran masih membesar". |
| **TC-04** | `news-triage-store.ts` (`recordTriageAttempt`, `readLatestAttemptForRevision`) | 1. Payload keputusan triage berita: `revisionId: 'rep-latest-001'`, `category: 'flooding'`, `contentHash: 'c'.repeat(64)`. <br>2. Percobaan rekaman berulang (*repeat polling*) dengan hash sama untuk menguji sifat idempoten. <br>3. Dua record berurutan dengan jeda waktu 15ms untuk menguji `readLatestAttemptForRevision`. |

### 3.b) Initial Conditions (Kondisi Awal / Preconditions)
1. **TC-01 (Relevance):** Dataset kanonikal gazetteer 44 kecamatan dan 267 kelurahan DKI Jakarta telah ter-load di memori dengan versi dataset terpin (`2026-11-02-seed-1`).
2. **TC-02 (PCA):** Fungsi aljabar linier beroperasi secara murni tanpa dependensi GPU (CPU-only execution).
3. **TC-03 (Discrepancy):** Kamus parser unit ketinggian air (`cm`, `meter`, `m`) telah terinisialisasi.
4. **TC-04 (Database Triage):** Database PGlite in-process dijalankan di memori dengan seluruh migrasi terpasang (antara lain `waspada.news_triage_decisions` dan `waspada.news_triage_attempts`).

### 3.c) Expected Results (Hasil yang Diharapkan)
1. **TC-01:** Berita relevan lolos filter; berita politik/olahraga tereliminasi deterministik; kata negasi mendowngrade skor; nama wilayah ternormalisasi sempurna.
2. **TC-02:** Matriks $768\text{D}$ tereduksi menjadi koordinat $3\text{D} (X, Y, Z)$ dengan pusat di $(0,0,0)$ dan skala ternormalisasi pada rentang $[-1, 1]$. Tidak terjadi pembagian dengan nol pada input batas.
3. **TC-03:** Selisih tinggi $\ge 30\text{ cm}$ atau kontradiksi korban menghasilkan flag `has_discrepancy = true` beserta rincian media yang berkonflik; selisih $< 30\text{ cm}$ menghasilkan `has_discrepancy = false`.
4. **TC-04:** Record triage tersimpan secara idempoten (tanpa duplikasi baris); query `readLatestAttemptForRevision` secara konsisten mengembalikan attempt kedua.

### 3.d) Test Log Status (Status Log Pengujian Langsung)

Keempat log berikut berasal dari terminal lokal WSL2 Ubuntu. Log ini **log lokal, belum disimpan**: tidak ada berkas log yang tersimpan, dan log CI tidak memuat angka per berkas. Jumlah tes per berkas sesuai dengan deklarasi `test(` / `it(` di kode sumber saat dokumen ini disusun, tetapi tidak dijalankan ulang pada CI.

#### 1. Log Eksekusi: Deterministic Relevance Filter (`apps/worker`) — log lokal, belum disimpan
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

#### 2. Log Eksekusi: Algoritma Matematis Reduksi Dimensi PCA (`apps/web`) — log lokal, belum disimpan
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

#### 3. Log Eksekusi: Rekonsiliasi & Pendeteksi Konflik Multi-Sumber (`apps/worker`) — log lokal, belum disimpan
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

#### 4. Log Eksekusi: Audit Basis Data & Idempoten Triage (`apps/db`) — log lokal, belum disimpan
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
* **Runtime Node.js:** Node.js 24 (CI memakai `node-version: 24` di `.github/workflows/ci.yml`; patch tidak dikunci di repositori).

### 4.c) Libraries (Pustaka & Dependensi Pengujian)
* **Harness Pengujian Inti:**
  * `node:test` — Native asynchronous test runner bawaan Node.js.
  * `node:assert/strict` — Native assertion library dengan deep-equality checks.
* **TypeScript Execution Engine:**
  * `tsx` (`^4.23.15`, dari `package.json` root) — Engine eksekusi TypeScript instan tanpa kompilasi terpisah.
* **Pustaka Database In-Memory:**
  * `@electric-sql/pglite` (`0.5.8`, dari `apps/db/package.json`) — PostgreSQL engine berbasis WebAssembly yang berjalan langsung di thread Node.js.
* **Pustaka UI & Rendering:**
  * `react` (`^19.3.0`) & `react-dom` (`^19.3.0`) — Pustaka antarmuka grafis (dari `apps/web/package.json`).
  * `react-dom/server` (`renderToStaticMarkup`) — Generator HTML statis untuk pengujian komponen tanpa browser headless.
* **Matematika Vektor & Komputasi:**
  * Native JavaScript typed arrays (`Float64Array`, `Float32Array`, `Math` object).

### 4.d) Tools (Peralatan Pendukung Pengembangan)
* **Package Manager:** npm 11 (dukungan fitur workspace monorepo; versi patch tidak dikunci di repositori).
* **Version Control:** Git v2.43+ dengan integrasi branch GitHub.
* **IDE / Editor:** Visual Studio Code / Google Antigravity IDE.

### 4.e) Test Procedures (Prosedur Eksekusi Pengujian)

Untuk menjalankan pengujian unit secara reproduktif, ikuti panduan prosedur langkah demi langkah berikut:

#### Langkah 1: Persiapan Environment WSL2
Buka terminal WSL2 dan pastikan berada di root repositori (folder yang berisi `package.json`). Seluruh path pada langkah berikut relatif terhadap root ini:
```bash
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

4. **Uji Audit Trail Basis Data & Idempoten Triage Berita** (berkas database dijalankan dengan working directory `apps/db`):
   ```bash
   cd apps/db && node --import tsx --test test/news-triage-decisions.test.ts
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

**A. Hasil CI** — run 117086838832, commit cec9358 (12 November 2026). Angka diambil dari log langkah CI.

| Langkah CI | Perintah | Tests | Lulus | Gagal |
| :--- | :--- | ---: | ---: | :--- |
| Typecheck | `npm run typecheck` | — | — | tidak ada baris error |
| Database | `npm run db:test` | 381 (56 berkas) | 381 | 0 |
| Web | `npm run test --workspace=@waspada/web` | 335 | 335 | 0 |
| Worker | `npm run test --workspace=@waspada/worker` | 1.089 | 1.089 | 0 |
| Intelligence | `npm run test:intelligence` | 104 | 104 | 0 |
| Pipeline lokal | `npm run pipeline:test` | 58 (kasus) | 58 | 0 |
| Accounts | `npm run accounts:test` | 3 | 3 | 0 |
| Evaluasi & AI tools | `tsx --test` langsung pada berkas di `tools/` | 64 | 64 | 0 |
| Build | `npm run build` (Wrangler dry-run) | — | — | tidak ada baris error |
| **Total** | | **2.034** | **2.034** | **0** |

* Total adalah penjumlahan angka CI. Satuannya tidak seragam (database per berkas, pipeline per kasus), sehingga total hanya indikatif.
* Log CI tidak memuat kesimpulan run keseluruhan. Konfirmasi di halaman GitHub Actions sebelum menulis "CI lulus". Log CI juga tidak mencakup Flutter (lihat Bab 4, Tabel 4.3) atau uji browser, karena keduanya tidak dijalankan di CI.
* Log CI memuat peringatan deprecation: `actions/checkout@v4` dan `actions/setup-node@v4` berjalan di Node 20 yang dipaksa ke Node 24. Ini hanya pemberitahuan, bukan kegagalan.

**B. Uji fokus lokal** — **log lokal, belum disimpan**; angka ini tidak ada di log CI.

| Modul / Test Suite | Tests | Durasi (ms) | Status |
| :--- | ---: | ---: | :--- |
| `apps/worker/deterministic-relevance` | 9 | 201 | log lokal, belum disimpan |
| `apps/web/embedding-pca` | 5 | 228 | log lokal, belum disimpan |
| `apps/worker/discrepancy-detector` | 13 | 262 | log lokal, belum disimpan |
| `apps/db/news-triage-decisions` | 8 | 9.209 | log lokal, belum disimpan |

* **Tingkat Kelulusan (*Pass Rate*):** 0 gagal dari 2.034 tes/kasus yang tercatat di log CI.
* **Stabilitas Pengujian:** Dokumen ini hanya memuat satu run CI (commit cec9358). Belum ada pengulangan yang membuktikan tidak ada flaky test. Jeda 15 ms yang ditambahkan pada `news-triage-decisions.test.ts` (commit `e1e50f0`) adalah perubahan uji, bukan bukti determinisme.
* **Kesiapan Rilis:** Hasil ini mendukung klaim unit test pada lapisan yang diuji (lihat 1.b). Hasil ini tidak membuktikan kesiapan rilis atau kebenaran data live.
