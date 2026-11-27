import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import 'event_detail_screen.dart';
import 'preferences.dart';
import 'public_api.dart';
import 'public_models.dart';
import 'recency.dart';
import 'theme.dart';
import 'ui_helpers.dart';

/// The Jakarta extent used for the whole map view. It is a camera frame only: nothing is drawn from it.
final jakartaBounds =
    LatLngBounds(const LatLng(-6.40, 106.65), const LatLng(-6.05, 107.05));

/// MOBILE-V2 map. Pins come only from Point geometries the API returns (the source's own or an agent's approximate
/// place). Events without a usable point are listed under "Tanpa titik lokasi" and never get a pin, a radius or a
/// fallback position.
class MapScreen extends StatefulWidget {
  const MapScreen({
    super.key,
    required this.api,
    required this.preferences,
    this.showTiles = true,
    this.clock = DateTime.now,
  });

  final PublicApi api;
  final PreferencesRepository preferences;

  /// Tests turn tiles off so no network request is made.
  final bool showTiles;

  /// The clock for the 24-hour window (tests pass a fixed one).
  final DateTime Function() clock;

  @override
  State<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends State<MapScreen> {
  static const _maxPages = 5;

  PublicContext? _contextInfo;
  List<MapPoint> _points = const [];
  List<EventRecord> _events = const [];
  ApiFailure? _failure;
  bool _loading = true;
  bool _partial = false;
  String? _selectedId;
  int _generation = 0;
  RecencyWindow _window = RecencyWindow.last24h;

  /// Loaded events inside the current window.
  List<EventRecord> get _visibleEvents {
    if (_window == RecencyWindow.all) return _events;
    final now = widget.clock();
    return _events
        .where((event) => publishedRecently(event.publishedAt, now))
        .toList();
  }

  /// Pins inside the window. With "24 jam", a pin whose event is not loaded has no known publication time, so it is
  /// shown only under "Semua".
  List<MapPoint> get _visiblePoints {
    if (_window == RecencyWindow.all) return _points;
    final ids = {for (final event in _visibleEvents) event.id};
    return _points.where((point) => ids.contains(point.eventId)).toList();
  }

  int get _olderHidden =>
      _window == RecencyWindow.all ? 0 : _events.length - _visibleEvents.length;

  void _setWindow(RecencyWindow window) {
    setState(() {
      _window = window;
      if (_selectedId != null &&
          !_visiblePoints.any((point) => point.eventId == _selectedId)) {
        _selectedId = null;
      }
    });
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _failure = null;
    });
    try {
      final contextInfo = await widget.api.getContext();
      final results = await Future.wait([
        widget.api.getEventMap(),
        _loadEvents(),
      ]);
      if (!mounted || generation != _generation) return;
      final points = results[0] as List<MapPoint>;
      final events = results[1] as ({List<EventRecord> events, bool partial});
      setState(() {
        _contextInfo = contextInfo;
        _points = points;
        _events = events.events;
        _partial = events.partial;
        _loading = false;
        if (_selectedId != null &&
            !_points.any((point) => point.eventId == _selectedId)) {
          _selectedId = null;
        }
      });
    } on ApiFailure catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _failure = error;
        _loading = false;
      });
    } catch (_) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _failure = const ApiFailure(ApiFailureKind.network);
        _loading = false;
      });
    }
  }

  Future<({List<EventRecord> events, bool partial})> _loadEvents() async {
    final events = <EventRecord>[];
    String? cursor;
    for (var page = 0; page < _maxPages; page++) {
      final result = await widget.api.listEvents(EventQuery(cursor: cursor));
      events.addAll(result.data);
      cursor = result.nextCursor;
      if (cursor == null) return (events: events, partial: false);
    }
    return (events: events, partial: true);
  }

  EventRecord? _eventFor(String id) {
    for (final event in _events) {
      if (event.id == id) return event;
    }
    return null;
  }

  List<EventRecord> get _withoutPoint {
    final pinned = {for (final point in _points) point.eventId};
    return _visibleEvents.where((event) => !pinned.contains(event.id)).toList();
  }

  Future<void> _openDetail(String eventId) async {
    final contextInfo = _contextInfo;
    if (contextInfo == null) return;
    final saved = await widget.preferences.load();
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => EventDetailScreen(
        api: widget.api,
        contextInfo: contextInfo,
        eventId: eventId,
        initialInterests: saved.interests,
        preferences: widget.preferences,
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final selected = _selectedId == null
        ? null
        : _visiblePoints
            .where((point) => point.eventId == _selectedId)
            .firstOrNull;
    final visiblePoints = _visiblePoints;
    return Scaffold(
      body: Stack(children: [
        Positioned.fill(
          child: FlutterMap(
            options: MapOptions(
              initialCameraFit: CameraFit.bounds(
                  bounds: jakartaBounds, padding: const EdgeInsets.all(24)),
              minZoom: 9,
              maxZoom: 17,
              interactionOptions: const InteractionOptions(
                  flags: InteractiveFlag.all & ~InteractiveFlag.rotate),
              onTap: (_, __) => setState(() => _selectedId = null),
            ),
            children: [
              if (widget.showTiles)
                TileLayer(
                  urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                  userAgentPackageName: 'id.waspada.waspada_jakarta_mobile',
                  tileBuilder: dark ? darkModeTileBuilder : null,
                )
              else
                ColoredBox(color: p.surfaceAlt),
              MarkerLayer(markers: [
                for (final point in visiblePoints)
                  Marker(
                    point: LatLng(point.latitude, point.longitude),
                    width: 44,
                    height: 44,
                    child: _Pin(
                      point: point,
                      severity: _eventFor(point.eventId)?.severity,
                      selected: point.eventId == _selectedId,
                      onTap: () =>
                          setState(() => _selectedId = point.eventId),
                    ),
                  ),
              ]),
              if (widget.showTiles)
                const SimpleAttributionWidget(
                    source: Text('OpenStreetMap contributors')),
            ],
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
            child: _MapHeader(
              loading: _loading,
              pinned: visiblePoints.length,
              unpinned: _withoutPoint.length,
              contextInfo: _contextInfo,
              onRefresh: _load,
              window: _window,
              onWindowChanged: _setWindow,
              olderHidden: _olderHidden,
            ),
          ),
        ),
        if (_failure != null)
          Align(
            alignment: Alignment.center,
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: SurfaceCard(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text('Peta belum dapat dimuat.',
                      style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 6),
                  Text(_failure!.userMessage, textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                      onPressed: _load,
                      icon: const Icon(Icons.refresh),
                      label: const Text('Coba lagi')),
                ]),
              ),
            ),
          ),
        if (_failure == null)
          _MapSheet(
            selected: selected,
            selectedEvent: selected == null ? null : _eventFor(selected.eventId),
            withoutPoint: _withoutPoint,
            partial: _partial,
            loading: _loading,
            onOpen: _openDetail,
            emptyWindow: _window == RecencyWindow.last24h &&
                !_loading &&
                _visibleEvents.isEmpty,
            olderHidden: _olderHidden,
            onShowAll: () => _setWindow(RecencyWindow.all),
          ),
      ]),
    );
  }
}

class _MapHeader extends StatelessWidget {
  const _MapHeader({
    required this.loading,
    required this.pinned,
    required this.unpinned,
    required this.contextInfo,
    required this.onRefresh,
    required this.window,
    required this.onWindowChanged,
    required this.olderHidden,
  });
  final bool loading;
  final int pinned;
  final int unpinned;
  final PublicContext? contextInfo;
  final VoidCallback onRefresh;
  final RecencyWindow window;
  final ValueChanged<RecencyWindow> onWindowChanged;
  final int olderHidden;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final isDemo = contextInfo?.datasetMode == DatasetMode.demo;
    return Material(
      color: p.surface.withValues(alpha: 0.94),
      elevation: 0,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(WaspadaShape.card),
          side: BorderSide(color: p.line)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 6, 10),
        child: Row(children: [
          Expanded(
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(children: [
                    Flexible(
                      child: Text('Peta laporan',
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleMedium),
                    ),
                    if (isDemo) ...[
                      const SizedBox(width: 8),
                      StatusPill(
                          icon: Icons.science_outlined,
                          label: 'DEMO',
                          color: p.demo),
                    ],
                  ]),
                  const SizedBox(height: 2),
                  Text(
                    loading
                        ? 'Memuat titik laporan…'
                        : '$pinned bertitik · $unpinned tanpa titik lokasi',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 8),
                  RecencySwitch(value: window, onChanged: onWindowChanged),
                  if (window == RecencyWindow.last24h && !loading) ...[
                    const SizedBox(height: 6),
                    RecencyCaption(olderHidden: olderHidden),
                  ],
                ]),
          ),
          IconButton(
              tooltip: 'Muat ulang peta',
              onPressed: loading ? null : onRefresh,
              icon: loading
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.refresh_rounded)),
        ]),
      ),
    );
  }
}

class _Pin extends StatelessWidget {
  const _Pin({
    required this.point,
    required this.severity,
    required this.selected,
    required this.onTap,
  });
  final MapPoint point;
  final IncidentSeverity? severity;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final fill = severity == null ? p.brand : severityColor(context, severity);
    final size = selected ? 30.0 : 22.0;
    return Semantics(
      button: true,
      label:
          '${point.title}${point.approximate ? ', lokasi perkiraan' : ''}',
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Center(
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOutBack,
            width: size,
            height: size,
            decoration: BoxDecoration(
              // An approximate place is a ring, an exact source point is filled.
              color: point.approximate ? p.surface : fill,
              shape: BoxShape.circle,
              border: Border.all(
                  color: point.approximate ? fill : Colors.white,
                  width: point.approximate ? 4 : 3),
              boxShadow: [
                BoxShadow(
                    color: Colors.black.withValues(alpha: 0.28),
                    blurRadius: selected ? 14 : 6,
                    offset: const Offset(0, 2)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _MapSheet extends StatelessWidget {
  const _MapSheet({
    required this.selected,
    required this.selectedEvent,
    required this.withoutPoint,
    required this.partial,
    required this.loading,
    required this.onOpen,
    required this.emptyWindow,
    required this.olderHidden,
    required this.onShowAll,
  });
  final bool emptyWindow;
  final int olderHidden;
  final VoidCallback onShowAll;
  final MapPoint? selected;
  final EventRecord? selectedEvent;
  final List<EventRecord> withoutPoint;
  final bool partial;
  final bool loading;
  final void Function(String eventId) onOpen;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return DraggableScrollableSheet(
      initialChildSize: selected == null ? (emptyWindow ? 0.4 : 0.22) : 0.34,
      minChildSize: 0.12,
      maxChildSize: 0.85,
      snap: true,
      builder: (context, controller) => DecoratedBox(
        decoration: BoxDecoration(
          color: p.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
          boxShadow: [
            BoxShadow(
                color: Colors.black.withValues(alpha: 0.12),
                blurRadius: 24,
                offset: const Offset(0, -4)),
          ],
        ),
        child: ListView(
          controller: controller,
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 28),
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                    color: p.line,
                    borderRadius: BorderRadius.circular(WaspadaShape.pill)),
              ),
            ),
            const SizedBox(height: 14),
            if (selected != null) ...[
              _SelectedPoint(
                  point: selected!,
                  event: selectedEvent,
                  onOpen: () => onOpen(selected!.eventId)),
              const SizedBox(height: 18),
            ],
            if (emptyWindow) ...[
              EmptyRecentNotice(olderHidden: olderHidden, onShowAll: onShowAll),
              const SizedBox(height: 18),
            ],
            const _Legend(),
            const SizedBox(height: 18),
            Text('Tanpa titik lokasi',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
                'Laporan ini berlaku untuk seluruh tampilan peta. Tidak diberi titik karena sumbernya tidak menyebut koordinat.',
                style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 10),
            if (loading)
              const SkeletonCard()
            else if (withoutPoint.isEmpty)
              Text('Semua laporan yang dimuat memiliki titik.',
                  style: Theme.of(context).textTheme.bodyMedium)
            else
              for (final event in withoutPoint)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: SurfaceCard(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 12),
                    onTap: () => onOpen(event.id),
                    child: Row(children: [
                      Text(event.icon, style: const TextStyle(fontSize: 20)),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(event.title,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style:
                                      Theme.of(context).textTheme.titleSmall),
                              const SizedBox(height: 2),
                              Text(
                                  '${event.category.label} · ${event.freshness.status.label}',
                                  style:
                                      Theme.of(context).textTheme.bodySmall),
                            ]),
                      ),
                      Icon(Icons.chevron_right_rounded, color: p.inkMuted),
                    ]),
                  ),
                ),
            if (partial)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                    'Daftar dibatasi beberapa halaman. Buka tab Laporan untuk daftar lengkap.',
                    style: Theme.of(context).textTheme.bodySmall),
              ),
            const SizedBox(height: 16),
            Text('Tidak ada titik bukan berarti wilayah aman.',
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(fontWeight: FontWeight.w700)),
          ],
        ),
      ),
    );
  }
}

class _SelectedPoint extends StatelessWidget {
  const _SelectedPoint(
      {required this.point, required this.event, required this.onOpen});
  final MapPoint point;
  final EventRecord? event;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final severity = event?.severity;
    return SurfaceCard(
      color: p.surfaceAlt,
      onTap: onOpen,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(spacing: 6, runSpacing: 6, children: [
          StatusPill(
              icon: Icons.category_outlined,
              label: point.category.label,
              color: p.surface),
          if (severity != null)
            StatusPill(
                icon: Icons.warning_amber_rounded,
                label: severity.label,
                color: severityColor(context, severity),
                foreground: severityForeground(context, severity)),
          StatusPill(
              icon: point.approximate
                  ? Icons.blur_circular_rounded
                  : Icons.place_rounded,
              label: point.approximate ? 'Lokasi perkiraan' : 'Titik sumber',
              color: p.surface),
        ]),
        const SizedBox(height: 10),
        Text(point.title, style: Theme.of(context).textTheme.titleLarge),
        if (event != null) ...[
          const SizedBox(height: 6),
          Text('Terbit ${relativeWib(event!.publishedAt) ?? formatWib(event!.publishedAt)}',
              style: Theme.of(context).textTheme.bodySmall),
        ],
        const SizedBox(height: 12),
        Row(children: [
          Text('Buka detail',
              style: TextStyle(
                  color: p.brand, fontWeight: FontWeight.w800, fontSize: 14)),
          const SizedBox(width: 4),
          Icon(Icons.arrow_forward_rounded, size: 18, color: p.brand),
        ]),
      ]),
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend();
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    Widget dot(Color color, {bool ring = false}) => Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(
            color: ring ? p.surface : color,
            shape: BoxShape.circle,
            border: Border.all(color: color, width: ring ? 3 : 0),
          ),
        );
    Widget item(Widget mark, String label) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            mark,
            const SizedBox(width: 6),
            Text(label, style: Theme.of(context).textTheme.labelMedium),
          ],
        );
    return Wrap(spacing: 14, runSpacing: 8, children: [
      item(dot(p.signalLow), 'Rendah'),
      item(dot(p.signalMedium), 'Sedang'),
      item(dot(p.signalHigh), 'Tinggi'),
      item(dot(p.signalCritical), 'Kritis'),
      item(dot(p.brand), 'Belum dinilai'),
      item(dot(p.inkMuted, ring: true), 'Lokasi perkiraan'),
    ]);
  }
}
