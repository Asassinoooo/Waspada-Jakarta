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

/// A short relative label ("12 menit lalu") for a publication time. Returns null when the value cannot be read, so
/// callers fall back to [formatWib]. It describes when a version was published, never when an incident ended.
String? relativeWib(String? value, {DateTime? now}) {
  if (value == null) return null;
  final parsed = DateTime.tryParse(value);
  if (parsed == null) return null;
  final diff = (now ?? DateTime.now()).toUtc().difference(parsed.toUtc());
  if (diff.isNegative) return null;
  if (diff.inMinutes < 1) return 'baru saja';
  if (diff.inMinutes < 60) return '${diff.inMinutes} menit lalu';
  if (diff.inHours < 24) return '${diff.inHours} jam lalu';
  if (diff.inDays < 7) return '${diff.inDays} hari lalu';
  return null;
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

// POLISH-02: an automatic refresh is written as "corrected". It reads
// "Diperbarui otomatis", never "Versi dikoreksi".
String changeLabel(String value, {bool automatic = false}) {
  if (automatic && value == 'corrected') return 'Diperbarui otomatis';
  return switch (value) {
        'published' => 'Versi dipublikasikan',
        'corrected' => 'Versi dikoreksi',
        'impact_changed' => 'Dampak diperbarui',
        'retracted' => 'Versi ditarik',
        _ => 'Perubahan publik',
      };
}

String sourceHealthLabel(SourceHealth health) => switch (health) {
      SourceHealth.unknown => 'Status sumber belum diketahui',
      SourceHealth.healthy => 'Sumber merespons',
      SourceHealth.degraded => 'Respons sumber terbatas',
      SourceHealth.unavailable => 'Sumber tidak tersedia',
    };

/// The signal colour for a severity. Unknown severity uses a neutral surface; nothing maps to a "safe" colour.
Color severityColor(BuildContext context, IncidentSeverity? severity) {
  final p = context.palette;
  return switch (severity) {
    IncidentSeverity.critical => p.signalCritical,
    IncidentSeverity.high => p.signalHigh,
    IncidentSeverity.medium => p.signalMedium,
    IncidentSeverity.low => p.signalLow,
    _ => p.surfaceAlt,
  };
}

Color severityForeground(BuildContext context, IncidentSeverity? severity) =>
    severity == IncidentSeverity.critical
        ? Colors.white
        : severity == null
            ? context.palette.ink
            : context.palette.onSignal;

class ModeNotice extends StatelessWidget {
  const ModeNotice({super.key, required this.contextInfo});
  final PublicContext contextInfo;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final isDemo = contextInfo.datasetMode == DatasetMode.demo;
    final background = isDemo ? p.demo : p.brandSoft;
    final foreground = isDemo ? const Color(0xFF1A1405) : p.ink;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(WaspadaShape.control)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(isDemo ? Icons.science_outlined : Icons.sensors_rounded,
              size: 18, color: foreground),
          const SizedBox(width: 10),
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(contextInfo.notice,
                  style: TextStyle(
                      color: foreground,
                      fontSize: 13.5,
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
      this.color,
      this.foreground});
  final IconData icon;
  final String label;

  /// Background colour. Defaults to the palette's alternate surface.
  final Color? color;
  final Color? foreground;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final background = color ?? p.surfaceAlt;
    final fg = foreground ??
        (ThemeData.estimateBrightnessForColor(background) == Brightness.dark
            ? Colors.white
            : const Color(0xFF0F2229));
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(WaspadaShape.pill)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 14, color: fg),
        const SizedBox(width: 5),
        Flexible(
            child: Text(label,
                softWrap: true,
                style: TextStyle(
                    color: fg,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    height: 1.25))),
      ]),
    );
  }
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
  Widget build(BuildContext context) {
    final p = context.palette;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
          color: p.surface,
          borderRadius: BorderRadius.circular(WaspadaShape.card),
          border: Border.all(color: p.line)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
              color: p.brandSoft,
              borderRadius: BorderRadius.circular(WaspadaShape.control)),
          child: Icon(icon, color: p.brand, size: 20),
        ),
        const SizedBox(width: 12),
        Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 4),
          Text(message, style: Theme.of(context).textTheme.bodyMedium),
        ])),
      ]),
    );
  }
}

/// A small uppercase label above a section title.
class Kicker extends StatelessWidget {
  const Kicker(this.text, {super.key, this.color});
  final String text;
  final Color? color;
  @override
  Widget build(BuildContext context) => Text(text.toUpperCase(),
      style: Theme.of(context)
          .textTheme
          .labelSmall
          ?.copyWith(color: color ?? context.palette.brand, letterSpacing: 1.2));
}

Widget sectionTitle(String title, {String? kicker}) => Builder(
      builder: (context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (kicker != null) ...[
            Kicker(kicker),
            const SizedBox(height: 6),
          ],
          Semantics(
            header: true,
            child:
                Text(title, style: Theme.of(context).textTheme.headlineSmall),
          ),
        ],
      ),
    );

Widget labelledFact(BuildContext context, String label, String value) =>
    Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(height: 3),
        SelectableText(value, style: Theme.of(context).textTheme.bodyLarge),
      ]),
    );

/// A rounded surface with the palette border, used for grouped content.
class SurfaceCard extends StatelessWidget {
  const SurfaceCard(
      {super.key,
      required this.child,
      this.padding = const EdgeInsets.all(18),
      this.onTap,
      this.color});
  final Widget child;
  final EdgeInsets padding;
  final VoidCallback? onTap;
  final Color? color;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Material(
      color: color ?? p.surface,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(WaspadaShape.card),
          side: BorderSide(color: p.line)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
          onTap: onTap, child: Padding(padding: padding, child: child)),
    );
  }
}

/// A shimmering placeholder block shown while content loads. Motion is skipped when the platform asks for reduced
/// animations.
class SkeletonBlock extends StatefulWidget {
  const SkeletonBlock(
      {super.key, this.height = 16, this.width, this.radius = 10});
  final double height;
  final double? width;
  final double radius;
  @override
  State<SkeletonBlock> createState() => _SkeletonBlockState();
}

class _SkeletonBlockState extends State<SkeletonBlock>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 1100));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduce || _isTest) {
      _controller.stop();
    } else if (!_controller.isAnimating) {
      _controller.repeat(reverse: true);
    }
  }

  static bool get _isTest =>
      WidgetsBinding.instance.runtimeType.toString().contains('Test');

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) => Container(
        height: widget.height,
        width: widget.width,
        decoration: BoxDecoration(
          color: Color.lerp(p.surfaceAlt, p.line, _controller.value),
          borderRadius: BorderRadius.circular(widget.radius),
        ),
      ),
    );
  }
}

/// A card-shaped skeleton used for list loading states.
class SkeletonCard extends StatelessWidget {
  const SkeletonCard({super.key});
  @override
  Widget build(BuildContext context) => const SurfaceCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SkeletonBlock(height: 12, width: 90),
          SizedBox(height: 12),
          SkeletonBlock(height: 20),
          SizedBox(height: 8),
          SkeletonBlock(height: 20, width: 180),
          SizedBox(height: 14),
          SkeletonBlock(height: 12, width: 220),
        ]),
      );
}

/// A severity bar on the leading edge of an event card.
class SeverityRail extends StatelessWidget {
  const SeverityRail({super.key, required this.severity});
  final IncidentSeverity? severity;
  @override
  Widget build(BuildContext context) => Container(
        width: 5,
        decoration: BoxDecoration(
          color: severity == null
              ? context.palette.line
              : severityColor(context, severity),
          borderRadius: BorderRadius.circular(WaspadaShape.pill),
        ),
      );
}
