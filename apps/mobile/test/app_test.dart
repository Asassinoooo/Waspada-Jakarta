import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:waspada_jakarta_mobile/src/app.dart';
import 'package:waspada_jakarta_mobile/src/event_detail_screen.dart';
import 'package:waspada_jakarta_mobile/src/event_list_screen.dart';
import 'package:waspada_jakarta_mobile/src/preferences.dart';
import 'package:waspada_jakarta_mobile/src/public_api.dart';
import 'package:waspada_jakarta_mobile/src/public_models.dart';
import 'package:waspada_jakarta_mobile/src/preferences_screen.dart';
import 'package:waspada_jakarta_mobile/src/read_guide_screen.dart';
import 'package:waspada_jakarta_mobile/src/theme.dart';

import 'support/fakes.dart';

Future<void> showApp(
    WidgetTester tester, SyntheticPublicApi api, MemoryStorage storage) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  await tester.pumpWidget(
      WaspadaApp(api: api, preferences: PreferencesRepository(storage)));
  await tester.pumpAndSettle();
}

Future<void> showEventList(
    WidgetTester tester, PublicApi api, MemoryStorage storage) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  await tester.pumpWidget(MaterialApp(
      home: EventListScreen(
          api: api, preferences: PreferencesRepository(storage))));
  await tester.pumpAndSettle();
}

EventPage _pageWithTitle(String id, String title) => EventPage.fromJson({
      'data': [
        {...syntheticEvent, 'event_id': id, 'title': title}
      ],
      'page': {'next_cursor': null, 'cursor_expires_at': null}
    });

PublicContext _contextWithSource(String name) => PublicContext.fromJson({
      ...syntheticContext,
      'sources': [
        {'display_name': name, 'health': 'healthy', 'last_success_at': null}
      ]
    });

class _DelayedSearchApi extends SyntheticPublicApi {
  final earlierSearch = Completer<EventPage>();
  final laterSearch = Completer<EventPage>();

  @override
  Future<EventPage> listEvents(EventQuery query) {
    pageCalls++;
    return switch (query.search) {
      'earlier' => earlierSearch.future,
      'later' => laterSearch.future,
      _ => Future.value(events),
    };
  }
}

class _OutOfOrderContextApi extends SyntheticPublicApi {
  _OutOfOrderContextApi({required EventPage result}) : super(events: result);

  final firstContext = Completer<PublicContext>();
  var _contextRequest = 0;

  @override
  Future<PublicContext> getContext() {
    contextCalls++;
    _contextRequest++;
    return _contextRequest == 1
        ? firstContext.future
        : Future.value(_contextWithSource('Fixture sumber terbaru'));
  }
}

HistoryPage _historyPage(String summary, {String? nextCursor}) =>
    HistoryPage.fromJson({
      'data': [
        {
          'event_id': 'synthetic-event-1',
          'version': 1,
          'change_type': 'published',
          'changed_at': '2026-09-24T09:15:00+07:00',
          'summary': summary,
        }
      ],
      'page': {'next_cursor': nextCursor, 'cursor_expires_at': null}
    });

class _DelayedDetailAndHistoryApi extends SyntheticPublicApi {
  final earlierDetail = Completer<EventDetail>();
  final earlierHistoryPage = Completer<HistoryPage>();

  @override
  Future<EventDetail> getEventDetail(String eventId) {
    detailCalls++;
    if (detailCalls == 1) return earlierDetail.future;
    return Future.value(EventDetail.fromJson(
        {...syntheticEventDetail, 'title': 'Fresh test detail'}));
  }

  @override
  Future<HistoryPage> getEventHistory(String eventId, {String? cursor}) {
    historyCalls++;
    if (cursor == 'older-cursor') return earlierHistoryPage.future;
    if (historyCalls == 1) {
      return Future.value(
          _historyPage('Initial history', nextCursor: 'older-cursor'));
    }
    return Future.value(_historyPage('Refreshed history'));
  }
}

class _NotFoundDetailAndDelayedHistoryApi extends SyntheticPublicApi {
  final lateHistory = Completer<HistoryPage>();

  @override
  Future<EventDetail> getEventDetail(String eventId) async {
    detailCalls++;
    throw const ApiFailure(ApiFailureKind.notFound);
  }

  @override
  Future<HistoryPage> getEventHistory(String eventId, {String? cursor}) {
    historyCalls++;
    return lateHistory.future;
  }
}

void main() {
  testWidgets(
      'demo landing labels synthetic data and an empty result without implying safety',
      (tester) async {
    final empty = EventPage.fromJson(const {
      'data': [],
      'page': {'next_cursor': null, 'cursor_expires_at': null}
    });
    final api = SyntheticPublicApi(events: empty);
    await showApp(tester, api, MemoryStorage());

    expect(find.text('DEMO — data sintetis; bukan peringatan langsung.'),
        findsOneWidget);
    expect(find.text('Tidak ada laporan pada halaman ini.'), findsOneWidget);
    expect(
        find.text('Laporan yang kosong bukan pernyataan bahwa kondisi aman.'),
        findsOneWidget);
    expect(
        find.text('Ilustrasi Jakarta — bukan peta kejadian'), findsOneWidget);
    expect(find.text('Jelajahi laporan'), findsOneWidget);
  });

  testWidgets('unknown dataset context hides preview and offers a useful retry',
      (tester) async {
    final api = SyntheticPublicApi(
        contextFailure: const ApiFailure(ApiFailureKind.payload));
    await showApp(tester, api, MemoryStorage());

    expect(find.text('Mode dataset belum tersedia.'), findsOneWidget);
    expect(
        find.text('Contoh sintetis: perubahan layanan fiktif'), findsNothing);
    expect(find.text('Coba lagi'), findsOneWidget);
    await tester.tap(find.text('Coba lagi'));
    await tester.pumpAndSettle();
    expect(api.contextCalls, 2);
  });

  testWidgets('landing ignores an older context that returns after a refresh',
      (tester) async {
    final empty = EventPage.fromJson(const {
      'data': [],
      'page': {'next_cursor': null, 'cursor_expires_at': null}
    });
    final api = _OutOfOrderContextApi(result: empty);
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(WaspadaApp(
        api: api, preferences: PreferencesRepository(MemoryStorage())));
    await tester.pump();

    await tester.tap(find.byTooltip('Muat ulang konteks dan ringkasan'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Fixture sumber terbaru'), findsOneWidget);
    expect(api.pageCalls, 1);

    api.firstContext.complete(_contextWithSource('Fixture sumber lama'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Fixture sumber terbaru'), findsOneWidget);
    expect(find.textContaining('Fixture sumber lama'), findsNothing);
    expect(api.pageCalls, 1);
  });

  testWidgets('list ignores a delayed result from an earlier search',
      (tester) async {
    final api = _DelayedSearchApi();
    await showEventList(tester, api, MemoryStorage());
    final search = find.byType(TextField).first;
    final submit = find.byTooltip('Cari');

    await tester.enterText(search, 'earlier');
    await tester.tap(submit);
    await tester.pump();
    expect(api.pageCalls, 2);

    await tester.enterText(search, 'later');
    await tester.tap(submit);
    await tester.pump();
    expect(api.pageCalls, 3);

    api.laterSearch.complete(_pageWithTitle('synthetic-later', 'Later result'));
    await tester.pumpAndSettle();
    expect(find.text('Later result'), findsOneWidget);

    api.earlierSearch
        .complete(_pageWithTitle('synthetic-earlier', 'Earlier result'));
    await tester.pumpAndSettle();
    expect(find.text('Later result'), findsOneWidget);
    expect(find.text('Earlier result'), findsNothing);
  });

  testWidgets(
      'detail refresh discards older detail and history pages, including load-more',
      (tester) async {
    final api = _DelayedDetailAndHistoryApi();
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(MaterialApp(
      theme: buildWaspadaTheme(),
      home: EventDetailScreen(
        api: api,
        contextInfo: PublicContext.fromJson(syntheticContext),
        eventId: 'synthetic-event-1',
        initialInterests: const LocalInterests(),
        preferences: PreferencesRepository(MemoryStorage()),
      ),
    ));
    await tester.pump();
    await tester.scrollUntilVisible(
      find.text('Muat riwayat lainnya'),
      250,
      scrollable: find.byType(Scrollable).first,
      maxScrolls: 20,
    );
    await tester.tap(find.text('Muat riwayat lainnya'));
    await tester.pump();
    expect(api.historyCalls, 2);

    await tester.tap(find.byTooltip('Muat ulang detail dan riwayat'));
    await tester.pumpAndSettle();
    expect(api.historyCalls, 3);
    expect(find.text('Fresh test detail'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Refreshed history'),
      250,
      scrollable: find.byType(Scrollable).first,
      maxScrolls: 20,
    );
    expect(find.text('Refreshed history'), findsOneWidget);
    expect(find.text('Initial history'), findsNothing);

    api.earlierDetail.complete(EventDetail.fromJson(
        {...syntheticEventDetail, 'title': 'Older detail'}));
    api.earlierHistoryPage.complete(_historyPage('Older history tail'));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView).first, const Offset(0, 5000));
    await tester.pumpAndSettle();
    expect(find.text('Fresh test detail'), findsOneWidget);
    expect(find.text('Older detail'), findsNothing);
    await tester.scrollUntilVisible(
      find.text('Refreshed history'),
      250,
      scrollable: find.byType(Scrollable).first,
      maxScrolls: 20,
    );
    expect(find.text('Refreshed history'), findsOneWidget);
    expect(find.text('Older history tail'), findsNothing);
  });

  testWidgets('a 404 detail invalidates an in-flight history response',
      (tester) async {
    final api = _NotFoundDetailAndDelayedHistoryApi();
    await tester.pumpWidget(MaterialApp(
      home: EventDetailScreen(
        api: api,
        contextInfo: PublicContext.fromJson(syntheticContext),
        eventId: 'synthetic-event-1',
        initialInterests: const LocalInterests(),
        preferences: PreferencesRepository(MemoryStorage()),
      ),
    ));
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.text('Laporan ini tidak tersedia.'), findsOneWidget);

    api.lateHistory.complete(_historyPage('Stale history for missing event'));
    await tester.pumpAndSettle();
    expect(find.text('Stale history for missing event'), findsNothing);
    expect(find.text('Laporan ini tidak tersedia.'), findsOneWidget);
  });

  testWidgets('main screens have no flex overflow at 320px and 2x text',
      (tester) async {
    tester.view.physicalSize = const Size(640, 1600);
    tester.view.devicePixelRatio = 2;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final api = SyntheticPublicApi();
    final storage = MemoryStorage();
    final preferences = PreferencesRepository(storage);
    final screens = <Widget>[
      LandingScreen(api: api, preferences: preferences),
      EventListScreen(api: api, preferences: preferences),
      EventDetailScreen(
        api: api,
        contextInfo: api.context,
        eventId: api.detail.id,
        initialInterests: const LocalInterests(),
        preferences: preferences,
      ),
      PreferencesScreen(repository: preferences),
      const ReadGuideScreen(),
    ];

    for (final screen in screens) {
      await tester.pumpWidget(MaterialApp(
        theme: buildWaspadaTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(
            textScaler: TextScaler.linear(2),
          ),
          child: child!,
        ),
        home: screen,
      ));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull,
          reason: '${screen.runtimeType} should fit a narrow viewport');
    }
  });

  testWidgets('secondary screens label their back controls in Bahasa',
      (tester) async {
    for (final screen in <Widget>[
      PreferencesScreen(repository: PreferencesRepository(MemoryStorage())),
      const ReadGuideScreen(),
    ]) {
      await tester.pumpWidget(MaterialApp(
        theme: buildWaspadaTheme(),
        home: screen,
      ));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Kembali'), findsOneWidget);
    }
  });

  testWidgets(
      'detail shows returned evidence and times while an unavailable history stays separate',
      (tester) async {
    final api = SyntheticPublicApi(
        historyFailure: const ApiFailure(ApiFailureKind.network));
    await tester.pumpWidget(MaterialApp(
      home: EventDetailScreen(
        api: api,
        contextInfo: PublicContext.fromJson(syntheticContext),
        eventId: 'synthetic-event-1',
        initialInterests: const LocalInterests(),
        preferences: PreferencesRepository(MemoryStorage()),
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Siklus: Direncanakan'), findsOneWidget);
    expect(find.text('Batas tinjau kesegaran'), findsOneWidget);
    expect(find.text('Waktu pengambilan sumber'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Laporan warga (Sumber fiksi)'),
      250,
      scrollable: find.byType(Scrollable).first,
      maxScrolls: 20,
    );
    await tester.pumpAndSettle();
    expect(find.text('Laporan warga (Sumber fiksi)'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Riwayat belum dapat dimuat.'),
      250,
      scrollable: find.byType(Scrollable).first,
      maxScrolls: 20,
    );
    await tester.pumpAndSettle();
    expect(find.text('Riwayat belum dapat dimuat.'), findsOneWidget);
    expect(find.text('Detail hanya menampilkan teks yang dikirim API.'),
        findsNothing);
    expect(api.detailCalls, 1);
    expect(api.historyCalls, 1);
  });
}
