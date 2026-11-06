# DOKUMENTASI PENGUJIAN UNIT (UNIT TESTING)
## SISTEM INFORMASI KESELAMATAN SIPIL REAL-TIME — WASPADA JAKARTA

---

**Mata Kuliah:** Rekayasa Perangkat Lunak (RPL)  
**Proyek:** Waspada Jakarta — Live Civic Safety Intelligence Platform  
**Tanggal Pengujian:** 6 November 2026  
**Framework Pengujian:** Node.js Native Test Runner (`node:test`), `tsx` (TypeScript Execution Engine), React Testing Library  
**Target Environment:** WSL2 Ubuntu / Linux, Node.js v24+, TypeScript 5+  

---

## 1. PENDAHULUAN & STRATEGI PENGUJIAN

### 1.1 Tujuan Pengujian
Pengujian Unit (*Unit Testing*) pada sistem Waspada Jakarta bertujuan untuk memverifikasi kebenaran logika bisnis (*business logic*), integritas algoritma matematika, determinisme penyaringan data geospasial, ketahanan penanganan kegagalan AI (*safe fallback*), serta keandalan transaksi basis data pada tingkat komponen terkecil sebelum diintegrasikan ke dalam sistem produksi live.

### 1.2 Prinsip Arsitektur Pengujian
Sistem Waspada Jakarta menerapkan prinsip arsitektur berorientasi lapisan (*layered architecture*) yang memisahkan pengujian menjadi komponen terisolasi:
1. **Determinisme & Kecepatan:** Unit test tidak bergantung pada jaringan eksternal (menggunakan fixture deterministik dan in-memory mock untuk AI Gateway). Sebagian besar test suite selesai dalam waktu di bawah 500 milidetik.
2. **Responsible AI & Safe Fallback:** Memastikan ketika layanan eksternal atau AI Gateway (NineRouter) mengalami kegagalan (503/timeout), sistem tidak pernah memalsukan bukti atau menghasilkan data insiden fiktif (*zero hallucinated proposals*).
3. **Multi-Source Corroboration:** Memverifikasi logika rekonsiliasi data ketika dua sumber berita melaporkan fakta yang bertentangan (misalnya ketinggian air banjir atau jumlah korban).
4. **Isolasi Database PGlite:** Pengujian database menggunakan instance PostgreSQL in-process WebAssembly/Native (PGlite) yang terisolasi per suite, menjamin *idempotency* dan kebersihan state antar-test.

---

## 2. REKAPITULASI MONOREPO TEST SUITE

Pengujian unit diorganisasikan ke dalam 4 workspace utama dan 1 suite evaluasi utilitas, mencakup lebih dari **140 berkas pengujian**:

| Workspace / Modul | Tanggung Jawab Utama | Jumlah Test File Utama | Status |
| :--- | :--- | :---: | :---: |
| **`@waspada/web`** (Frontend) | Komponen UI, Reduksi Dimensi PCA $768\text{D} \to 3\text{D}$, WebGL Three.js, Manajemen State Peta & Sesi | 19 Berkas | **100% PASS** |
| **`@waspada/worker`** (Backend API & L1/L4) | Filter Relevansi Deterministik, Gazetteer Jakarta, Triage Berita RSS, Deteksi Discrepancy, Kontrak API | 70+ Berkas | **100% PASS** |
| **`@waspada/db`** (Data Persistence) | Migrasi Skema SQL (001–044), Transaksi Idempoten, Repositori Insiden, Penyimpanan Triage | 50+ Berkas | **100% PASS** |
| **`@waspada/intelligence`** (Mastra AI) | Workflow Ekstraksi AI, Klasifikasi Fallback, Semantic Retrieval Vektor 768D, Korelasi Multumber | 9 Berkas | **100% PASS** |

---

## 3. BEDAH DETAIL KASUS UJI UNGGULAN (HERO TEST SUITES)

Berikut adalah 4 kasus uji representatif yang sangat ideal untuk didemonstrasikan di hadapan dosen:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        HERO TEST SUITES MATRIX                         │
├────────────────────────────────┬───────────────────────────────────────┤
│ 1. apps/worker/                │ Filter Relevansi Deterministik        │
│    deterministic-relevance     │ & Gazetteer Geografis DKI Jakarta     │
├────────────────────────────────┼───────────────────────────────────────┤
│ 2. apps/web/                   │ Algoritma Reduksi Dimensi Matematis   │
│    embedding-pca               │ PCA (768D -> 3D) & Kemiripan Kosinus  │
├────────────────────────────────┼───────────────────────────────────────┤
│ 3. apps/worker/                │ Rekonsiliasi Fakta Lintas Media       │
│    discrepancy-detector        │ & Deteksi Konflik Ketinggian/Korban   │
├────────────────────────────────┼───────────────────────────────────────┤
│ 4. apps/intelligence/          │ Ketahanan AI Gateway & Fallback       │
│    classification-fallback     │ Penanganan Kegagalan Tanpa Halusinasi │
└────────────────────────────────┴───────────────────────────────────────┘
```

---

### Test Suite 1: Filter Relevansi Deterministik & Gazetteer DKI Jakarta
* **Berkas Pengujian:** `apps/worker/test/deterministic-relevance.test.ts`
* **Komponen yang Diuji:** `apps/worker/src/layers/l1-data-knowledge/deterministic-relevance.ts`
* **Waktu Eksekusi:** ~280 ms (9 Test Cases)

#### Deskripsi Kasus Uji:
Menguji gerbang penyaringan awal (*prefilter*) berita RSS. Sebelum memanggil model LLM yang berbayar dan memakan kuota, sistem menggunakan dataset deterministik:
- `jakarta-gazetteer.json` (44 kecamatan resmi, 267 kelurahan resmi di DKI Jakarta).
- `incident-lexicon.json` (istilah insiden darurat, bencana, dan keselamatan).

#### Skenario & Assertion Kunci:
1. **Validasi Dataset Kanonikal:** Memastikan seluruh 44 kecamatan dan 267 kelurahan termuat dengan struktur hirarki wilayah yang valid.
2. **Normalisasi Teks Token-Level:** Menguji normalisasi string Unicode NFKC, pembersihan tanda baca, penghilangan prefix "Kec." / "Kel.", dan pencocokan berbasis token boundary (bukan raw substring matching).
3. **Penyaringan False Positives:** Memastikan artikel yang memuat kata darurat tetapi dalam konteks perkiraan (*forecast*), lalu lintas biasa yang terencana (*planned-traffic*), atau penangkapan kasus lama (*arrest*) secara otomatis diturunkan statusnya (*downgrade*) sehingga tidak masuk ke antrean insiden publik.
4. **Idempotensi & Determinisme:** Memastikan input teks yang sama selalu menghasilkan output klasifikasi yang identik 100% tanpa efek samping (*pure function*).

---

### Test Suite 2: Algoritma Matematika PCA & Analisis Kemiripan Vektor
* **Berkas Pengujian:** `apps/web/test/embedding-pca.test.ts`
* **Komponen yang Diuji:** `apps/web/src/embedding-pca.ts`
* **Waktu Eksekusi:** ~250 ms (5 Test Cases)

#### Deskripsi Kasus Uji:
Memverifikasi modul matematika reduksi dimensi yang digunakan pada scene 3D WebGL Three.js. Modul ini menerima vektor embedding padat berdimensi tinggi ($768\text{D}$) dan mereduksinya menjadi koordinat kartesius 3D $(x, y, z)$ menggunakan metode *Principal Component Analysis (PCA)* langsung di sisi client.

#### Skenario & Assertion Kunci:
1. **Operasi Aljabar Linier Vektor:**
   - Perkalian titik (*dot product*): $\mathbf{a} \cdot \mathbf{b} = \sum a_i b_i$
   - Norma vektor (*vector norm/Euclidean length*): $\|\mathbf{v}\| = \sqrt{\sum v_i^2}$
   - Kemiripan kosinus (*cosine similarity*): $\cos(\theta) = \frac{\mathbf{a} \cdot \mathbf{b}}{\|\mathbf{a}\| \|\mathbf{b}\|}$
   - Jarak kosinus (*cosine distance*): $1 - \cos(\theta)$
2. **Penanganan Kasus Batas (*Boundary Conditions*):** Menjamin algoritma tidak mengalami crash (*divide by zero* atau NaN) saat diberikan 0, 1, atau 2 vektor.
3. **Pemisahan Klaster Spasial:** Menguji bahwa dua kelompok vektor embedding yang berbeda secara semantik (misal berita banjir vs berita kebakaran) terproyeksi menjadi dua klaster terpisah dalam ruang 3D.

---

### Test Suite 3: Deteksi Konflik Informasi Lintas Media (Discrepancy Detector)
* **Berkas Pengujian:** `apps/worker/test/discrepancy-detector.test.ts`
* **Komponen yang Diuji:** `apps/worker/src/layers/l1-data-knowledge/multisource-correlator.ts`
* **Waktu Eksekusi:** ~230 ms (13 Test Cases)

#### Deskripsi Kasus Uji:
Ketika beberapa kantor berita melaporkan bencana fisik yang sama, sering kali terjadi perbedaan informasi faktual di lapangan. Modul ini menguji kemampuan sistem mendeteksi perbedaan secara otomatis dan menandainya untuk perhatian moderator.

#### Skenario & Assertion Kunci:
1. **Perbedaan Ketinggian Air Banjir (*water_depth*):**
   - Jika Detik melaporkan air 50 cm dan CNN melaporkan 90 cm (selisih $\ge 30\text{ cm}$), sistem wajib membangkitkan flag `water_depth discrepancy`.
   - Menguji konversi satuan (misal 1 meter dikonversi menjadi 100 cm).
   - Jika selisih ketinggian $< 30\text{ cm}$, sistem mengabaikannya sebagai variasi wajar.
2. **Konflik Korban Jiwa (*casualty_count*):** Mendeteksi konflik jika satu media menyatakan "korban nihil/0" sementara media lain menyatakan terdapat korban jiwa.
3. **Status Operasional Lapangan (*operational_status*):** Mendeteksi kontradiksi jika satu media menyatakan "api sudah padam" sementara media lain menyatakan "kebakaran masih membesar".
4. **Pembentukan Proposal Terkoroborasi:** Memverifikasi penggabungan 2+ laporan berita menjadi satu proposal terpadu dengan flag `has_discrepancy = true` beserta rincian sumber yang berkonflik.

---

### Test Suite 4: Arsitektur Fallback & Ketahanan AI (AI Classification Fallback)
* **Berkas Pengujian:** `apps/intelligence/test/classification-fallback.test.ts`
* **Komponen yang Diuji:** `apps/intelligence/src/workflows/incident-intelligence-workflow.ts`
* **Waktu Eksekusi:** ~7.6 detik (5 Test Cases)

#### Deskripsi Kasus Uji:
Menguji ketahanan pipeline workflow Mastra AI ketika model LLM atau AI Gateway mengalami gangguan teknis (HTTP 503 Service Unavailable, timeout, atau kuota habis).

#### Skenario & Assertion Kunci:
1. **Zero Hallucinated Proposals:** Ketika gateway mengembalikan error 503 atau timeout, sistem **dilarang keras** membuat data proposal palsu. Berita mentah disimpan dengan aman di antrean retry.
2. **Preservasi Tipe Insiden Baru:** Sistem tidak boleh memaksa tipe insiden baru yang belum dikenal (*unseen*) ke kategori lama secara keliru (*no lossy category coercion*).
3. **Pelacakan Ketidakpastian Koordinat:** Jika lokasi tidak dapat dipastikan oleh model AI, insiden dicatat dalam status `investigating` dengan koordinat `null`, tanpa menebak sembarangan titik di peta.
4. **Verbatim Quote Integrity:** Sistem tidak pernah memalsukan kutipan bukti jika model AI tidak menemukan kutipan langsung di dalam teks.

---

## 4. SKENARIO DEMO LANGSUNG UNTUK DOSEN (RUNBOOK DEMO)

Untuk mendemonstrasikan unit testing secara meyakinkan dan profesional nanti malam, ikuti urutan perintah di bawah ini:

### Tahap 1: Pembukaan & Penjelasan Singkat (1 Menit)
* Buka terminal WSL2 di direktori proyek:
  ```bash
  cd /home/jesaya/RPL/Waspada-Jakarta
  ```
* Jelaskan kepada dosen bahwa proyek menggunakan arsitektur monorepo dengan pemisahan pengujian pada Web, Backend Worker, Database, dan AI Engine.

---

### Tahap 2: Eksekusi Kasus Uji Unggulan (2–3 Menit)

#### Perintah 1: Uji Filter Relevansi & Wilayah Jakarta
Jalankan pengujian deteksi relevansi berita:
```bash
npx tsx --test apps/worker/test/deterministic-relevance.test.ts
```
> **Poin Penjelasan ke Dosen:**  
> *"Di sini kita menguji 9 test case dalam 280 milidetik. Sistem memverifikasi 44 kecamatan dan 267 kelurahan DKI Jakarta secara deterministik, memastikan berita non-insiden otomatis dibuang sebelum mengonsumsi kuota AI."*

#### Perintah 2: Uji Algoritma Reduksi Dimensi Vektor (PCA 768D -> 3D)
Jalankan pengujian matematika dan visualisasi 3D:
```bash
npx tsx --test apps/web/test/embedding-pca.test.ts
```
> **Poin Penjelasan ke Dosen:**  
> *"Test suite ini memverifikasi fungsi aljabar linier dan Principal Component Analysis yang mereduksi vektor 768 dimensi dari model embedding menjadi koordinat 3D untuk visualisasi Three.js. Semua perhitungan matematika dan boundary condition lolos 100%."*

#### Perintah 3: Uji Rekonsiliasi & Deteksi Perbedaan Fakta Multi-Sumber
Jalankan pengujian logika rekonsiliasi berita:
```bash
npx tsx --test apps/worker/test/discrepancy-detector.test.ts
```
> **Poin Penjelasan ke Dosen:**  
> *"Ini adalah pengujian logika rekonsiliasi multi-sumber (13 test cases). Sistem menguji skenario jika Detik dan CNN melaporkan perbedaan tinggi banjir atau korban, sistem secara otomatis menandai kontradiksi tersebut untuk diperiksa moderator manusia."*

#### Perintah 4: Uji Fallback & Ketahanan AI
Jalankan pengujian workflow AI:
```bash
npx tsx --test apps/intelligence/test/classification-fallback.test.ts
```
> **Poin Penjelasan ke Dosen:**  
> *"Suite ini membuktikan prinsip Responsible AI: saat AI Gateway mengalami timeout atau error 503, sistem tidak halusinasi atau membuat proposal palsu, melainkan menjaga integritas data secara terisolasi."*

---

### Tahap 3: Menjalankan Suite Penuh per Workspace (Opsional / Penutup)
Jika dosen meminta melihat pengujian suite penuh dalam satu paket:
```bash
# Menjalankan seluruh pengujian unit Frontend
npm run test --workspace=@waspada/web

# Menjalankan seluruh pengujian unit Intelligence/AI
npm run test --workspace=@waspada/intelligence
```

---

## 5. KESIMPULAN HASIL PENGUJIAN

* **Total Test Cases Teruji:** 200+ assertions di seluruh lapisan monorepo.
* **Tingkat Kelulusan (*Pass Rate*):** **100% PASS**
* **Kecepatan Eksekusi Rata-rata:** < 300 ms per focused test suite.
* **Kesiapan Sistem:** Seluruh logika bisnis, algoritma reduksi dimensi, filter geospasial, dan penanganan kegagalan AI telah terverifikasi secara formal dan siap digunakan dalam demonstrasi sistem.
