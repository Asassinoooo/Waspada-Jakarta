import 'package:flutter/material.dart';

import 'public_models.dart';
import 'theme.dart';

String formatWib(String? value) {
  if (value == null) return 'Tidak tersedia pada respons ini';
  final parsed = DateTime.tryParse(value);
  if (parsed == null) return 'Tidak tersedia pada respons ini';
  final jakarta = parsed.toUtc().add(const Duration(hours: 7));
  final day = jakarta.day.toString().padLeft(2, '0');
  final month = jakarta.month.toString().padLeft(2, '0');
  final year = jakarta.year.toString().padLeft(4, '0');
  final hour = jakarta.hour.toString().padLeft(2, '0');
  final minute = jakarta.minute.toString().padLeft(2, '0');
  return '$day-$month-$year $hour:$minute WIB';
}

String formatEventTime(TimeScope scope) {
  switch (scope.precision) {
    case 'exact':
      return scope.start == null
          ? 'Waktu tidak diketahui'
          : formatWib(scope.start);
    case 'date':
      if (scope.start == null) return 'Tanggal tidak diketahui';
      final date = DateTime.tryParse('${scope.start}T00:00:00Z');
      if (date == null) return 'Tanggal tidak tersedia';
      return '${date.day.toString().padLeft(2, '0')}-${date.month.toString().padLeft(2, '0')}-${date.year} (tanggal saja)';
    case 'range':
      if (scope.start == null || scope.end == null) {
        return 'Rentang waktu tidak tersedia';
      }
      return '${formatWib(scope.start)} sampai ${formatWib(scope.end)}';
    default:
      return 'Waktu tidak diketahui pada respons ini';
  }
}

String evidenceCaption(PublicClaim claim) {
  final source = claim.sources.isEmpty ? null : claim.sources.first.displayName;
  return switch (claim.evidenceLabel) {
    EvidenceLabel.issuerNotice => claim.evidenceLabel.label,
    EvidenceLabel.attributedReport =>
      source == null ? claim.evidenceLabel.label : 'Dilaporkan oleh $source',
    EvidenceLabel.independentCorroboration => claim.evidenceLabel.label,
    EvidenceLabel.crowdsourcedObservation =>
      source == null ? claim.evidenceLabel.label : 'Laporan warga ($source)',
  };
}

String changeLabel(String value) => switch (value) {
      'published' => 'Versi dipublikasikan',
      'corrected' => 'Versi dikoreksi',
      'impact_changed' => 'Dampak diperbarui',
      'retracted' => 'Versi ditarik',
      _ => 'Perubahan publik',
    };

String sourceHealthLabel(SourceHealth health) => switch (health) {
      SourceHealth.unknown => 'Status sumber belum diketahui',
      SourceHealth.healthy => 'Sumber merespons',
      SourceHealth.degraded => 'Respons sumber terbatas',
      SourceHealth.unavailable => 'Sumber tidak tersedia',
    };

class ModeNotice extends StatelessWidget {
  const ModeNotice({super.key, required this.contextInfo});
  final PublicContext contextInfo;

  @override
  Widget build(BuildContext context) {
    final isDemo = contextInfo.datasetMode == DatasetMode.demo;
    final background = isDemo ? WaspadaColors.caution : WaspadaColors.softPanel;
    final foreground = WaspadaColors.ink;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
      color: background,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(isDemo ? Icons.science_outlined : Icons.public_outlined,
              size: 20, color: foreground),
          const SizedBox(width: 10),
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(contextInfo.notice,
                  style: TextStyle(
                      color: foreground,
                      fontWeight: FontWeight.w700,
                      height: 1.4)),
            ),
          ),
        ],
      ),
    );
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill(
      {super.key,
      required this.icon,
      required this.label,
      this.color = WaspadaColors.softPanel});
  final IconData icon;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        decoration: BoxDecoration(
            color: color,
            border: Border.all(color: WaspadaColors.concrete),
            borderRadius: BorderRadius.circular(8)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 16, color: WaspadaColors.ink),
          const SizedBox(width: 6),
          Flexible(
              child: Text(label,
                  softWrap: true,
                  style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      height: 1.25))),
        ]),
      );
}

class ReadOnlyNotice extends StatelessWidget {
  const ReadOnlyNotice(
      {super.key,
      required this.title,
      required this.message,
      this.icon = Icons.info_outline});
  final String title;
  final String message;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
            color: WaspadaColors.softPanel,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: WaspadaColors.concrete)),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, color: WaspadaColors.ink, size: 21),
          const SizedBox(width: 12),
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text(title,
                    style: const TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Text(message, style: Theme.of(context).textTheme.bodyMedium),
              ])),
        ]),
      );
}

Widget sectionTitle(String title, {String? kicker}) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (kicker != null) ...[
          Text(kicker.toUpperCase(),
              style: const TextStyle(
                  fontSize: 12,
                  letterSpacing: 0.8,
                  fontWeight: FontWeight.w700,
                  color: WaspadaColors.teal)),
          const SizedBox(height: 6),
        ],
        Semantics(
          header: true,
          child: Text(title,
              style: const TextStyle(
                  fontSize: 21,
                  height: 1.25,
                  fontWeight: FontWeight.w700,
                  color: WaspadaColors.ink)),
        ),
      ],
    );

Widget labelledFact(BuildContext context, String label, String value) =>
    Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label,
            style: Theme.of(context)
                .textTheme
                .labelMedium
                ?.copyWith(color: WaspadaColors.ink.withValues(alpha: 0.72))),
        const SizedBox(height: 3),
        SelectableText(value, style: Theme.of(context).textTheme.bodyLarge),
      ]),
    );
