import 'package:flutter/material.dart';

import 'preferences.dart';
import 'preferences_screen.dart';
import 'public_api.dart';
import 'public_models.dart';
import 'read_guide_screen.dart';
import 'theme.dart';
import 'ui_helpers.dart';

class EventDetailScreen extends StatefulWidget {
  const EventDetailScreen({
    super.key,
    required this.api,
    required this.contextInfo,
    required this.eventId,
    required this.initialInterests,
    required this.preferences,
  });
  final PublicApi api;
  final PublicContext contextInfo;
  final String eventId;
  final LocalInterests initialInterests;
  final PreferencesRepository preferences;

  @override
  State<EventDetailScreen> createState() => _EventDetailScreenState();
}

class _EventDetailScreenState extends State<EventDetailScreen> {
  EventDetail? _detail;
  HistoryPage? _history;
  ApiFailure? _detailFailure;
  ApiFailure? _historyFailure;
  LocalInterests _interests = const LocalInterests();
  bool _loadingDetail = true;
  bool _loadingHistory = true;
  bool _loadingMoreHistory = false;
  String? _historyCursor;
  int _detailGeneration = 0;
  int _historyGeneration = 0;

  @override
  void initState() {
    super.initState();
    _interests = widget.initialInterests;
    _loadDetail();
    _loadHistory(reset: true);
  }

  Future<void> _loadDetail() async {
    final generation = ++_detailGeneration;
    setState(() {
      _loadingDetail = true;
      _detailFailure = null;
      _detail = null;
    });
    try {
      final result = await widget.api.getEventDetail(widget.eventId);
      if (!mounted || generation != _detailGeneration) return;
      setState(() {
        _detail = result;
        _loadingDetail = false;
      });
    } on ApiFailure catch (error) {
      if (!mounted || generation != _detailGeneration) return;
      setState(() {
        _detailFailure = error;
        _loadingDetail = false;
        if (error.kind == ApiFailureKind.notFound) {
          _historyGeneration++;
          _history = null;
          _historyCursor = null;
          _historyFailure = error;
          _loadingHistory = false;
          _loadingMoreHistory = false;
        }
      });
    } catch (_) {
      if (!mounted || generation != _detailGeneration) return;
      setState(() {
        _detailFailure = const ApiFailure(ApiFailureKind.network);
        _loadingDetail = false;
      });
    }
  }

  Future<void> _loadHistory({required bool reset, String? cursor}) async {
    if (_detailFailure?.kind == ApiFailureKind.notFound) return;
    final generation = ++_historyGeneration;
    setState(() {
      _historyFailure = null;
      if (reset) {
        _history = null;
        _historyCursor = null;
        _loadingHistory = true;
      } else {
        _loadingMoreHistory = true;
      }
    });
    try {
      final page =
          await widget.api.getEventHistory(widget.eventId, cursor: cursor);
      if (!mounted ||
          generation != _historyGeneration ||
          _detailFailure?.kind == ApiFailureKind.notFound) {
        return;
      }
      setState(() {
        _history = reset
            ? page
            : HistoryPage(
                data: [...?_history?.data, ...page.data],
                nextCursor: page.nextCursor,
                cursorExpiresAt: page.cursorExpiresAt);
        _historyCursor = page.nextCursor;
        _loadingHistory = false;
        _loadingMoreHistory = false;
      });
    } on ApiFailure catch (error) {
      if (!mounted || generation != _historyGeneration) return;
      setState(() {
        _historyFailure = error;
        _loadingHistory = false;
        _loadingMoreHistory = false;
      });
    } catch (_) {
      if (!mounted || generation != _historyGeneration) return;
      setState(() {
        _historyFailure = const ApiFailure(ApiFailureKind.network);
        _loadingHistory = false;
        _loadingMoreHistory = false;
      });
    }
  }

  Future<void> _openPreferences() async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => PreferencesScreen(repository: widget.preferences)));
    final latest = await widget.preferences.load();
    if (!mounted) return;
    setState(() => _interests = latest.interests);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: const Text('Detail laporan'),
          leading: IconButton(
              tooltip: 'Kembali ke daftar',
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
                tooltip: 'Muat ulang detail dan riwayat',
                onPressed: () {
                  _loadDetail();
                  _loadHistory(reset: true);
                },
                icon: const Icon(Icons.refresh)),
            IconButton(
                tooltip: 'Atur minat lokal',
                onPressed: _openPreferences,
                icon: const Icon(Icons.tune)),
          ],
        ),
        body: Column(children: [
          ModeNotice(contextInfo: widget.contextInfo),
          Expanded(
            child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
                children: [
                  if (_loadingDetail)
                    const _LoadingCard(message: 'Memuat detail laporan…'),
                  if (_detailFailure != null)
                    _DetailFailure(
                        failure: _detailFailure!, retry: _loadDetail),
                  if (_detail != null) ..._detailContent(context, _detail!),
                  const SizedBox(height: 24),
                  _historyContent(),
                ]),
          ),
        ]),
      );

  List<Widget> _detailContent(BuildContext context, EventDetail event) {
    final matches = locallyMatches(event, _interests);
    final reasons =
        matches ? localMatchReasons(event, _interests) : const <String>[];
    final scope = event.scope.all.toList();
    return [
      Text(event.category.label.toUpperCase(),
          style: const TextStyle(
              fontSize: 12,
              letterSpacing: .7,
              fontWeight: FontWeight.w800,
              color: WaspadaColors.teal)),
      const SizedBox(height: 7),
      Text(event.title, style: Theme.of(context).textTheme.headlineMedium),
      if (event.summary.isNotEmpty) ...[
        const SizedBox(height: 10),
        Text(event.summary, style: Theme.of(context).textTheme.bodyLarge),
      ],
      const SizedBox(height: 14),
      Wrap(spacing: 8, runSpacing: 8, children: [
        StatusPill(
            icon: Icons.timeline, label: 'Siklus: ${event.lifecycle.label}'),
        StatusPill(
            icon: Icons.update,
            label: 'Kesegaran: ${event.freshness.status.label}',
            color: event.freshness.status == FreshnessStatus.expired
                ? WaspadaColors.caution
                : WaspadaColors.softPanel),
      ]),
      const SizedBox(height: 16),
      Card(
          child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    sectionTitle('Waktu dan cakupan'),
                    const SizedBox(height: 8),
                    labelledFact(
                        context,
                        'Waktu kejadian/observasi pada laporan',
                        formatEventTime(event.eventTime)),
                    labelledFact(context, 'Validitas informasi',
                        _formatValidity(event.validity)),
                    labelledFact(context, 'Evaluasi kesegaran',
                        formatWib(event.freshness.evaluatedAt)),
                    labelledFact(context, 'Batas tinjau kesegaran',
                        formatWib(event.freshness.reviewDueAt)),
                    labelledFact(context, 'Versi publik diterbitkan',
                        formatWib(event.publishedAt)),
                    labelledFact(context, 'Respons konteks dibuat',
                        formatWib(widget.contextInfo.generatedAt)),
                    labelledFact(
                        context,
                        'Keberhasilan sumber terakhir',
                        widget.contextInfo.sources.isEmpty
                            ? 'Tidak ada sumber terdaftar pada konteks ini.'
                            : widget.contextInfo.sources
                                .map((source) =>
                                    '${source.displayName}: ${formatWib(source.lastSuccessAt)}')
                                .join(' · ')),
                    labelledFact(context, 'Waktu pengambilan sumber',
                        'Tidak disediakan dalam respons detail ini.'),
                    labelledFact(
                        context,
                        'Cakupan yang disebutkan',
                        scope.isEmpty
                            ? 'Tidak tersedia pada respons ini.'
                            : scope.join(', ')),
                    if (event.geometries.isEmpty)
                      const Padding(
                          padding: EdgeInsets.only(top: 8),
                          child: ReadOnlyNotice(
                              title: 'Tidak ada geometri pada respons ini.',
                              message:
                                  'Tampilan ini tidak menurunkan titik atau area dari nama tempat. Informasi lokasi yang disebutkan tetap tersedia dalam teks.',
                              icon: Icons.location_off_outlined))
                    else
                      const Padding(
                          padding: EdgeInsets.only(top: 8),
                          child: ReadOnlyNotice(
                              title:
                                  'Informasi geometri tidak ditampilkan sebagai peta.',
                              message:
                                  'Detail hanya menampilkan teks yang dikirim API. Tidak ada radius atau batas bahaya yang diturunkan oleh aplikasi.',
                              icon: Icons.map_outlined)),
                  ]))),
      const SizedBox(height: 16),
      Card(
          child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    sectionTitle('Bukti dan sumber'),
                    const SizedBox(height: 8),
                    if (event.claims.isEmpty)
                      const ReadOnlyNotice(
                          title: 'Bukti tidak tersedia pada respons ini.',
                          message:
                              'Ketiadaan klaim atau sumber di detail ini tidak membuktikan benar, salah, aman, atau selesai.'),
                    ...event.claims.map((claim) => Padding(
                          padding: const EdgeInsets.only(top: 12),
                          child: Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                                color: WaspadaColors.canvas,
                                borderRadius: BorderRadius.circular(10),
                                border:
                                    Border.all(color: WaspadaColors.concrete)),
                            child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  StatusPill(
                                      icon: Icons.fact_check_outlined,
                                      label: evidenceCaption(claim)),
                                  const SizedBox(height: 9),
                                  Text(claim.text,
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodyLarge),
                                  const SizedBox(height: 8),
                                  Text(
                                      'Waktu klaim kejadian/observasi: ${formatEventTime(claim.eventTime)}',
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodyMedium),
                                  if (claim.qualifiers.isNotEmpty) ...[
                                    const SizedBox(height: 7),
                                    Text(
                                        'Kualifikasi: ${claim.qualifiers.join(' ')}',
                                        style: const TextStyle(
                                            fontWeight: FontWeight.w600)),
                                  ],
                                  if (claim.sources.isEmpty) ...[
                                    const SizedBox(height: 8),
                                    const Text(
                                        'Atribusi sumber tidak tersedia pada klaim ini.'),
                                  ],
                                  ...claim.sources.map((source) => Padding(
                                        padding: const EdgeInsets.only(top: 12),
                                        child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Text(source.displayName,
                                                  style: Theme.of(context)
                                                      .textTheme
                                                      .titleMedium),
                                              const SizedBox(height: 6),
                                              Text(
                                                  'Sumber diterbitkan: ${formatWib(source.publishedAt)}',
                                                  style: Theme.of(context)
                                                      .textTheme
                                                      .bodyMedium),
                                              Text(
                                                  'Waktu observasi sumber: ${formatWib(source.observedAt)}',
                                                  style: Theme.of(context)
                                                      .textTheme
                                                      .bodyMedium),
                                              if (source.excerpt != null &&
                                                  source
                                                      .excerpt!.isNotEmpty) ...[
                                                const SizedBox(height: 8),
                                                Text(
                                                    'Kutipan yang diizinkan: “${source.excerpt}”',
                                                    style: Theme.of(context)
                                                        .textTheme
                                                        .bodyMedium),
                                              ],
                                              const SizedBox(height: 6),
                                              const Text(
                                                  'Alamat sumber (teks untuk disalin; tidak dibuka otomatis):',
                                                  style: TextStyle(
                                                      fontWeight:
                                                          FontWeight.w600)),
                                              SelectableText(source.url,
                                                  style: const TextStyle(
                                                      color: WaspadaColors.teal,
                                                      decoration: TextDecoration
                                                          .underline)),
                                            ]),
                                      )),
                                ]),
                          ),
                        )),
                  ]))),
      const SizedBox(height: 16),
      Card(
          child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    sectionTitle('Dampak yang tercantum'),
                    const SizedBox(height: 8),
                    if (event.impacts.isEmpty)
                      const ReadOnlyNotice(
                          title: 'Dampak tidak tersedia pada respons ini.',
                          message:
                              'Bagian kosong tidak menjelaskan keadaan atau keselamatan.'),
                    ...event.impacts.map((impact) => Padding(
                        padding: const EdgeInsets.only(top: 10),
                        child: Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                              color: WaspadaColors.canvas,
                              borderRadius: BorderRadius.circular(10)),
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(impact.title,
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleMedium),
                                const SizedBox(height: 5),
                                Text(impact.description),
                                const SizedBox(height: 7),
                                Wrap(spacing: 8, runSpacing: 7, children: [
                                  StatusPill(
                                      icon: Icons.timeline,
                                      label:
                                          'Siklus: ${impact.lifecycle.label}'),
                                  StatusPill(
                                      icon: Icons.update,
                                      label:
                                          'Kesegaran: ${impact.freshness.status.label}')
                                ]),
                                const SizedBox(height: 7),
                                Text(
                                    'Waktu dampak: ${formatEventTime(impact.eventTime)}'),
                              ]),
                        ))),
                  ]))),
      const SizedBox(height: 16),
      Card(
          child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    sectionTitle('Relevansi'),
                    const SizedBox(height: 8),
                    if (matches) ...[
                      Text(
                          'Cocok dengan pilihan minat pada perangkat ini: ${reasons.join(' · ')}',
                          style: Theme.of(context).textTheme.bodyLarge),
                      const SizedBox(height: 6),
                      const Text(
                          'Kecocokan bukan verifikasi, ukuran bahaya, atau bukti bahwa kamu berada di lokasi.'),
                    ] else
                      const Text(
                          'Tidak ada kecocokan minat yang dinilai untuk detail ini. Minat tidak dikirim ke layanan.'),
                  ]))),
    ];
  }

  Widget _historyContent() {
    return Card(
        child: Padding(
            padding: const EdgeInsets.all(16),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                    child: sectionTitle('Riwayat publik',
                        kicker: 'Perubahan yang ditampilkan API')),
                IconButton(
                    tooltip: 'Muat ulang riwayat',
                    onPressed: () => _loadHistory(reset: true),
                    icon: const Icon(Icons.refresh))
              ]),
              if (_loadingHistory)
                const _LoadingCard(
                    message: 'Memuat riwayat secara terpisah dari detail…'),
              if (_historyFailure != null) ...[
                const SizedBox(height: 8),
                _HistoryFailure(
                    failure: _historyFailure!,
                    retry: () => _loadHistory(reset: true)),
              ],
              if (_history != null &&
                  _history!.data.isEmpty &&
                  _historyCursor == null &&
                  _historyFailure == null) ...[
                const SizedBox(height: 10),
                const ReadOnlyNotice(
                    title: 'Tidak ada entri riwayat pada respons ini.',
                    message:
                        'Daftar kosong tidak menunjukkan keselamatan atau penyelesaian kejadian.'),
              ],
              if (_history != null)
                ..._history!.data.map((entry) => Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Padding(
                                padding: EdgeInsets.only(top: 3),
                                child: Icon(Icons.history,
                                    color: WaspadaColors.teal, size: 19)),
                            const SizedBox(width: 10),
                            Expanded(
                                child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                  Text(changeLabel(entry.changeType),
                                      style: Theme.of(context)
                                          .textTheme
                                          .titleMedium),
                                  const SizedBox(height: 4),
                                  Text(entry.summary,
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodyMedium),
                                  const SizedBox(height: 4),
                                  Text(
                                      'Perubahan versi ${entry.version} · waktu terbit perubahan ${formatWib(entry.changedAt)}',
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodySmall),
                                ])),
                          ]),
                    )),
              if (_historyCursor != null) ...[
                const SizedBox(height: 12),
                OutlinedButton.icon(
                    onPressed: _loadingMoreHistory
                        ? null
                        : () =>
                            _loadHistory(reset: false, cursor: _historyCursor),
                    icon: _loadingMoreHistory
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.expand_more),
                    label: Text(_loadingMoreHistory
                        ? 'Memuat…'
                        : 'Muat riwayat lainnya')),
              ],
              const SizedBox(height: 8),
              const Text(
                  'Jika detail tersedia tetapi riwayat gagal dimuat, detail tetap dapat dibaca.',
                  style: TextStyle(fontSize: 13)),
            ])));
  }

  String _formatValidity(Validity validity) {
    if (validity.validFrom == null && validity.validUntil == null) {
      return 'Tidak tersedia pada respons ini';
    }
    return '${formatWib(validity.validFrom)} sampai ${formatWib(validity.validUntil)}';
  }
}

class _LoadingCard extends StatelessWidget {
  const _LoadingCard({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Semantics(
          liveRegion: true,
          child: Row(children: [
            const SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(strokeWidth: 2)),
            const SizedBox(width: 12),
            Expanded(child: Text(message))
          ])));
}

class _DetailFailure extends StatelessWidget {
  const _DetailFailure({required this.failure, required this.retry});
  final ApiFailure failure;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => _ErrorCard(
        title: failure.kind == ApiFailureKind.notFound
            ? 'Laporan ini tidak tersedia.'
            : 'Detail laporan belum dapat dimuat.',
        message: failure.userMessage,
        retry: retry,
      );
}

class _HistoryFailure extends StatelessWidget {
  const _HistoryFailure({required this.failure, required this.retry});
  final ApiFailure failure;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => _ErrorCard(
        title: failure.kind == ApiFailureKind.notFound
            ? 'Riwayat ini tidak tersedia.'
            : 'Riwayat belum dapat dimuat.',
        message: failure.userMessage,
        retry: retry,
      );
}

class _ErrorCard extends StatelessWidget {
  const _ErrorCard(
      {required this.title, required this.message, required this.retry});
  final String title;
  final String message;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
            color: WaspadaColors.white,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: WaspadaColors.concrete)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 5),
          Text(message),
          const SizedBox(height: 5),
          TextButton.icon(
              onPressed: retry,
              icon: const Icon(Icons.refresh),
              label: const Text('Coba lagi')),
        ]),
      );
}
