import 'package:flutter/material.dart';

import 'event_detail_screen.dart';
import 'preferences.dart';
import 'preferences_screen.dart';
import 'public_api.dart';
import 'public_models.dart';
import 'read_guide_screen.dart';
import 'recency.dart';
import 'theme.dart';
import 'ui_helpers.dart';

class EventListScreen extends StatefulWidget {
  const EventListScreen(
      {super.key,
      required this.api,
      required this.preferences,
      this.embedded = false,
      this.clock = DateTime.now});
  final PublicApi api;
  final PreferencesRepository preferences;

  /// The clock for the 24-hour window (tests pass a fixed one).
  final DateTime Function() clock;

  /// True inside the bottom navigation: the screen is a tab, so it shows no back control.
  final bool embedded;
  @override
  State<EventListScreen> createState() => _EventListScreenState();
}

class _EventListScreenState extends State<EventListScreen> {
  PublicContext? _contextInfo;
  ApiFailure? _contextFailure;
  ApiFailure? _pageFailure;
  final _searchController = TextEditingController();
  EventCategory? _category;
  EventLifecycle? _lifecycle;
  FreshnessStatus? _freshness;
  String _appliedSearch = '';
  String? _cursor;
  List<EventRecord> _events = [];
  LocalInterests _interests = const LocalInterests();
  PreferenceLoadStatus _preferenceStatus = PreferenceLoadStatus.empty;
  bool _loadingContext = true;
  bool _loadingPage = false;
  bool _loadingMore = false;
  int _requestGeneration = 0;
  RecencyWindow _window = RecencyWindow.last24h;

  /// MOBILE-RECENT-01: loaded events inside the window. Paging and the server filters are unchanged.
  List<EventRecord> get _visible {
    if (_window == RecencyWindow.all) return _events;
    final now = widget.clock();
    return _events
        .where((event) => publishedRecently(event.publishedAt, now))
        .toList();
  }

  @override
  void initState() {
    super.initState();
    _loadPreferences();
    _refresh();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _loadPreferences() async {
    final result = await widget.preferences.load();
    if (!mounted) return;
    setState(() {
      _interests = result.interests;
      _preferenceStatus = result.status;
    });
  }

  Future<void> _refresh() async {
    final requestGeneration = ++_requestGeneration;
    setState(() {
      _loadingContext = true;
      _contextFailure = null;
      _pageFailure = null;
      _contextInfo = null;
      _events = [];
      _cursor = null;
      _loadingPage = false;
    });
    try {
      final contextInfo = await widget.api.getContext();
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _contextInfo = contextInfo;
        _loadingContext = false;
        _loadingPage = true;
      });
      await _loadPage(reset: true, generation: requestGeneration);
    } on ApiFailure catch (error) {
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _contextFailure = error;
        _loadingContext = false;
      });
    } catch (_) {
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _contextFailure = const ApiFailure(ApiFailureKind.network);
        _loadingContext = false;
      });
    }
  }

  Future<void> _loadPage(
      {required bool reset, String? cursor, int? generation}) async {
    if (_contextInfo == null) return;
    final requestGeneration = generation ?? ++_requestGeneration;
    final query = EventQuery(
      category: _category,
      lifecycle: _lifecycle,
      freshness: _freshness,
      search: _appliedSearch,
      cursor: cursor,
    );
    setState(() {
      _pageFailure = null;
      if (reset) {
        _events = [];
        _cursor = null;
        _loadingPage = true;
      } else {
        _loadingMore = true;
      }
    });
    try {
      final page = await widget.api.listEvents(query);
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _events = reset ? page.data : [..._events, ...page.data];
        _cursor = page.nextCursor;
        _loadingPage = false;
        _loadingMore = false;
      });
    } on ApiFailure catch (error) {
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _pageFailure = error;
        _loadingPage = false;
        _loadingMore = false;
      });
    } catch (_) {
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _pageFailure = const ApiFailure(ApiFailureKind.network);
        _loadingPage = false;
        _loadingMore = false;
      });
    }
  }

  Future<void> _openFilters() async {
    final result = await showModalBottomSheet<_AppliedFilters>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _FilterSheet(
          category: _category,
          lifecycle: _lifecycle,
          freshness: _freshness,
          search: _searchController.text),
    );
    if (result == null || !mounted) return;
    setState(() {
      _category = result.category;
      _lifecycle = result.lifecycle;
      _freshness = result.freshness;
      _appliedSearch = result.search;
      _searchController.text = _appliedSearch;
    });
    await _loadPage(reset: true);
  }

  Future<void> _openPreferences() async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => PreferencesScreen(repository: widget.preferences)));
    await _loadPreferences();
  }

  Future<void> _openDetail(EventRecord event) async {
    final contextInfo = _contextInfo;
    if (contextInfo == null) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => EventDetailScreen(
          api: widget.api,
          contextInfo: contextInfo,
          eventId: event.id,
          initialInterests: _interests,
          preferences: widget.preferences),
    ));
    if (mounted) await _loadPreferences();
  }

  Future<void> _submitSearch() {
    _appliedSearch = _searchController.text.trim();
    return _loadPage(reset: true);
  }

  String get _filterSummary {
    final count = [_category, _lifecycle, _freshness]
            .where((value) => value != null)
            .length +
        (_searchController.text.trim().isEmpty ? 0 : 1);
    return count == 0 ? 'Filter' : 'Filter ($count)';
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: const Text('Laporan publik'),
          automaticallyImplyLeading: false,
          leading: widget.embedded
              ? null
              : IconButton(
                  tooltip: 'Kembali',
                  onPressed: () => Navigator.of(context).maybePop(),
                  icon: const Icon(Icons.arrow_back)),
          actions: [
            IconButton(
                tooltip: 'Buka panduan membaca',
                onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                        builder: (_) => const ReadGuideScreen())),
                icon: const Icon(Icons.help_outline)),
            IconButton(
                tooltip: 'Muat ulang daftar secara manual',
                onPressed: _refresh,
                icon: const Icon(Icons.refresh)),
            IconButton(
                tooltip: 'Atur minat lokal',
                onPressed: _openPreferences,
                icon: const Icon(Icons.tune)),
          ],
        ),
        body: RefreshIndicator(
          onRefresh: _refresh,
          color: context.palette.brand,
          child: ListView(
          padding: const EdgeInsets.only(bottom: 24),
          children: [
            if (_contextInfo != null) ModeNotice(contextInfo: _contextInfo!),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: Column(children: [
                Row(children: [
                  Expanded(
                      child: TextField(
                    controller: _searchController,
                    textInputAction: TextInputAction.search,
                    maxLength: 120,
                    onSubmitted: (_) => _submitSearch(),
                    decoration: const InputDecoration(
                        labelText: 'Cari laporan, tempat, atau layanan',
                        counterText: '',
                        prefixIcon: Icon(Icons.search)),
                  )),
                  const SizedBox(width: 8),
                  IconButton.filled(
                      tooltip: 'Cari',
                      onPressed: _submitSearch,
                      style: IconButton.styleFrom(
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(
                                  WaspadaShape.control))),
                      icon: const Icon(Icons.arrow_forward_rounded),
                      constraints:
                          const BoxConstraints(minWidth: 52, minHeight: 52)),
                ]),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 10,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    ActionChip(
                        onPressed: _openFilters,
                        avatar: const Icon(Icons.tune_rounded, size: 18),
                        label: Text(_filterSummary)),
                    RecencySwitch(
                        value: _window,
                        onChanged: (window) =>
                            setState(() => _window = window)),
                  ],
                ),
              ]),
            ),
            if (_loadingContext)
              const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 16),
                  child: LinearProgressIndicator(minHeight: 3)),
            if (_contextFailure != null)
              Padding(
                  padding: const EdgeInsets.all(16),
                  child: _ErrorState(
                      title: 'Mode dataset belum dapat dipastikan.',
                      message:
                          '${_contextFailure!.userMessage} Daftar laporan disembunyikan sampai mode dikonfirmasi.',
                      onRetry: _refresh)),
            if (_contextInfo != null) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 8),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                          _loadingPage
                              ? 'Memuat daftar publik…'
                              : '${_visible.length} laporan pada halaman ini',
                          style: Theme.of(context).textTheme.titleMedium),
                      if (_window == RecencyWindow.last24h && !_loadingPage) ...[
                        const SizedBox(height: 4),
                        RecencyCaption(
                            olderHidden: _events.length - _visible.length),
                      ],
                      const SizedBox(height: 3),
                      Text(
                          'Konteks dibuat ${formatWib(_contextInfo!.generatedAt)}. Waktu laporan dan terbit sumber ditampilkan terpisah.',
                          style: Theme.of(context).textTheme.bodySmall),
                      if (_contextInfo!.sources.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                            'Sumber: ${_contextInfo!.sources.map((source) => '${source.displayName} (${sourceHealthLabel(source.health)}; terakhir berhasil ${formatWib(source.lastSuccessAt)})').join(' · ')}',
                            style: Theme.of(context).textTheme.bodySmall),
                      ],
                    ]),
              ),
              if (_preferenceStatus == PreferenceLoadStatus.unavailable)
                const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                    child: Text(
                        'Minat tidak dapat dibaca; daftar umum tetap tersedia.',
                        style: TextStyle(fontWeight: FontWeight.w600))),
              if (_preferenceStatus == PreferenceLoadStatus.malformed)
                const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                    child: Text(
                        'Pilihan minat tersimpan tidak dapat dibaca. Kecocokan lokal disembunyikan.',
                        style: TextStyle(fontWeight: FontWeight.w600))),
              if (_pageFailure != null && !_loadingPage)
                Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                    child: _ErrorState(
                        title: 'Daftar belum dapat dimuat.',
                        message: _pageFailure!.userMessage,
                        onRetry: () => _loadPage(reset: true))),
              if (_loadingPage)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 16),
                  child: Column(children: [
                    SkeletonCard(),
                    SizedBox(height: 10),
                    SkeletonCard(),
                    SizedBox(height: 10),
                    SkeletonCard(),
                  ]),
                ),
              if (!_loadingPage &&
                  _events.isEmpty &&
                  _pageFailure == null &&
                  _cursor == null)
                const _EmptyResults(),
              if (!_loadingPage &&
                  _events.isNotEmpty &&
                  _visible.isEmpty &&
                  _pageFailure == null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                  child: EmptyRecentNotice(
                      olderHidden: _events.length,
                      onShowAll: () =>
                          setState(() => _window = RecencyWindow.all)),
                ),
              if (!_loadingPage)
                ..._visible.map((event) => Padding(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                      child: _EventCard(
                          event: event,
                          interests: _interests,
                          preferencesAvailable: _preferenceStatus !=
                                  PreferenceLoadStatus.unavailable &&
                              _preferenceStatus !=
                                  PreferenceLoadStatus.malformed,
                          onTap: () => _openDetail(event)),
                    )),
              if (!_loadingPage && _cursor != null)
                Padding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                    child: _LoadMore(
                        loading: _loadingMore,
                        onPressed: () =>
                            _loadPage(reset: false, cursor: _cursor))),
            ],
          ],
        ),
        ),
      );
}

class _AppliedFilters {
  const _AppliedFilters(
      {required this.category,
      required this.lifecycle,
      required this.freshness,
      required this.search});
  final EventCategory? category;
  final EventLifecycle? lifecycle;
  final FreshnessStatus? freshness;
  final String search;
}

class _FilterSheet extends StatefulWidget {
  const _FilterSheet(
      {required this.category,
      required this.lifecycle,
      required this.freshness,
      required this.search});
  final EventCategory? category;
  final EventLifecycle? lifecycle;
  final FreshnessStatus? freshness;
  final String search;
  @override
  State<_FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<_FilterSheet> {
  late String _category;
  late String _lifecycle;
  late String _freshness;
  late final TextEditingController _search;

  @override
  void initState() {
    super.initState();
    _category = widget.category?.wireValue ?? '';
    _lifecycle = widget.lifecycle?.wireValue ?? '';
    _freshness = widget.freshness?.wireValue ?? '';
    _search = TextEditingController(text: widget.search);
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(
              20, 8, 20, MediaQuery.viewInsetsOf(context).bottom + 20),
          child: ListView(shrinkWrap: true, children: [
            Text('Filter daftar',
                style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 6),
            Text(
                'Pilih kategori, siklus, atau kesegaran. Filter hanya mengubah pencarian daftar publik.',
                style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              initialValue: _category,
              decoration: const InputDecoration(labelText: 'Kategori'),
              items: [
                const DropdownMenuItem(
                    value: '', child: Text('Semua kategori')),
                ...EventCategory.values.map((category) => DropdownMenuItem(
                    value: category.wireValue, child: Text(category.label)))
              ],
              onChanged: (value) => setState(() => _category = value ?? ''),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _lifecycle,
              decoration: const InputDecoration(labelText: 'Siklus kejadian'),
              items: [
                const DropdownMenuItem(
                    value: '', child: Text('Semua status siklus')),
                ...EventLifecycle.values.map((state) => DropdownMenuItem(
                    value: state.wireValue, child: Text(state.label)))
              ],
              onChanged: (value) => setState(() => _lifecycle = value ?? ''),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _freshness,
              decoration:
                  const InputDecoration(labelText: 'Kesegaran informasi'),
              items: [
                const DropdownMenuItem(
                    value: '', child: Text('Semua status kesegaran')),
                ...FreshnessStatus.values.map((status) => DropdownMenuItem(
                    value: status.wireValue, child: Text(status.label)))
              ],
              onChanged: (value) => setState(() => _freshness = value ?? ''),
            ),
            const SizedBox(height: 12),
            TextField(
                controller: _search,
                maxLength: 120,
                decoration: const InputDecoration(
                    labelText: 'Teks pencarian',
                    counterText: 'Maksimal 120 karakter')),
            const SizedBox(height: 14),
            FilledButton(
                onPressed: () => Navigator.pop(
                    context,
                    _AppliedFilters(
                      category: _resolveCategory(_category),
                      lifecycle: _findByWire(EventLifecycle.values, _lifecycle,
                          (item) => item.wireValue),
                      freshness: _findByWire(FreshnessStatus.values, _freshness,
                          (item) => item.wireValue),
                      search: _search.text.trim(),
                    )),
                child: const Text('Terapkan filter')),
            TextButton(
                onPressed: () => setState(() {
                      _category = '';
                      _lifecycle = '';
                      _freshness = '';
                      _search.clear();
                    }),
                child: const Text('Hapus semua filter')),
          ]),
        ),
      );
}

class _EventCard extends StatelessWidget {
  const _EventCard(
      {required this.event,
      required this.interests,
      required this.preferencesAvailable,
      required this.onTap});
  final EventRecord event;
  final LocalInterests interests;
  final bool preferencesAvailable;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final hasMatch = preferencesAvailable && locallyMatches(event, interests);
    final reasons =
        hasMatch ? localMatchReasons(event, interests) : const <String>[];
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    final published = relativeWib(event.publishedAt);
    return SurfaceCard(
      padding: EdgeInsets.zero,
      onTap: onTap,
      child: IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 16, 0, 16),
            child: SeverityRail(severity: event.severity),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 16, 16, 14),
              child:
                  Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  if (event.incidentCategory != null) ...[
                    Text(event.icon, style: const TextStyle(fontSize: 15)),
                    const SizedBox(width: 6),
                  ],
                  Expanded(
                    child: Text(
                      event.category.label.toUpperCase(),
                      style: text.labelSmall?.copyWith(color: p.brand),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (published != null)
                    Text(published, style: text.labelMedium),
                ]),
                const SizedBox(height: 8),
                Text(event.title, style: text.titleLarge),
                const SizedBox(height: 10),
                Wrap(spacing: 6, runSpacing: 6, children: [
                  if (event.severity != null)
                    StatusPill(
                      icon: Icons.warning_amber_rounded,
                      label: 'Keparahan: ${event.severity!.label}',
                      color: severityColor(context, event.severity),
                      foreground: severityForeground(context, event.severity),
                    ),
                  StatusPill(icon: Icons.timeline, label: event.lifecycle.label),
                  StatusPill(
                      icon: Icons.update,
                      label: event.freshness.status.label,
                      color: event.freshness.status == FreshnessStatus.expired
                          ? p.signalLow
                          : null),
                  if (event.locationDisplay == LocationDisplay.wholeView)
                    const StatusPill(
                        icon: Icons.crop_free_rounded,
                        label: 'Tanpa titik lokasi'),
                ]),
                if (event.summary.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Text(event.summary,
                      style: text.bodyMedium,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis),
                ],
                const SizedBox(height: 12),
                Divider(color: p.line),
                const SizedBox(height: 10),
                if (event.locationLabel != null &&
                    event.locationLabel!.isNotEmpty)
                  _MetaLine(
                      icon: Icons.place_outlined,
                      text: 'Lokasi: ${event.locationLabel!}'),
                _MetaLine(
                    icon: Icons.schedule_rounded,
                    text:
                        'Waktu kejadian/observasi: ${formatEventTime(event.eventTime)}'),
                if (event.claims.isNotEmpty)
                  _MetaLine(
                      icon: Icons.fact_check_outlined,
                      text: 'Bukti: ${evidenceCaption(event.claims.first)}'),
                _MetaLine(
                    icon: Icons.publish_rounded,
                    text:
                        'Versi publik diterbitkan: ${formatWib(event.publishedAt)}'),
                if (hasMatch) ...[
                  const SizedBox(height: 8),
                  StatusPill(
                      icon: Icons.tune,
                      label: 'Kecocokan minat lokal: ${reasons.join(' · ')}',
                      color: p.brandSoft,
                      foreground: p.ink),
                  const SizedBox(height: 4),
                  Text(
                      'Kecocokan bukan bukti, tingkat bahaya, atau bukti lokasi fisikmu.',
                      style: text.bodySmall),
                ],
                const SizedBox(height: 4),
                Align(
                    alignment: Alignment.centerRight,
                    child: Icon(Icons.arrow_forward_rounded,
                        color: p.brand, semanticLabel: 'Buka detail laporan')),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

class _MetaLine extends StatelessWidget {
  const _MetaLine({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 5),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(icon, size: 15, color: context.palette.inkMuted),
          ),
          const SizedBox(width: 8),
          Expanded(
              child: Text(text, style: Theme.of(context).textTheme.bodySmall)),
        ]),
      );
}

EventCategory? _resolveCategory(String wire) {
  if (wire.isEmpty) return null;
  for (final item in EventCategory.values) {
    if (item.wireValue == wire) return item;
  }
  return IncidentCategory.tryParse(wire)?.toEventCategory();
}

class _EmptyResults extends StatelessWidget {
  const _EmptyResults();
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
            padding: const EdgeInsets.all(24),
            child: ReadOnlyNotice(
              title: 'Tidak ada laporan yang cocok.',
              message:
                  'Ini bukan pernyataan bahwa kondisi aman. Hapus filter atau coba lagi nanti.',
              icon: Icons.inbox_outlined,
            )),
      );
}

class _ErrorState extends StatelessWidget {
  const _ErrorState(
      {required this.title, required this.message, required this.onRetry});
  final String title;
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Center(
      child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                Text(message, style: Theme.of(context).textTheme.bodyLarge),
                const SizedBox(height: 12),
                FilledButton.icon(
                    onPressed: onRetry,
                    icon: const Icon(Icons.refresh),
                    label: const Text('Coba lagi')),
              ])));
}

class _LoadMore extends StatelessWidget {
  const _LoadMore({required this.loading, required this.onPressed});
  final bool loading;
  final VoidCallback onPressed;
  @override
  Widget build(BuildContext context) => Column(children: [
        const Text(
            'Halaman dibatasi. Muat berikutnya hanya setelah kamu memilihnya.',
            textAlign: TextAlign.center),
        const SizedBox(height: 8),
        OutlinedButton.icon(
            onPressed: loading ? null : onPressed,
            icon: loading
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.expand_more),
            label: Text(loading ? 'Memuat…' : 'Muat lainnya')),
      ]);
}

T? _findByWire<T>(
    Iterable<T> values, String wireValue, String Function(T) readWireValue) {
  for (final value in values) {
    if (readWireValue(value) == wireValue) return value;
  }
  return null;
}
