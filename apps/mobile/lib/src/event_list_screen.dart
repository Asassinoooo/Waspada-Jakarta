import 'package:flutter/material.dart';

import 'event_detail_screen.dart';
import 'preferences.dart';
import 'preferences_screen.dart';
import 'public_api.dart';
import 'public_models.dart';
import 'read_guide_screen.dart';
import 'theme.dart';
import 'ui_helpers.dart';

class EventListScreen extends StatefulWidget {
  const EventListScreen(
      {super.key, required this.api, required this.preferences});
  final PublicApi api;
  final PreferencesRepository preferences;
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
          title: const Text('Jelajahi laporan'),
          leading: IconButton(
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
        body: ListView(
          padding: const EdgeInsets.only(bottom: 20),
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
                  IconButton.filledTonal(
                      tooltip: 'Cari',
                      onPressed: _submitSearch,
                      icon: const Icon(Icons.arrow_forward),
                      constraints:
                          const BoxConstraints(minWidth: 48, minHeight: 48)),
                ]),
                const SizedBox(height: 8),
                Row(children: [
                  Expanded(
                      child: OutlinedButton.icon(
                          onPressed: _openFilters,
                          icon: const Icon(Icons.filter_list),
                          label: Text(_filterSummary))),
                ]),
              ]),
            ),
            if (_loadingContext) const LinearProgressIndicator(minHeight: 3),
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
                              : '${_events.length} laporan pada halaman ini',
                          style: Theme.of(context).textTheme.titleMedium),
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
                const SizedBox(
                    height: 220,
                    child: Center(child: CircularProgressIndicator())),
              if (!_loadingPage &&
                  _events.isEmpty &&
                  _pageFailure == null &&
                  _cursor == null)
                const _EmptyResults(),
              if (!_loadingPage)
                ..._events.map((event) => Padding(
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
                      category: _findByWire(EventCategory.values, _category,
                          (item) => item.wireValue),
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
    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
            padding: const EdgeInsets.all(16),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(event.title, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              Text(event.category.label,
                  style: const TextStyle(
                      fontWeight: FontWeight.w600, color: WaspadaColors.teal)),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 7, children: [
                StatusPill(icon: Icons.timeline, label: event.lifecycle.label),
                StatusPill(
                    icon: Icons.update,
                    label: event.freshness.status.label,
                    color: event.freshness.status == FreshnessStatus.expired
                        ? WaspadaColors.caution
                        : WaspadaColors.softPanel),
              ]),
              if (event.summary.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(event.summary,
                    style: Theme.of(context).textTheme.bodyMedium,
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis),
              ],
              const SizedBox(height: 10),
              Text(
                  'Waktu kejadian/observasi: ${formatEventTime(event.eventTime)}',
                  style: Theme.of(context).textTheme.bodyMedium),
              if (event.claims.isNotEmpty) ...[
                const SizedBox(height: 3),
                Text('Bukti: ${evidenceCaption(event.claims.first)}',
                    style: Theme.of(context).textTheme.bodyMedium),
              ],
              const SizedBox(height: 3),
              Text('Versi publik diterbitkan: ${formatWib(event.publishedAt)}',
                  style: Theme.of(context).textTheme.bodyMedium),
              if (hasMatch) ...[
                const SizedBox(height: 10),
                StatusPill(
                    icon: Icons.tune,
                    label: 'Kecocokan minat lokal: ${reasons.join(' · ')}',
                    color: WaspadaColors.softPanel),
                const SizedBox(height: 4),
                const Text(
                    'Kecocokan bukan bukti, tingkat bahaya, atau bukti lokasi fisikmu.',
                    style: TextStyle(fontSize: 13, height: 1.4)),
              ],
              const SizedBox(height: 8),
              const Align(
                  alignment: Alignment.centerRight,
                  child: Icon(Icons.arrow_forward,
                      color: WaspadaColors.teal,
                      semanticLabel: 'Buka detail laporan')),
            ])),
      ),
    );
  }
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
