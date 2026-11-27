import 'package:flutter/material.dart';

import 'theme.dart';

/// MOBILE-RECENT-01 (owner, 23 Nov 2026): the map and the list open on events whose current public version was
/// published (first publication or an update) in the last 24 hours. This is the publication time on Waspada, never the
/// event time. Matches the web map (MAP-RECENT-01).
enum RecencyWindow { last24h, all }

const recentWindow = Duration(hours: 24);
const recentScopeText = 'Terbit atau diperbarui dalam 24 jam terakhir.';
const emptyRecentTitle =
    'Tidak ada laporan yang terbit atau diperbarui dalam 24 jam terakhir.';
const emptyRecentNote =
    'Daftar ini hanya memuat laporan yang sudah terbit. Hasil kosong tidak berarti tidak ada kejadian.';

String olderHiddenText(int count) => '$count lebih lama disembunyikan';
String showAllText(int count) => 'Tampilkan semua ($count lebih lama)';

/// True when [publishedAt] is within 24 hours of [now]. A time after [now] (a version newer than the device clock)
/// counts as recent; a missing or unreadable time does not.
bool publishedRecently(String? publishedAt, DateTime now) {
  if (publishedAt == null) return false;
  final published = DateTime.tryParse(publishedAt);
  if (published == null) return false;
  return now.toUtc().difference(published.toUtc()) <= recentWindow;
}

/// "24 jam" / "Semua" segmented switch.
class RecencySwitch extends StatelessWidget {
  const RecencySwitch({super.key, required this.value, required this.onChanged});
  final RecencyWindow value;
  final ValueChanged<RecencyWindow> onChanged;

  @override
  Widget build(BuildContext context) => SegmentedButton<RecencyWindow>(
        showSelectedIcon: false,
        style: SegmentedButton.styleFrom(
          visualDensity: VisualDensity.compact,
          tapTargetSize: MaterialTapTargetSize.padded,
          textStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
        ),
        segments: const [
          ButtonSegment(
              value: RecencyWindow.last24h,
              icon: Icon(Icons.schedule_rounded, size: 16),
              label: Text('24 jam'),
              tooltip: 'Terbit atau diperbarui 24 jam terakhir'),
          ButtonSegment(
              value: RecencyWindow.all,
              label: Text('Semua'),
              tooltip: 'Semua laporan terbit yang dimuat'),
        ],
        selected: {value},
        onSelectionChanged: (selection) => onChanged(selection.single),
      );
}

/// One line that names the window and how many loaded events it hides.
class RecencyCaption extends StatelessWidget {
  const RecencyCaption({super.key, required this.olderHidden});
  final int olderHidden;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final style = Theme.of(context).textTheme.bodySmall;
    return Text.rich(
      TextSpan(children: [
        WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Icon(Icons.schedule_rounded, size: 14, color: p.brand),
            )),
        TextSpan(
            text: recentScopeText,
            style: style?.copyWith(fontWeight: FontWeight.w700)),
        if (olderHidden > 0)
          TextSpan(text: ' · ${olderHiddenText(olderHidden)}', style: style),
      ]),
    );
  }
}

/// The empty 24-hour window: never an all-clear, and one action shows the older events.
class EmptyRecentNotice extends StatelessWidget {
  const EmptyRecentNotice(
      {super.key, required this.olderHidden, required this.onShowAll});
  final int olderHidden;
  final VoidCallback onShowAll;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: p.surfaceAlt,
        borderRadius: BorderRadius.circular(WaspadaShape.card),
        border: Border.all(color: p.line),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.schedule_rounded, color: p.brand),
          const SizedBox(height: 8),
          Text(emptyRecentTitle, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 4),
          Text(emptyRecentNote, style: Theme.of(context).textTheme.bodySmall),
          if (olderHidden > 0) ...[
            const SizedBox(height: 12),
            FilledButton.tonalIcon(
                onPressed: onShowAll,
                icon: const Icon(Icons.history_rounded, size: 18),
                label: Text(showAllText(olderHidden))),
          ],
        ]),
      ),
    );
  }
}
