import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:waspada_jakarta_mobile/src/interest_notifications.dart';
import 'package:waspada_jakarta_mobile/src/notify_platform.dart';
import 'package:waspada_jakarta_mobile/src/notify_settings_card.dart';
import 'package:waspada_jakarta_mobile/src/preferences.dart';
import 'package:waspada_jakarta_mobile/src/public_api.dart';
import 'package:waspada_jakarta_mobile/src/public_models.dart';
import 'package:waspada_jakarta_mobile/src/theme.dart';

import 'support/fakes.dart';

/// NOTIFY-01: local "Area saya" notifications on Android, tested without a device or network.

Map<String, Object?> detail(String id,
        {int version = 1,
        String title = 'Contoh sintetis',
        String category = 'transport_road_incidents',
        List<String> places = const ['Tempat Fiktif']}) =>
    {
      ...syntheticEventDetail,
      'event_id': id,
      'version': version,
      'title': title,
      'category': category,
      'scope': {
        'places': places,
        'services': <String>[],
        'institutions': <String>[],
        'audiences': <String>[]
      },
      'claims': <Object?>[],
    };

Map<String, Object?> change(String id,
        {int version = 1, String type = 'published'}) =>
    {
      'event_id': id,
      'version': version,
      'change_type': type,
      'changed_at': '2026-09-24T09:05:00+07:00',
      'summary': 'Perubahan sintetis.',
    };

class FakeNotifyApi implements NotifyApi {
  FakeNotifyApi(this.pages, this.details);

  /// Pages served in order for calls with a cursor. A null entry answers 410.
  final List<List<Map<String, Object?>>?> pages;
  final Map<String, Map<String, Object?>> details;
  final cursors = <String?>[];
  int detailCalls = 0;
  var _served = 0;

  @override
  Future<UpdatePage> getUpdates({String? cursor}) async {
    cursors.add(cursor);
    if (cursor == null) {
      return UpdatePage.fromJson({'items': [], 'next_cursor': 'c0'});
    }
    final items = _served < pages.length ? pages[_served] : const <Map<String, Object?>>[];
    _served++;
    if (items == null) {
      throw const ApiFailure(ApiFailureKind.http, statusCode: 410);
    }
    return UpdatePage.fromJson({'items': items, 'next_cursor': 'c$_served'});
  }

  @override
  Future<EventDetail> getEventDetail(String eventId) async {
    detailCalls++;
    final json = details[eventId];
    if (json == null) throw const ApiFailure(ApiFailureKind.notFound);
    return EventDetail.fromJson(json);
  }
}

const placeInterest = LocalInterests(places: ['tempat fiktif']);

Future<(MemoryStorage, List<NotifyContent>)> enabledStorage() async {
  final storage = MemoryStorage();
  await writeNotifyEnabled(storage, true);
  return (storage, <NotifyContent>[]);
}

void main() {
  test('NOTIFY-01: off by default, and an off run makes no network call',
      () async {
    final storage = MemoryStorage();
    final api = FakeNotifyApi([], {});
    expect(await readNotifyEnabled(storage), isFalse);
    final result = await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: (_) async {});
    expect(result.outcome, NotifyRunOutcome.off);
    expect(api.cursors, isEmpty);
  });

  test('NOTIFY-01: with no saved interest the run does nothing', () async {
    final (storage, _) = await enabledStorage();
    final api = FakeNotifyApi([], {});
    final result = await runNotifyCycle(
        api: api,
        storage: storage,
        interests: const LocalInterests(),
        show: (_) async {});
    expect(result.outcome, NotifyRunOutcome.off);
    expect(api.cursors, isEmpty);
  });

  test('NOTIFY-01: the first run only takes a baseline, then a matching change notifies once',
      () async {
    final (storage, shown) = await enabledStorage();
    final api = FakeNotifyApi([
      [change('e1')],
      [change('e1')],
    ], {
      'e1': detail('e1', title: 'Jalan ditutup di Tempat Fiktif')
    });
    Future<void> show(NotifyContent c) async => shown.add(c);

    final first = await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: show);
    expect(first.outcome, NotifyRunOutcome.baseline);
    expect(shown, isEmpty);

    final second = await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: show);
    expect(second.outcome, NotifyRunOutcome.checked);
    expect(shown, hasLength(1));
    expect(shown.single.title, 'Laporan baru di area Anda');
    expect(shown.single.body, contains('Jalan ditutup di Tempat Fiktif'));
    expect(shown.single.body, contains('Darurat: 112'));
    expect(shown.single.body.toLowerCase(), isNot(contains('aman')));
    expect(shown.single.eventId, 'e1');
    expect(api.cursors, [null, 'c0']);

    // The same event and version arriving again (another device clock, a replayed page) is not shown twice.
    final third = await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: show);
    expect(third.outcome, NotifyRunOutcome.checked);
    expect(shown, hasLength(1));
  });

  test('NOTIFY-01: matching follows the web rule: category, or a scope name in event, claim or impact',
      () {
    final event = EventDetail.fromJson(detail('e1',
        category: 'transport_road_incidents', places: ['Kelurahan Contoh']));
    expect(matchesInterests(event, const LocalInterests()), isFalse);
    expect(
        matchesInterests(event, const LocalInterests(places: ['  KELURAHAN contoh '])),
        isTrue,
        reason: 'case and spacing are normalised like the saved interests');
    expect(matchesInterests(event, const LocalInterests(places: ['Lain'])),
        isFalse);
    expect(
        matchesInterests(event,
            LocalInterests(categories: [event.category])),
        isTrue);
    final claimOnly = EventDetail.fromJson({
      ...detail('e2', places: []),
      'claims': syntheticEvent['claims'],
    });
    expect(
        matchesInterests(claimOnly, const LocalInterests(places: ['Tempat Fiktif'])),
        isTrue,
        reason: 'a claim scope counts, as on the web');
  });

  test('NOTIFY-01: at most three notifications per run plus one summary, newest version per event',
      () async {
    final (storage, shown) = await enabledStorage();
    final ids = ['a', 'b', 'c', 'd', 'e'];
    final api = FakeNotifyApi([
      [
        for (final id in ids) change(id),
        change('a', version: 2, type: 'corrected'),
      ],
    ], {
      for (final id in ids) id: detail(id, version: id == 'a' ? 2 : 1),
      'x': detail('x', places: ['Tidak cocok']),
    });
    Future<void> show(NotifyContent c) async => shown.add(c);
    await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: show);
    final result = await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: show);
    expect(result.shown, 4);
    expect(shown, hasLength(4));
    expect(shown.where((c) => c.eventId == 'a').single.title,
        'Laporan diperbarui di area Anda');
    expect(shown.last.title, '2 laporan lain di area Anda');
    expect(shown.last.eventId, isNull);
    expect(api.detailCalls, 5, reason: 'one detail per event, not per change');
  });

  test('NOTIFY-01: retracted changes, withdrawn events and stale details are never notified',
      () async {
    final (storage, shown) = await enabledStorage();
    final api = FakeNotifyApi([
      [
        change('gone'),
        change('r', type: 'retracted'),
        change('stale', version: 3),
      ],
    ], {
      'r': detail('r'),
      'stale': detail('stale', version: 2),
    });
    Future<void> show(NotifyContent c) async => shown.add(c);
    await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: show);
    final result = await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: show);
    expect(result.outcome, NotifyRunOutcome.checked);
    expect(shown, isEmpty);
  });

  test('NOTIFY-01: an expired cursor (410) re-baselines without replaying the gap',
      () async {
    final (storage, shown) = await enabledStorage();
    final api = FakeNotifyApi([null, [change('e1')]], {'e1': detail('e1')});
    Future<void> show(NotifyContent c) async => shown.add(c);
    await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: show);
    final gone = await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: show);
    expect(gone.outcome, NotifyRunOutcome.rebaselined);
    final again = await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: show);
    expect(again.outcome, NotifyRunOutcome.baseline);
    expect(shown, isEmpty);
  });

  test('NOTIFY-01: turning off forgets the cursor, so turning on again starts from a new baseline',
      () async {
    final (storage, _) = await enabledStorage();
    final api = FakeNotifyApi([], {});
    await runNotifyCycle(
        api: api, storage: storage, interests: placeInterest, show: (_) async {});
    expect(storage.values[notifyStateKey], contains('c0'));
    await writeNotifyEnabled(storage, false);
    expect(storage.values.containsKey(notifyStateKey), isFalse);
    expect(storage.values.containsKey(notifyEnabledKey), isFalse);
  });

  test('NOTIFY-01: notification ids are stable per event and never collide with the summary',
      () {
    expect(notificationIdFor('event-123'), notificationIdFor('event-123'));
    expect(notificationIdFor('event-123'), isNot(notificationIdFor('event-124')));
    for (final id in ['', 'a', 'event-123']) {
      expect(notificationIdFor(id), greaterThanOrEqualTo(2));
    }
  });

  testWidgets('NOTIFY-01: the Minat card is off by default, needs a saved interest, and reports a denied permission',
      (tester) async {
    final controller = FakeNotifyController(result: NotifyToggleResult.permissionDenied);
    Future<void> pump(bool hasSaved) => tester.pumpWidget(MaterialApp(
          theme: buildWaspadaTheme(),
          home: Scaffold(
              body: NotifySettingsCard(
                  controller: controller, hasSavedInterests: hasSaved)),
        ));

    await pump(false);
    await tester.pumpAndSettle();
    expect(find.text(notifyCardTitle), findsOneWidget);
    expect(find.textContaining('112'), findsOneWidget);
    expect(find.text(notifyNeedsInterest), findsOneWidget);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    expect(tester.widget<Switch>(find.byType(Switch)).onChanged, isNull);

    await pump(true);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(controller.enableCalls, 1);
    expect(find.textContaining('Izin notifikasi ditolak'), findsOneWidget);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });
}

class FakeNotifyController implements NotifyController {
  FakeNotifyController({required this.result});
  final NotifyToggleResult result;
  int enableCalls = 0;
  final _open = ValueNotifier<String?>(null);

  @override
  ValueListenable<String?> get openRequests => _open;
  @override
  void consumeOpenRequest() => _open.value = null;
  @override
  Future<bool> isEnabled() async => false;
  @override
  Future<NotifyToggleResult> enable() async {
    enableCalls++;
    return result;
  }

  @override
  Future<NotifyToggleResult> disable() async => NotifyToggleResult.off;
}
