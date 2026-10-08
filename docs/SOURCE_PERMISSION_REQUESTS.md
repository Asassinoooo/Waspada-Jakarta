# Source permission and data-use request drafts

**Status:** Internal drafts only; no request has been sent and no source is approved.
**Prepared:** 4 October 2026; terms reviewed and draft updated 8 October 2026
**Related:** [SPEC-01 source feasibility](SOURCE_FEASIBILITY.md), [source verification plan](../SOURCE_VERIFICATION_PLAN.md), and [ADR-005 retention](decisions/ADR-005-source-retention.md)

Use these drafts to request written terms from each source owner or dataset steward. Fill in the team contact and supervisor details, verify each recipient through the source's official site, and retain the written reply with the source registry decision. Access to a public page, API endpoint, or RSS feed is not itself approval for Waspada's proposed collection and processing.

## Proposed project use to disclose

Waspada Jakarta is a Team 12 software-engineering course prototype that displays attributed information about reported safety incidents and disruptions. The proposed public demo would use Cloudflare's free tier and Neon Free, but neither is configured. It may retrieve authorized data, extract structured facts, link claims to evidence, and display source-supported summaries and geometry. A third-party inference provider has not been selected. The team does not plan to fine-tune a model or train on source data. Only synthetic fixtures are currently enabled.

The project proposes no durable raw-source copy by default. If expressly permitted, a short evidence excerpt may be retained while a related event version is current and for up to 90 days afterward, with a 365-day maximum from fetch; derived embeddings and caches would expire with the source text. The current design targets removal from active indexes within 24 hours after a deletion/retraction instruction, while the off-provider backup and deletion-replay method remains unresolved. Ask whether these terms are acceptable and record any shorter or different limits. Do not promise that the unresolved backup target already works.

## BMKG — official API and warning display

**Subject:** Permohonan arahan akses API dan izin integrasi informasi BMKG — proyek akademik Waspada Jakarta

Yth. Biro Hukum, Hubungan Masyarakat, dan Kerja Sama BMKG,

Kami dari Team 12 sedang mengembangkan Waspada Jakarta, prototipe akademik untuk menyajikan informasi keselamatan dan gangguan di Jakarta. Kami membaca Ketentuan Penggunaan BMKG dan tidak akan melakukan scraping pada situs atau aplikasi layanan publik.

Kami memohon arahan mengenai jalur API resmi yang dapat digunakan dan apakah BMKG dapat memberikan izin tertulis untuk penggunaan berikut dalam demo publik non-komersial:

- menerima peringatan cuaca resmi dan pembaruan/pembatalannya melalui API yang disetujui;
- menampilkan informasi beserta atribusi, tautan, logo, dan isi/peringatan secara utuh sesuai ketentuan BMKG;
- menyimpan hanya bidang dan metadata yang diizinkan, termasuk waktu kirim, masa berlaku, area, identitas pembaruan, serta catatan audit minimal;
- melakukan ekstraksi atau ringkasan terbatas dengan model pihak ketiga yang belum dipilih, tanpa pelatihan atau fine-tuning; dan
- mematuhi batas permintaan, retensi, cache, koreksi/pencabutan, serta penghapusan yang BMKG tetapkan.

Mohon konfirmasi endpoint/API yang tepat, proses pendaftaran, batas dan interval akses, persyaratan tampilan lengkap/atribusi, izin pemrosesan oleh layanan pihak ketiga, retensi yang diperbolehkan, dan apakah ada biaya. Kami tidak memiliki anggaran untuk layanan berbayar dan tidak akan mengaktifkan konektor sebelum memperoleh persetujuan dan menyelesaikan persyaratannya.

Terima kasih. Kami dapat mengirimkan demo dan rancangan alur data untuk ditinjau.

Hormat kami,

[Nama dan kontak perwakilan Team 12]  
[Program studi, kelas, dan dosen pembimbing]

## PetaBencana — laporan urun daya

**Subject:** Request to confirm educational use, attribution, API, and retention conditions for Waspada Jakarta

Hello Yayasan Peta Bencana / PetaBencana.id team,

We are Team 12, developing Waspada Jakarta as a university software-engineering prototype. We have reviewed the published non-commercial CC BY-NC 4.0 information and would like to confirm that our specific proposed use fits its terms before accessing or retaining reports.

The planned demonstration may be publicly accessible, hosted on Cloudflare's free tier with a Neon Free database, and may send approved report text to a third-party model API for extraction and claim-grounded summaries. No provider has been selected or configured, and we do not plan to train or fine-tune a model. We would show source attribution, links, timestamps, source-supported geometry, and changes to derived summaries. Our proposed retention limits and unresolved off-provider backup plan are described above.

Could you please confirm:

1. Whether this public, no-fee academic demonstration remains non-commercial under the published CC BY-NC 4.0 license, including the planned hosting and possible model inference.
2. Whether the documented Jakarta reports API may be queried automatically, and the required authentication, user-agent, rate limit, and attribution wording.
3. Which report fields and geometries may be stored, summarized, embedded, displayed, cached, or linked publicly.
4. Whether model-provider processing is allowed, including temporary transfer of report text, and whether any provider, region, or retention restrictions apply.
5. The required retention/deletion behavior for reports, excerpts, vectors, backups, and derived claims after correction, removal, or license termination.
6. How to identify and process report updates, removals, and corrections without implying that an empty response means there are no incidents.
7. Which license governs data returned by the current API: the [user agreement](https://docs.petabencana.id/perjanjian-lisensi-pengguna) and [non-commercial page](https://docs.petabencana.id/informasi-lisensi-data/penggunaan-non-komersial-cc-by-nc-4.0) state CC BY-NC 4.0 for non-commercial use, while the PetaBencana organization repository's [`LICENSING.md`](https://github.com/petabencana/petabencana-meta/blob/master/petabencana.id/LICENSING.md) states CC BY 4.0 for collected data. Please clarify which terms apply to current API data and to any user-submitted or third-party content included in a report.

We will keep the connector disabled and use authored synthetic fixtures until we have recorded the applicable terms and confirmed that our design complies. Please let us know if you require a different attribution or a written agreement.

Regards,

[Name and contact for Team 12]  
[University, course, instructor]

## ANTARA — RSS discovery and article use

**Subject:** Permohonan izin tertulis penggunaan RSS dan konten untuk prototipe akademik Waspada Jakarta

Yth. Tim ANTARA,

Kami dari Team 12 mengembangkan prototipe akademik Waspada Jakarta untuk membantu pengguna menemukan laporan keselamatan dan gangguan di Jakarta. Kami telah membaca Terms of Use dan dokumentasi RSS ANTARA. Kami memahami ketersediaan RSS tidak otomatis memberi izin untuk menyimpan, mengolah dengan AI, atau menerbitkan ulang konten.

Kami memohon izin tertulis dan ketentuan yang berlaku untuk:

- menggunakan feed Metro dan Metro Kriminalitas untuk menemukan tautan dan metadata artikel;
- mengambil halaman artikel hanya jika diizinkan, dalam batas frekuensi yang ditentukan;
- mengirim isi yang diizinkan ke layanan inferensi pihak ketiga untuk ekstraksi fakta terbatas (tanpa training/fine-tuning);
- menampilkan ringkasan beratribusi, tautan ke artikel asli, waktu publikasi sumber, dan kutipan pendek yang Anda izinkan; serta
- menyimpan metadata, kutipan, hasil ekstraksi, dan representasi turunan untuk jangka waktu yang Anda setujui, dengan proses koreksi dan penghapusan.

Demo yang diusulkan dapat diakses publik tanpa biaya dan direncanakan memakai Cloudflare Free serta Neon Free. Model belum dipilih. Mohon jelaskan apakah penggunaan tersebut diizinkan, jenis feed/metadata yang boleh diproses, atribusi, batas akses, pembatasan untuk kriminalitas atau subjek pribadi, retensi, penggunaan AI, dan prosedur pencabutan/koreksi. Kami tidak akan mengaktifkan polling atau pengambilan artikel sebelum menerima izin yang secara jelas mencakup kegiatan tersebut.

Hormat kami,

[Nama dan kontak perwakilan Team 12]  
[Program studi, kelas, dan dosen pembimbing]

## Satu Data Jakarta — metadata dataset keamanan/kriminalitas

**Subject:** Permohonan klarifikasi metadata dan persyaratan penggunaan dataset keamanan/kriminalitas untuk proyek akademik

Yth. Pengelola Satu Data Jakarta dan wali data dataset terkait,

Kami dari Team 12 sedang menilai katalog Satu Data Jakarta untuk proyek akademik Waspada Jakarta. Kami menemukan judul katalog “Data Angka Kriminalitas yang Tertangani”, tetapi belum dapat memverifikasi skema dan granularitasnya. Kami juga menemukan data CRM yang berupa agregat periodik, yang tidak akan kami gunakan sebagai bukti untuk kejadian individual.

Mohon bantuannya mengonfirmasi URL dan versi dataset yang benar, definisi setiap kolom, periode dan cakupan geografis, jadwal pembaruan, serta apakah dataset berisi data agregat atau catatan per kejadian. Entri yang terlihat menandai data sebagai `Terbuka` dan menampilkan endpoint API, tetapi kami belum menemukan lisensi atau ketentuan penggunaan ulang yang berlaku untuk dataset tersebut. Mohon tunjukkan lisensi/ketentuan khusus dataset, atribusi, batas penggunaan API/unduhan, dan apakah penyimpanan, transformasi, publikasi ulang, atau pemrosesan menggunakan model pihak ketiga diizinkan.

Kami tidak akan menganggap data agregat sebagai bukti adanya kejadian tertentu atau zona bahaya terkini. Mohon pula informasikan cara memperoleh pembaruan, koreksi, versi historis, atau penarikan data. Kami tidak akan mengimpor dataset sebelum skema dan persyaratan penggunaannya terdokumentasi.

Hormat kami,

[Nama dan kontak perwakilan Team 12]  
[Universitas, mata kuliah, dan dosen pembimbing]

## Source-registry record required before activation

For each source, record the accountable publisher and steward; exact approved URL/API and access method; permission reference, scope, dates, and expiry; allowed fields and transformations; public display and exact attribution; model-processing limits; polling interval and request limits; retention, backup, correction, and deletion rules; source remit and reliability limitations; reviewer and approval date; and the technical dataset/connector mode. Mark each source `pending`, `approved`, `rejected`, or `expired` with a reason. Approval of access alone must not be treated as approval to publish a claim.
