import 'package:flutter/material.dart';

import 'public_models.dart';
import 'theme.dart';
import 'ui_helpers.dart';

/// HIST-UI-01: the read-only "Lihat perubahan" disclosure under a history entry. It lists what changed from the previous
/// published version. It never says that a change makes an area safe or that an incident is resolved.

const _emptyValue = 'Tidak ada';
const _eventTimePrecisions = {'exact', 'date', 'range'};

String historyFieldLabel(String field) => switch (field) {
      'title' => 'Judul',
      'summary' => 'Ringkasan',
      'category' => 'Kategori',
      'lifecycle' => 'Status kejadian',
      'freshness' => 'Status tinjau',
      'event_time' => 'Waktu kejadian',
      'validity' => 'Masa berlaku',
      'places' => 'Lokasi',
      'services' => 'Layanan',
      'institutions' => 'Lembaga',
      'audiences' => 'Kelompok terdampak',
      'claims' => 'Klaim',
      'impacts' => 'Dampak',
      _ => field,
    };

/// One side of a text change. Known enum values use the mobile labels. An unknown wire value is shown as it was sent,
/// the same as the web.
String historyValueText(String field, String? value) => switch (field) {
      'category' => _enumLabel(value, (v) => EventCategory.parse(v).label),
      'lifecycle' => _enumLabel(value, (v) => EventLifecycle.parse(v).label),
      'freshness' => _enumLabel(value, (v) => FreshnessStatus.parse(v).label),
      'event_time' => _eventTimeText(value),
      'validity' => _validityText(value),
      _ => value == null || value.trim().isEmpty ? _emptyValue : value,
    };

String _enumLabel(String? value, String Function(String) labelOf) {
  if (value == null || value.trim().isEmpty) return _emptyValue;
  try {
    return labelOf(value);
  } on ContractViolation {
    return value;
  }
}

/// The worker encodes event_time as `<precision> <start|-> <end|->`; null means unknown.
String _eventTimeText(String? value) {
  if (value == null) {
    return formatEventTime(
        const TimeScope(start: null, end: null, precision: 'unknown'));
  }
  final parts = value.split(' ');
  final precision = parts.first;
  if (!_eventTimePrecisions.contains(precision)) return value;
  return formatEventTime(TimeScope(
    start: _bound(parts, 1),
    end: _bound(parts, 2),
    precision: precision,
  ));
}

/// The worker encodes validity as `<from|-> <until|->`; null means no validity window.
String _validityText(String? value) {
  if (value == null) return 'Tidak ada masa berlaku dari sumber';
  final parts = value.split(' ');
  final from = _bound(parts, 0);
  final until = _bound(parts, 1);
  if (from != null && until != null) {
    return '${formatWib(from)} – ${formatWib(until)}';
  }
  if (until != null) return 'Sampai ${formatWib(until)}';
  if (from != null) return 'Mulai ${formatWib(from)}';
  return _emptyValue;
}

String? _bound(List<String> parts, int index) {
  if (index >= parts.length || parts[index] == '-') return null;
  return parts[index];
}

String _countText(String field, int count) =>
    '$count ${field == 'claims' ? 'klaim' : 'dampak'}';

class HistoryChangesTile extends StatelessWidget {
  const HistoryChangesTile({super.key, required this.changes});
  final List<HistoryChange> changes;

  @override
  Widget build(BuildContext context) {
    if (changes.isEmpty) return const SizedBox.shrink();
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      childrenPadding: const EdgeInsets.only(bottom: 8),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      shape: const Border(),
      collapsedShape: const Border(),
      title: Text('Lihat perubahan (${changes.length})',
          style: Theme.of(context).textTheme.labelLarge),
      children: [
        Text('Dibandingkan dengan versi terbit sebelumnya.',
            style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 8),
        for (final change in changes) _HistoryChangeRow(change: change),
      ],
    );
  }
}

class _HistoryChangeRow extends StatelessWidget {
  const _HistoryChangeRow({required this.change});
  final HistoryChange change;

  @override
  Widget build(BuildContext context) {
    final content = switch (change) {
      HistoryValueChange c => _DiffText(
          before: historyValueText(c.field, c.before),
          after: historyValueText(c.field, c.after)),
      HistoryCountChange c => _DiffText(
          before: _countText(c.field, c.before),
          after: _countText(c.field, c.after)),
      HistoryNamesChange c => _NameChips(added: c.added, removed: c.removed),
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(historyFieldLabel(change.field),
              style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: 3),
          content,
        ],
      ),
    );
  }
}

/// "before → after". The screen reader hears "Sebelum: … Sesudah: …", not the arrow.
class _DiffText extends StatelessWidget {
  const _DiffText({required this.before, required this.after});
  final String before;
  final String after;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = context.palette.inkMuted;
    return Semantics(
      label: 'Sebelum: $before. Sesudah: $after.',
      excludeSemantics: true,
      child: Wrap(
        spacing: 6,
        runSpacing: 2,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(before,
              style: theme.textTheme.bodyMedium?.copyWith(
                  color: muted, decoration: TextDecoration.lineThrough)),
          Icon(Icons.arrow_forward, size: 16, color: muted),
          Text(after,
              style: theme.textTheme.bodyMedium
                  ?.copyWith(fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}

class _NameChips extends StatelessWidget {
  const _NameChips({required this.added, required this.removed});
  final List<String> added;
  final List<String> removed;

  @override
  Widget build(BuildContext context) => Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final name in added) _NameChip(name: name, added: true),
          for (final name in removed) _NameChip(name: name, added: false),
        ],
      );
}

/// A name with its change written in words for screen readers ("Ditambahkan: X", "Dihapus: X"). The +/− glyph is
/// visual only.
class _NameChip extends StatelessWidget {
  const _NameChip({required this.name, required this.added});
  final String name;
  final bool added;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Semantics(
      label: '${added ? 'Ditambahkan' : 'Dihapus'}: $name',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: added ? p.brandSoft : p.surfaceAlt,
          border: Border.all(color: p.line),
          borderRadius: BorderRadius.circular(WaspadaShape.pill),
        ),
        child: Text(
          '${added ? '+' : '−'} $name',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(color: p.ink),
        ),
      ),
    );
  }
}
