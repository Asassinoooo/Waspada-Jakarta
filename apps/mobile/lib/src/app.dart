import 'package:flutter/material.dart';

import 'city_illustration.dart';
import 'event_detail_screen.dart';
import 'event_list_screen.dart';
import 'preferences.dart';
import 'preferences_screen.dart';
import 'public_api.dart';
import 'public_models.dart';
import 'read_guide_screen.dart';
import 'theme.dart';
import 'ui_helpers.dart';

class WaspadaApp extends StatelessWidget {
  const WaspadaApp({super.key, required this.api, required this.preferences});
  final PublicApi api;
  final PreferencesRepository preferences;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Waspada Jakarta',
        debugShowCheckedModeBanner: false,
        theme: buildWaspadaTheme(),
        home: LandingScreen(api: api, preferences: preferences),
      );
}

class LandingScreen extends StatefulWidget {
  const LandingScreen(
      {super.key, required this.api, required this.preferences});
  final PublicApi api;
  final PreferencesRepository preferences;

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
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) =>
          EventListScreen(api: widget.api, preferences: widget.preferences),
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
    return Scaffold(
      appBar: AppBar(
        title: const Text('Waspada Jakarta'),
        actions: [
          IconButton(
              tooltip: 'Muat ulang konteks dan ringkasan',
              onPressed: _loadContextAndPreview,
              icon: const Icon(Icons.refresh)),
          IconButton(
              tooltip: 'Panduan membaca',
              onPressed: _openGuide,
              icon: const Icon(Icons.help_outline)),
          const SizedBox(width: 4),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.only(bottom: 36),
        child:
            Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (_contextInfo != null) ModeNotice(contextInfo: _contextInfo!),
          if (_loadingContext) const _ContextLoading(),
          if (_contextFailure != null)
            _UnavailableContext(
                failure: _contextFailure!, onRetry: _loadContextAndPreview),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 26, 20, 8),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('INFORMASI PUBLIK JAKARTA',
                  style: TextStyle(
                      fontSize: 12,
                      letterSpacing: 1.1,
                      fontWeight: FontWeight.w800,
                      color: WaspadaColors.teal)),
              const SizedBox(height: 12),
              Semantics(
                header: true,
                child: Text('Pahami Jakarta\nsebelum melangkah.',
                    style: Theme.of(context).textTheme.displaySmall),
              ),
              const SizedBox(height: 14),
              Text(
                  'Baca laporan, waktu kejadian, dan bukti untuk memahami dampaknya pada aktivitasmu.',
                  style: Theme.of(context).textTheme.bodyLarge),
              const SizedBox(height: 9),
              Text(
                  'Layanan ini menyajikan informasi publik. Bukan layanan darurat atau jaminan rute aman.',
                  style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: 22),
              SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                      onPressed: _openDiscovery,
                      icon: const Icon(Icons.list_alt),
                      label: const Text('Jelajahi laporan'))),
              const SizedBox(height: 4),
              SizedBox(
                  width: double.infinity,
                  child: TextButton.icon(
                      onPressed: _openPreferences,
                      icon: const Icon(Icons.tune),
                      label: const Text('Atur minat (opsional)'))),
              const SizedBox(height: 8),
              const CityIllustration(),
              const Center(
                  child: Padding(
                      padding: EdgeInsets.only(top: 8),
                      child: Text('Ilustrasi Jakarta — bukan peta kejadian',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                              fontSize: 13, color: WaspadaColors.ink)))),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 30, 20, 0),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              sectionTitle('Cara membaca informasi', kicker: 'Kenali konteks'),
              const SizedBox(height: 14),
              Wrap(spacing: 8, runSpacing: 8, children: [
                _ReadingChoice(
                    label: 'Laporan',
                    selected: _readingPanel == 0,
                    onTap: () => setState(() => _readingPanel = 0)),
                _ReadingChoice(
                    label: 'Bukti',
                    selected: _readingPanel == 1,
                    onTap: () => setState(() => _readingPanel = 1)),
                _ReadingChoice(
                    label: 'Konteks',
                    selected: _readingPanel == 2,
                    onTap: () => setState(() => _readingPanel = 2)),
              ]),
              const SizedBox(height: 12),
              ReadOnlyNotice(
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
              const SizedBox(height: 10),
              const Text('Contoh cara membaca — bukan laporan aktual.',
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: WaspadaColors.ink)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 30, 20, 0),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              sectionTitle('Ringkasan laporan', kicker: 'Dari daftar publik'),
              const SizedBox(height: 5),
              Text(
                  _contextInfo == null
                      ? 'Pratinjau disembunyikan sampai mode dataset dapat dipastikan.'
                      : 'Respons konteks dibuat ${formatWib(_contextInfo!.generatedAt)}.',
                  style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: 12),
              if (_loadingPreview) const _PreviewLoading(),
              if (_previewFailure != null)
                _RetryPanel(
                    title: 'Pratinjau belum dapat dimuat.',
                    message: _previewFailure!.userMessage,
                    onRetry: _loadContextAndPreview),
              if (_contextInfo !=
                      null &&
                  _preview != null &&
                  _preview!.data.isEmpty)
                const ReadOnlyNotice(
                    title: 'Tidak ada laporan pada halaman ini.',
                    message:
                        'Laporan yang kosong bukan pernyataan bahwa kondisi aman.',
                    icon: Icons.inbox_outlined),
              if (_preview != null)
                ..._preview!.data.take(3).map((event) => Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: _PreviewTile(
                          event: event, onTap: () => _openEventPreview(event)),
                    )),
              if (_contextInfo != null &&
                  _preview != null &&
                  _preview!.data.isNotEmpty)
                Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                        onPressed: _openDiscovery,
                        icon: const Icon(Icons.arrow_forward),
                        label: const Text('Lihat daftar lengkap'))),
              if (_contextInfo != null && _contextInfo!.sources.isNotEmpty) ...[
                const SizedBox(height: 10),
                sectionTitle('Ketersediaan sumber'),
                const SizedBox(height: 8),
                ..._contextInfo!.sources.map((source) => Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                          '${source.displayName} — ${sourceHealthLabel(source.health)} · terakhir berhasil ${formatWib(source.lastSuccessAt)}',
                          style: Theme.of(context).textTheme.bodyMedium),
                    )),
              ],
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 28, 20, 0),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Divider(height: 1),
              const SizedBox(height: 16),
              Text('Tidak ada laporan bukan berarti wilayah aman.',
                  style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              Text(
                  'Minat disimpan hanya di perangkat ini. Saat mengambil informasi, layanan menerima permintaan jaringan biasa; minat tidak dikirim otomatis.',
                  style: Theme.of(context).textTheme.bodyMedium),
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
        ]),
      ),
    );
  }
}

class _ContextLoading extends StatelessWidget {
  const _ContextLoading();
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
        child: Semantics(
            liveRegion: true, child: LinearProgressIndicator(minHeight: 3)),
      );
}

class _UnavailableContext extends StatelessWidget {
  const _UnavailableContext({required this.failure, required this.onRetry});
  final ApiFailure failure;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
        child: _RetryPanel(
            title: 'Mode dataset belum tersedia.',
            message:
                '${failure.userMessage} Pratinjau laporan tetap disembunyikan.',
            onRetry: onRetry),
      );
}

class _PreviewLoading extends StatelessWidget {
  const _PreviewLoading();
  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsets.symmetric(vertical: 16),
        child: Row(children: [
          SizedBox.square(
              dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)),
          SizedBox(width: 12),
          Text('Memuat ringkasan halaman pertama…')
        ]),
      );
}

class _RetryPanel extends StatelessWidget {
  const _RetryPanel(
      {required this.title, required this.message, required this.onRetry});
  final String title;
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
            color: WaspadaColors.white,
            border: Border.all(color: WaspadaColors.concrete),
            borderRadius: BorderRadius.circular(10)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 5),
          Text(message),
          const SizedBox(height: 8),
          OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('Coba lagi')),
        ]),
      );
}

class _ReadingChoice extends StatelessWidget {
  const _ReadingChoice(
      {required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        selected: selected,
        child: selected
            ? FilledButton(onPressed: onTap, child: Text(label))
            : OutlinedButton(onPressed: onTap, child: Text(label)),
      );
}

class _PreviewTile extends StatelessWidget {
  const _PreviewTile({required this.event, required this.onTap});
  final EventRecord event;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(15),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(event.title, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 6),
              Wrap(spacing: 8, runSpacing: 6, children: [
                StatusPill(
                    icon: Icons.category_outlined, label: event.category.label),
                StatusPill(icon: Icons.schedule, label: event.lifecycle.label),
                StatusPill(
                    icon: Icons.update, label: event.freshness.status.label),
              ]),
              const SizedBox(height: 8),
              Text(
                  'Waktu kejadian/observasi: ${formatEventTime(event.eventTime)}',
                  style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: 2),
              Text('Terbit ${formatWib(event.publishedAt)}',
                  style: Theme.of(context).textTheme.bodyMedium),
            ]),
          ),
        ),
      );
}
