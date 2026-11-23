import 'package:flutter/material.dart';
import 'package:waspada_jakarta_mobile/src/public_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:waspada_jakarta_mobile/src/app.dart';
import 'package:waspada_jakarta_mobile/src/map_screen.dart';
import 'package:waspada_jakarta_mobile/src/preferences.dart';
import 'package:waspada_jakarta_mobile/src/public_models.dart';
import 'package:waspada_jakarta_mobile/src/theme.dart';

import 'support/fakes.dart';

Map<String, Object?> _event(Map<String, Object?> extra) =>
    {...syntheticEvent, ...extra};

Map<String, Object?> _page(List<Map<String, Object?>> events) => {
      'data': events,
      'page': {'next_cursor': null, 'cursor_expires_at': null},
    };

void main() {
  group('MOBILE-V2 contract', () {
    test('a whole-view event parses instead of failing the whole page', () {
      final page = EventPage.fromJson(
          _page([_event({'location_display': 'whole_view'})]));
      expect(page.data.single.locationDisplay, LocationDisplay.wholeView);
    });

    test('a point event and an unknown display value both parse', () {
      expect(EventRecord.fromJson(_event({'location_display': 'point'}))
          .locationDisplay, LocationDisplay.point);
      expect(EventRecord.fromJson(_event({'location_display': 'later'}))
          .locationDisplay, isNull);
    });

    test('detail accepts the additive publication block', () {
      final detail = EventDetail.fromJson({
        ...syntheticEventDetail,
        'location_display': 'whole_view',
        'publication': {'mode': 'agent_auto', 'source_count': 2},
      });
      expect(detail.locationDisplay, LocationDisplay.wholeView);
    });

    test('map points keep only Point features and mark approximate places', () {
      final points = MapPoint.listFromGeoJson({
        'type': 'FeatureCollection',
        'features': [
          {
            'type': 'Feature',
            'id': 'a',
            'geometry': {
              'type': 'Point',
              'coordinates': [106.845, -6.185]
            },
            'properties': {
              'event_id': 'evt-a',
              'version': 1,
              'title': 'Genangan',
              'category': syntheticEvent['category'],
              'lifecycle': 'active',
              'freshness': 'fresh',
              'geometry_role': 'approximate_place',
            },
          },
          {
            'type': 'Feature',
            'id': 'b',
            'geometry': {
              'type': 'Polygon',
              'coordinates': [
                [
                  [106.8, -6.2],
                  [106.9, -6.2],
                  [106.9, -6.1],
                  [106.8, -6.2]
                ]
              ]
            },
            'properties': {
              'event_id': 'evt-b',
              'version': 1,
              'title': 'Area',
              'category': syntheticEvent['category'],
              'lifecycle': 'active',
              'freshness': 'fresh',
              'geometry_role': 'affected_area',
            },
          },
        ],
      });
      expect(points, hasLength(1));
      expect(points.single.eventId, 'evt-a');
      expect(points.single.approximate, isTrue);
      expect(points.single.longitude, 106.845);
      expect(points.single.latitude, -6.185);
    });

    test('a malformed collection is rejected', () {
      expect(() => MapPoint.listFromGeoJson({'type': 'Feature'}),
          throwsA(isA<ContractViolation>()));
    });
  });

  group('MOBILE-V2 screens', () {
    Future<void> pumpApp(WidgetTester tester, SyntheticPublicApi api,
        {Brightness brightness = Brightness.light}) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.platformBrightnessTestValue = brightness;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
        tester.platformDispatcher.clearPlatformBrightnessTestValue();
      });
      await tester.pumpWidget(WaspadaApp(
          api: api,
          preferences: PreferencesRepository(MemoryStorage()),
          showMapTiles: false));
      await tester.pumpAndSettle();
    }

    testWidgets('bottom navigation reaches the map, list and interests',
        (tester) async {
      final api = SyntheticPublicApi();
      await pumpApp(tester, api);
      expect(find.text('Beranda'), findsOneWidget);

      await tester.tap(find.text('Peta'));
      await tester.pumpAndSettle();
      expect(find.byType(MapScreen), findsOneWidget);
      expect(api.mapCalls, 1);

      await tester.tap(find.text('Laporan'));
      await tester.pumpAndSettle();
      expect(find.text('Laporan publik'), findsOneWidget);
      // A tab has no back control.
      expect(find.byTooltip('Kembali'), findsNothing);

      await tester.tap(find.text('Minat'));
      await tester.pumpAndSettle();
      expect(find.text('Minat dan privasi'), findsOneWidget);
    });

    testWidgets(
        'an event without a point is listed under "Tanpa titik lokasi" and gets no pin',
        (tester) async {
      final api = SyntheticPublicApi(
          events: EventPage.fromJson(
              _page([_event({'location_display': 'whole_view'})])));
      api.mapPoints = const [];
      await pumpApp(tester, api);
      await tester.tap(find.text('Peta'));
      await tester.pumpAndSettle();

      expect(find.text('0 bertitik · 1 tanpa titik lokasi'), findsOneWidget);
      expect(find.text('Tanpa titik lokasi'), findsWidgets);
      // Pull the sheet up to reveal the listed event.
      await tester.drag(find.text('Tanpa titik lokasi').last, const Offset(0, -500));
      await tester.pumpAndSettle();
      expect(find.text(syntheticEvent['title']! as String), findsWidgets);
      expect(find.bySemanticsLabel(RegExp('lokasi perkiraan')), findsNothing);
    });

    testWidgets('a map point becomes one pin with its approximate label',
        (tester) async {
      final api = SyntheticPublicApi();
      api.mapPoints = [
        MapPoint(
            eventId: api.events.data.single.id,
            title: 'Titik contoh',
            category: api.events.data.single.category,
            longitude: 106.845,
            latitude: -6.185,
            approximate: true),
      ];
      await pumpApp(tester, api);
      await tester.tap(find.text('Peta'));
      await tester.pumpAndSettle();

      expect(find.text('1 bertitik · 0 tanpa titik lokasi'), findsOneWidget);
      expect(find.bySemanticsLabel('Titik contoh, lokasi perkiraan'),
          findsOneWidget);
    });

    testWidgets('a map failure offers a retry', (tester) async {
      final api = SyntheticPublicApi();
      api.mapFailure = const ApiFailure(ApiFailureKind.network);
      await pumpApp(tester, api);
      await tester.tap(find.text('Peta'));
      await tester.pumpAndSettle();
      expect(find.text('Peta belum dapat dimuat.'), findsOneWidget);
      api.mapFailure = null;
      await tester.tap(find.text('Coba lagi'));
      await tester.pumpAndSettle();
      expect(find.text('Peta belum dapat dimuat.'), findsNothing);
    });

    testWidgets('dark mode renders the landing without layout errors',
        (tester) async {
      await pumpApp(tester, SyntheticPublicApi(), brightness: Brightness.dark);
      final context = tester.element(find.byType(LandingScreen));
      expect(Theme.of(context).brightness, Brightness.dark);
      expect(context.palette, WaspadaPalette.dark);
      expect(tester.takeException(), isNull);
    });
  });
}
