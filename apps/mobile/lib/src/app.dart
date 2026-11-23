import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'city_illustration.dart';
import 'event_detail_screen.dart';
import 'event_list_screen.dart';
import 'map_screen.dart';
import 'preferences.dart';
import 'preferences_screen.dart';
import 'public_api.dart';
import 'public_models.dart';
import 'read_guide_screen.dart';
import 'theme.dart';
import 'ui_helpers.dart';

class WaspadaApp extends StatelessWidget {
  const WaspadaApp({
    super.key,
    required this.api,
    required this.preferences,
    this.showMapTiles = true,
    this.clock = DateTime.now,
  });

  final PublicApi api;
  final PreferencesRepository preferences;

  /// Tests turn map tiles off so no network request is made.
  final bool showMapTiles;

  /// The clock for the 24-hour window on the map and list (tests pass a fixed one).
  final DateTime Function() clock;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Waspada Jakarta',
        debugShowCheckedModeBanner: false,
        theme: buildWaspadaTheme(),
        darkTheme: buildWaspadaTheme(brightness: Brightness.dark),
        themeMode: ThemeMode.system,
        locale: const Locale('id'),
        supportedLocales: const [Locale('id'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: HomeShell(
            api: api,
            preferences: preferences,
            showMapTiles: showMapTiles,
            clock: clock),
      );
}

/// MOBILE-V2: the four main destinations. Tabs are built the first time they are opened and then kept alive, so
/// switching back keeps the scroll position and does not refetch.
class HomeShell extends StatefulWidget {
  const HomeShell({
    super.key,
    required this.api,
    required this.preferences,
    this.showMapTiles = true,
    this.clock = DateTime.now,
  });
  final PublicApi api;
  final PreferencesRepository preferences;
  final bool showMapTiles;
  final DateTime Function() clock;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;
  final _visited = <int>{0};

  void _select(int index) => setState(() {
        _index = index;
        _visited.add(index);
      });

  Widget _tab(int index) => switch (index) {
        0 => LandingScreen(
            api: widget.api,
            preferences: widget.preferences,
            onOpenMap: () => _select(1),
            onOpenList: () => _select(2),
            onOpenPreferences: () => _select(3),
          ),
        1 => MapScreen(
            api: widget.api,
            preferences: widget.preferences,
            showTiles: widget.showMapTiles,
            clock: widget.clock),
        2 => EventListScreen(
            api: widget.api,
            preferences: widget.preferences,
            embedded: true,
            clock: widget.clock),
        _ => PreferencesScreen(repository: widget.preferences, embedded: true),
      };

  @override
  Widget build(BuildContext context) => Scaffold(
        body: IndexedStack(
          index: _index,
          children: [
            for (var i = 0; i < 4; i++)
              _visited.contains(i) ? _tab(i) : const SizedBox.shrink(),
          ],
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: _select,
          labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
          destinations: const [
            NavigationDestination(
                icon: Icon(Icons.home_outlined),
                selectedIcon: Icon(Icons.home_rounded),
                label: 'Beranda'),
            NavigationDestination(
                icon: Icon(Icons.map_outlined),
                selectedIcon: Icon(Icons.map_rounded),
                label: 'Peta'),
            NavigationDestination(
                icon: Icon(Icons.view_agenda_outlined),
                selectedIcon: Icon(Icons.view_agenda_rounded),
                label: 'Laporan'),
            NavigationDestination(
                icon: Icon(Icons.tune_outlined),
                selectedIcon: Icon(Icons.tune_rounded),
                label: 'Minat'),
          ],
        ),
      );
}

class LandingScreen extends StatefulWidget {
  const LandingScreen({
    super.key,
    required this.api,
    required this.preferences,
    this.onOpenMap,
    this.onOpenList,
    this.onOpenPreferences,
  });
  final PublicApi api;
  final PreferencesRepository preferences;

  /// When the landing sits in [HomeShell] these switch tabs; on its own it pushes the screens instead.
  final VoidCallback? onOpenMap;
  final VoidCallback? onOpenList;
  final VoidCallback? onOpenPreferences;

  @override
  State<LandingScreen> createState() => _LandingScreenState();
}

class _LandingScreenState extends State<LandingScreen> {
  PublicContext? _contextInfo;
  EventPage? _preview;
  ApiFailure? _contextFailure;
  ApiFailure? _previewFailure;
  bool _loadingContext = true;
  bool _loadingPreview = false;
  int _readingPanel = 0;
  int _requestGeneration = 0;

  @override
  void initState() {
    super.initState();
    _loadContextAndPreview();
  }

  Future<void> _loadContextAndPreview() async {
    final requestGeneration = ++_requestGeneration;
    if (mounted) {
      setState(() {
        _loadingContext = true;
        _contextFailure = null;
        _previewFailure = null;
        _preview = null;
      });
    }
    try {
      final contextInfo = await widget.api.getContext();
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _contextInfo = contextInfo;
        _loadingContext = false;
        _loadingPreview = true;
      });
    } on ApiFailure catch (error) {
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _contextInfo = null;
        _contextFailure = error;
        _loadingContext = false;
        _loadingPreview = false;
      });
      return;
    } catch (_) {
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _contextInfo = null;
        _contextFailure = const ApiFailure(ApiFailureKind.network);
        _loadingContext = false;
        _loadingPreview = false;
      });
      return;
    }

    try {
      final preview = await widget.api.listEvents(const EventQuery());
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _preview = preview;
        _loadingPreview = false;
      });
    } on ApiFailure catch (error) {
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _previewFailure = error;
        _loadingPreview = false;
      });
    } catch (_) {
      if (!mounted || requestGeneration != _requestGeneration) return;
      setState(() {
        _previewFailure = const ApiFailure(ApiFailureKind.network);
        _loadingPreview = false;
      });
    }
  }

  void _openDiscovery() {
    final onOpenList = widget.onOpenList;
    if (onOpenList != null) return onOpenList();
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) =>
          EventListScreen(api: widget.api, preferences: widget.preferences),
    ));
  }

  void _openMap() {
    final onOpenMap = widget.onOpenMap;
    if (onOpenMap != null) return onOpenMap();
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => MapScreen(api: widget.api, preferences: widget.preferences),
    ));
  }

  Future<void> _openEventPreview(EventRecord event) async {
    final contextInfo = _contextInfo;
    if (contextInfo == null) return;
    final saved = await widget.preferences.load();
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => EventDetailScreen(
        api: widget.api,
        contextInfo: contextInfo,
        eventId: event.id,
        initialInterests: saved.interests,
        preferences: widget.preferences,
      ),
    ));
  }

  void _openPreferences() {
    final onOpenPreferences = widget.onOpenPreferences;
    if (onOpenPreferences != null) return onOpenPreferences();
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => PreferencesScreen(repository: widget.preferences),
    ));
  }

  void _openGuide() {
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => const ReadGuideScreen()));
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    final previewEvents = _preview?.data ?? const <EventRecord>[];
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: _loadContextAndPreview,
        color: p.brand,
        child: CustomScrollView(slivers: [
          SliverAppBar(
            pinned: true,
            backgroundColor: p.canvas,
            titleSpacing: 20,
            title: Row(children: [
              const _BrandMark(),
              const SizedBox(width: 10),
              Flexible(
                child: Text('Waspada Jakarta',
                    overflow: TextOverflow.ellipsis, style: text.titleMedium),
              ),
            ]),
            actions: [
              IconButton(
                  tooltip: 'Muat ulang konteks dan ringkasan',
                  onPressed: _loadContextAndPreview,
                  icon: const Icon(Icons.refresh_rounded)),
              IconButton(
                  tooltip: 'Panduan membaca',
                  onPressed: _openGuide,
                  icon: const Icon(Icons.menu_book_outlined)),
              const SizedBox(width: 6),
            ],
          ),
          // The landing is short, so it is built eagerly: every notice (demo label, empty result) exists at once.
          SliverToBoxAdapter(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
            if (_contextInfo != null) ModeNotice(contextInfo: _contextInfo!),
            if (_loadingContext) const _ContextLoading(),
            if (_contextFailure != null)
              _UnavailableContext(
                  failure: _contextFailure!, onRetry: _loadContextAndPreview),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
              child: _Hero(onExplore: _openDiscovery, onMap: _openMap),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: IntrinsicHeight(
                  child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                Expanded(
                  child: _StatTile(
                    value: _preview == null
                        ? '—'
                        : '${previewEvents.length}${_preview!.nextCursor != null ? '+' : ''}',
                    label: 'laporan terbit',
                    icon: Icons.article_outlined,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: _StatTile(
                    value: _contextInfo == null
                        ? '—'
                        : '${_contextInfo!.sources.where((s) => s.health == SourceHealth.healthy).length}/${_contextInfo!.sources.length}',
                    label: 'sumber merespons',
                    icon: Icons.sensors_rounded,
                  ),
                ),
              ])),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 30, 20, 0),
              child: Wrap(
                alignment: WrapAlignment.spaceBetween,
                crossAxisAlignment: WrapCrossAlignment.end,
                spacing: 8,
                children: [
                  sectionTitle('Ringkasan laporan',
                      kicker: 'Dari daftar publik'),
                  if (_contextInfo != null && previewEvents.isNotEmpty)
                    TextButton(
                        onPressed: _openDiscovery,
                        child: const Text('Lihat daftar lengkap')),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
              child: Text(
                  _contextInfo == null
                      ? 'Pratinjau disembunyikan sampai mode dataset dapat dipastikan.'
                      : 'Diperbarui ${formatWib(_contextInfo!.generatedAt)}.',
                  style: text.bodySmall),
            ),
            if (_loadingPreview)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Column(children: [
                  Semantics(
                      label: 'Memuat ringkasan halaman pertama…',
                      child: SkeletonCard()),
                  SizedBox(height: 10),
                  SkeletonCard(),
                ]),
              ),
            if (_previewFailure != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: _RetryPanel(
                    title: 'Pratinjau belum dapat dimuat.',
                    message: _previewFailure!.userMessage,
                    onRetry: _loadContextAndPreview),
              ),
            if (_contextInfo != null && _preview != null && previewEvents.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 16),
                child: ReadOnlyNotice(
                    title: 'Tidak ada laporan pada halaman ini.',
                    message:
                        'Laporan yang kosong bukan pernyataan bahwa kondisi aman.',
                    icon: Icons.inbox_outlined),
              ),
            for (final (i, event) in previewEvents.take(3).indexed)
              _StaggeredIn(
                index: i,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                  child: _PreviewTile(
                      event: event, onTap: () => _openEventPreview(event)),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 26, 20, 0),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    sectionTitle('Cara membaca informasi',
                        kicker: 'Kenali konteks'),
                    const SizedBox(height: 14),
                    SizedBox(
                      width: double.infinity,
                      child: SegmentedButton<int>(
                        showSelectedIcon: false,
                        segments: const [
                          ButtonSegment(value: 0, label: Text('Laporan')),
                          ButtonSegment(value: 1, label: Text('Bukti')),
                          ButtonSegment(value: 2, label: Text('Konteks')),
                        ],
                        selected: {_readingPanel},
                        onSelectionChanged: (value) =>
                            setState(() => _readingPanel = value.first),
                      ),
                    ),
                    const SizedBox(height: 12),
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 220),
                      child: ReadOnlyNotice(
                        key: ValueKey(_readingPanel),
                        title: const ['Laporan', 'Bukti', 'Konteks'][_readingPanel],
                        message: const [
                          'Lihat kategori, status kejadian, cakupan, dan waktu yang dijelaskan pada setiap laporan.',
                          'Baca siapa atau sumber apa yang mendukung setiap klaim. Label bukti tidak berarti verifikasi model.',
                          'Kesegaran informasi, validitas sumber, dan waktu terbit memiliki arti yang berbeda.',
                        ][_readingPanel],
                        icon: const [
                          Icons.article_outlined,
                          Icons.fact_check_outlined,
                          Icons.schedule_outlined
                        ][_readingPanel],
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text('Contoh cara membaca — bukan laporan aktual.',
                        style: text.bodySmall),
                  ]),
            ),
            if (_contextInfo != null && _contextInfo!.sources.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 26, 16, 0),
                child: SurfaceCard(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Kicker('Ketersediaan sumber'),
                        const SizedBox(height: 10),
                        for (final source in _contextInfo!.sources)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 6),
                            child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Padding(
                                    padding: const EdgeInsets.only(top: 5),
                                    child: _HealthDot(health: source.health),
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                        '${source.displayName} — ${sourceHealthLabel(source.health)} · terakhir berhasil ${formatWib(source.lastSuccessAt)}',
                                        style: text.bodyMedium),
                                  ),
                                ]),
                          ),
                      ]),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 26, 16, 0),
              child: Column(children: [
                const CityIllustration(),
                Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text('Ilustrasi Jakarta — bukan peta kejadian',
                        textAlign: TextAlign.center, style: text.bodySmall)),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 22, 20, 32),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Tidak ada laporan bukan berarti wilayah aman.',
                        style: text.titleMedium),
                    const SizedBox(height: 8),
                    Text(
                        'Minat disimpan hanya di perangkat ini. Saat mengambil informasi, layanan menerima permintaan jaringan biasa; minat tidak dikirim otomatis.',
                        style: text.bodyMedium),
                    const SizedBox(height: 8),
                    Wrap(spacing: 4, runSpacing: 4, children: [
                      TextButton(
                          onPressed: _openGuide,
                          child: const Text('Panduan membaca')),
                      TextButton(
                          onPressed: _openPreferences,
                          child: const Text('Privasi dan minat')),
                    ]),
                  ]),
            ),
          ])),
        ]),
      ),
    );
  }
}

class _BrandMark extends StatelessWidget {
  const _BrandMark();
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Container(
      width: 28,
      height: 28,
      decoration: BoxDecoration(
        gradient: LinearGradient(
            colors: [p.brand, p.heroEnd],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight),
        borderRadius: BorderRadius.circular(9),
      ),
      child: Icon(Icons.radar_rounded, size: 17, color: p.onBrand),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.onExplore, required this.onMap});
  final VoidCallback onExplore;
  final VoidCallback onMap;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    const onHero = Colors.white;
    return Container(
      padding: const EdgeInsets.fromLTRB(22, 24, 22, 22),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(28),
        gradient: LinearGradient(
          colors: [p.heroStart, p.heroEnd],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: onHero.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(WaspadaShape.pill),
          ),
          child: const Text('INFORMASI PUBLIK JAKARTA',
              style: TextStyle(
                  color: onHero,
                  fontSize: 11,
                  letterSpacing: 1.3,
                  fontWeight: FontWeight.w800)),
        ),
        const SizedBox(height: 16),
        Semantics(
          header: true,
          child: Text('Pahami Jakarta\nsebelum melangkah.',
              style: Theme.of(context)
                  .textTheme
                  .displaySmall
                  ?.copyWith(color: onHero)),
        ),
        const SizedBox(height: 12),
        Text(
            'Baca laporan, waktu kejadian, dan bukti untuk memahami dampaknya pada aktivitasmu.',
            style: Theme.of(context)
                .textTheme
                .bodyLarge
                ?.copyWith(color: onHero.withValues(alpha: 0.86))),
        const SizedBox(height: 6),
        Text(
            'Layanan ini menyajikan informasi publik. Bukan layanan darurat atau jaminan rute aman.',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: onHero.withValues(alpha: 0.7))),
        const SizedBox(height: 20),
        Wrap(spacing: 10, runSpacing: 10, children: [
          FilledButton.icon(
              style: FilledButton.styleFrom(
                  backgroundColor: onHero, foregroundColor: p.heroStart),
              onPressed: onExplore,
              icon: const Icon(Icons.view_agenda_rounded),
              label: const Text('Jelajahi laporan')),
          OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                  foregroundColor: onHero,
                  side: BorderSide(color: onHero.withValues(alpha: 0.4))),
              onPressed: onMap,
              icon: const Icon(Icons.map_outlined),
              label: const Text('Lihat peta')),
        ]),
      ]),
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile(
      {required this.value, required this.label, required this.icon});
  final String value;
  final String label;
  final IconData icon;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Row(children: [
        Icon(icon, size: 20, color: p.brand),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(value,
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    fontFeatures: const [FontFeature.tabularFigures()])),
            Text(label,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall),
          ]),
        ),
      ]),
    );
  }
}

class _HealthDot extends StatelessWidget {
  const _HealthDot({required this.health});
  final SourceHealth health;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final color = switch (health) {
      SourceHealth.healthy => p.brand,
      SourceHealth.degraded => p.signalMedium,
      SourceHealth.unavailable => p.signalCritical,
      SourceHealth.unknown => p.inkMuted,
    };
    return Container(
        width: 9,
        height: 9,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle));
  }
}

/// Fades and lifts a child in, delayed by its index. Respects reduced motion.
class _StaggeredIn extends StatelessWidget {
  const _StaggeredIn({required this.index, required this.child});
  final int index;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) return child;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: Duration(milliseconds: 320 + index * 90),
      curve: Curves.easeOutCubic,
      builder: (context, t, child) => Opacity(
        opacity: t,
        child: Transform.translate(offset: Offset(0, (1 - t) * 14), child: child),
      ),
      child: child,
    );
  }
}

class _ContextLoading extends StatelessWidget {
  const _ContextLoading();
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
        child: Semantics(
            liveRegion: true,
            child: ClipRRect(
                borderRadius: BorderRadius.all(Radius.circular(4)),
                child: LinearProgressIndicator(minHeight: 3))),
      );
}

class _UnavailableContext extends StatelessWidget {
  const _UnavailableContext({required this.failure, required this.onRetry});
  final ApiFailure failure;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        child: _RetryPanel(
            title: 'Mode dataset belum tersedia.',
            message:
                '${failure.userMessage} Pratinjau laporan tetap disembunyikan.',
            onRetry: onRetry),
      );
}

class _RetryPanel extends StatelessWidget {
  const _RetryPanel(
      {required this.title, required this.message, required this.onRetry});
  final String title;
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => SurfaceCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(Icons.cloud_off_rounded,
                color: context.palette.signalHigh, size: 20),
            const SizedBox(width: 8),
            Expanded(
                child:
                    Text(title, style: Theme.of(context).textTheme.titleMedium)),
          ]),
          const SizedBox(height: 6),
          Text(message),
          const SizedBox(height: 12),
          OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('Coba lagi')),
        ]),
      );
}

class _PreviewTile extends StatelessWidget {
  const _PreviewTile({required this.event, required this.onTap});
  final EventRecord event;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final published = relativeWib(event.publishedAt);
    return SurfaceCard(
      padding: EdgeInsets.zero,
      onTap: onTap,
      child: IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 14, 0, 14),
            child: SeverityRail(severity: event.severity),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 14, 16, 14),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Text(event.icon, style: const TextStyle(fontSize: 14)),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(event.category.label.toUpperCase(),
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context)
                                .textTheme
                                .labelSmall
                                ?.copyWith(color: p.brand)),
                      ),
                      if (published != null)
                        Text(published,
                            style: Theme.of(context).textTheme.labelMedium),
                    ]),
                    const SizedBox(height: 6),
                    Text(event.title,
                        style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 8),
                    Wrap(spacing: 6, runSpacing: 6, children: [
                      if (event.severity != null)
                        StatusPill(
                          icon: Icons.warning_amber_rounded,
                          label: event.severity!.label,
                          color: severityColor(context, event.severity),
                          foreground:
                              severityForeground(context, event.severity),
                        ),
                      StatusPill(
                          icon: Icons.schedule, label: event.lifecycle.label),
                      StatusPill(
                          icon: Icons.update,
                          label: event.freshness.status.label),
                    ]),
                    const SizedBox(height: 8),
                    Text(
                        'Waktu kejadian/observasi: ${formatEventTime(event.eventTime)}',
                        style: Theme.of(context).textTheme.bodySmall),
                    Text('Terbit ${formatWib(event.publishedAt)}',
                        style: Theme.of(context).textTheme.bodySmall),
                  ]),
            ),
          ),
        ]),
      ),
    );
  }
}
