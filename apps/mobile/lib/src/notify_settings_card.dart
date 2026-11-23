import 'package:flutter/material.dart';

import 'notify_platform.dart';
import 'theme.dart';

const notifyCardTitle = 'Notifikasi area saya';
const notifyCardIntro =
    'Beri tahu saya saat laporan yang cocok dengan minat di atas terbit atau diperbarui. Pencocokan berjalan di ponsel ini; minat Anda tidak dikirim ke layanan.';
const notifyCardCadence =
    'Ponsel memeriksa kira-kira setiap 15 menit saat ada internet. Android dapat menundanya untuk menghemat baterai.';
const notifyCardNotEmergency =
    'Ini bukan peringatan darurat. Dalam keadaan darurat, hubungi 112.';
const notifyNeedsInterest =
    'Simpan minimal satu minat agar ada yang bisa dicocokkan.';

/// NOTIFY-01: the switch on the Minat screen. Off by default; turning it on asks Android for permission first.
class NotifySettingsCard extends StatefulWidget {
  const NotifySettingsCard(
      {super.key, required this.controller, required this.hasSavedInterests});
  final NotifyController controller;

  /// False until at least one interest is saved on the device.
  final bool hasSavedInterests;

  @override
  State<NotifySettingsCard> createState() => _NotifySettingsCardState();
}

class _NotifySettingsCardState extends State<NotifySettingsCard> {
  bool? _enabled;
  bool _busy = false;
  String? _message;

  @override
  void initState() {
    super.initState();
    widget.controller.isEnabled().then((value) {
      if (mounted) setState(() => _enabled = value);
    });
  }

  Future<void> _toggle(bool next) async {
    setState(() {
      _busy = true;
      _message = null;
    });
    final result = next
        ? await widget.controller.enable()
        : await widget.controller.disable();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _enabled = result == NotifyToggleResult.on;
      _message = switch (result) {
        NotifyToggleResult.on =>
          'Notifikasi aktif. Pemeriksaan pertama hanya mencatat titik awal, jadi laporan lama tidak dikirim ulang.',
        NotifyToggleResult.off => 'Notifikasi dimatikan.',
        NotifyToggleResult.permissionDenied =>
          'Izin notifikasi ditolak. Izinkan dari Pengaturan Android > Aplikasi > Waspada Jakarta > Notifikasi.',
        NotifyToggleResult.unavailable =>
          'Notifikasi belum dapat diaktifkan di perangkat ini.',
      };
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    final on = _enabled == true;
    final canTurnOn = widget.hasSavedInterests;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: on ? p.brandSoft : p.surface,
        borderRadius: BorderRadius.circular(WaspadaShape.card),
        border: Border.all(color: on ? p.brand.withValues(alpha: 0.45) : p.line),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 8, 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: on ? p.brand : p.surfaceAlt,
                shape: BoxShape.circle,
              ),
              child: Icon(
                  on
                      ? Icons.notifications_active_rounded
                      : Icons.notifications_none_rounded,
                  size: 22,
                  color: on ? p.onBrand : p.inkMuted),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Semantics(
                header: true,
                child: Text(notifyCardTitle, style: text.titleMedium),
              ),
            ),
            Switch(
              value: on,
              onChanged: _enabled == null || _busy || (!on && !canTurnOn)
                  ? null
                  : _toggle,
            ),
          ]),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SizedBox(height: 10),
                  Text(notifyCardIntro, style: text.bodyMedium),
                  const SizedBox(height: 8),
                  Text('$notifyCardCadence $notifyCardNotEmergency',
                      style: text.bodySmall?.copyWith(color: p.inkMuted)),
                  if (!canTurnOn && !on) ...[
                    const SizedBox(height: 10),
                    Row(children: [
                      Icon(Icons.info_outline_rounded,
                          size: 16, color: p.inkMuted),
                      const SizedBox(width: 6),
                      Expanded(
                          child: Text(notifyNeedsInterest,
                              style: text.bodySmall
                                  ?.copyWith(fontWeight: FontWeight.w700))),
                    ]),
                  ],
                  if (_message != null) ...[
                    const SizedBox(height: 10),
                    Semantics(
                      liveRegion: true,
                      child: Text(_message!,
                          style: text.bodySmall?.copyWith(
                              fontWeight: FontWeight.w700,
                              color: on ? p.brand : p.ink)),
                    ),
                  ],
                ]),
          ),
        ]),
      ),
    );
  }
}
