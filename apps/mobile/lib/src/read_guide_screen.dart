import 'package:flutter/material.dart';

import 'theme.dart';
import 'ui_helpers.dart';

class ReadGuideScreen extends StatelessWidget {
  const ReadGuideScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
            title: const Text('Panduan membaca'),
            leading: IconButton(
                tooltip: 'Kembali',
                onPressed: () => Navigator.of(context).maybePop(),
                icon: const Icon(Icons.arrow_back))),
        body: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 30),
            children: [
              Semantics(
                header: true,
                child: Text('Empat hal yang berbeda',
                    style: Theme.of(context).textTheme.headlineMedium),
              ),
              const SizedBox(height: 8),
              Text(
                  'Status, kesegaran, bukti, dan kecocokan minat menjawab pertanyaan yang berlainan. Baca label dan waktunya bersama-sama.',
                  style: Theme.of(context).textTheme.bodyLarge),
              const SizedBox(height: 18),
              const _GuideItem(
                  icon: Icons.timeline,
                  title: 'Siklus kejadian atau dampak',
                  body:
                      'Direncanakan, berlangsung, selesai, dibatalkan, atau belum diketahui. Kejadian dan dampaknya bisa memiliki status berbeda.'),
              const _GuideItem(
                  icon: Icons.update,
                  title: 'Kesegaran informasi',
                  body:
                      'Perlu diperbarui jika waktu peninjauan terlewat; masa berlaku sumber berakhir jika batas validitas dari penerbit sudah lewat. Keduanya tidak membuktikan kondisi aman atau kejadian selesai.'),
              const _GuideItem(
                  icon: Icons.fact_check_outlined,
                  title: 'Bukti',
                  body:
                      'Label menerangkan jenis sumber yang mendukung klaim. Baca atribusi dan kualifikasi; label ini bukan jaminan kebenaran seluruh kejadian.'),
              const _GuideItem(
                  icon: Icons.tune,
                  title: 'Relevansi',
                  body:
                      'Kecocokan lokal berarti data yang ditampilkan cocok dengan minat pilihanmu. Itu bukan bukti, tingkat bahaya, atau bukti lokasi fisikmu.'),
              const SizedBox(height: 10),
              const _GuideItem(
                  icon: Icons.schedule,
                  title: 'Waktu',
                  body:
                      'Waktu kejadian/observasi, terbitnya sumber, validitas, waktu konteks, dan waktu keberhasilan sumber dipisahkan. WIB dipakai untuk waktu yang pasti; tanggal saja tidak diberi menit semu.'),
              const SizedBox(height: 10),
              const _GuideItem(
                  icon: Icons.layers_outlined,
                  title: 'Cakupan peta',
                  body:
                      'Aplikasi ini menampilkan daftar dan detail. Tidak ada titik, batas bahaya, atau rute yang diturunkan dari nama tempat.'),
              const SizedBox(height: 12),
              const ReadOnlyNotice(
                  title: 'Informasi publik, bukan layanan darurat.',
                  message:
                      'Tidak ada laporan yang cocok bukan berarti keadaan aman. Periksa sumber yang ditampilkan dan gunakan jalur bantuan resmi yang sesuai.'),
            ]),
      );
}

class _GuideItem extends StatelessWidget {
  const _GuideItem(
      {required this.icon, required this.title, required this.body});
  final IconData icon;
  final String title;
  final String body;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(icon, color: WaspadaColors.teal),
              const SizedBox(width: 12),
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Semantics(
                      header: true,
                      child: Text(title,
                          style: Theme.of(context).textTheme.titleMedium),
                    ),
                    const SizedBox(height: 5),
                    Text(body, style: Theme.of(context).textTheme.bodyMedium),
                  ])),
            ]),
          ),
        ),
      );
}
