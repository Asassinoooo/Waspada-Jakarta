import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:waspada_jakarta_mobile/src/event_detail_screen.dart';
import 'package:waspada_jakarta_mobile/src/history_changes.dart';
import 'package:waspada_jakarta_mobile/src/preferences.dart';
import 'package:waspada_jakarta_mobile/src/public_models.dart';

import 'support/fakes.dart';

final _wholeWordAman = RegExp(r'\baman\b', caseSensitive: false);

List<HistoryChange> _changesFrom(List<Object?> items) => HistoryEntry.fromJson({
      'event_id': 'synthetic-event-1',
      'version': 2,
      'change_type': 'corrected',
      'changed_at': '2026-11-24T09:00:00+07:00',
      'summary': 'Ringkasan fiksi.',
      'changes': items,
    }).changes;

const _syntheticChanges = <Object?>[
  {'field': 'title', 'before': 'Judul lama', 'after': 'Judul baru'},
  {'field': 'lifecycle', 'before': 'planned', 'after': 'ongoing'},
  {'field': 'event_time', 'before': null, 'after': 'exact 2026-11-24T08:00:00+07:00 -'},
  {'field': 'places', 'added': ['Kelurahan Contoh'], 'removed': ['Kecamatan Contoh']},
  {'field': 'claims', 'before_count': 1, 'after_count': 3},
];

Widget _host(Widget child) => MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: child)),
    );

void main() {
  test('historyValueText uses mobile labels, readable times and the empty wording', () {
    expect(historyValueText('category', 'disasters_weather'), 'Bencana dan cuaca');
    expect(historyValueText('freshness', 'needs_update'), 'Perlu diperbarui');
    expect(historyValueText('lifecycle', 'ongoing'), 'Berlangsung');
    expect(historyValueText('lifecycle', 'something_new'), 'something_new');
    expect(historyValueText('title', null), 'Tidak ada');
    expect(historyValueText('title', '   '), 'Tidak ada');
    expect(historyValueText('event_time', null), 'Waktu tidak diketahui pada respons ini');
    expect(historyValueText('event_time', 'date 2026-11-20 -'), '20-11-2026 (tanggal saja)');
    expect(
        historyValueText('event_time',
            'range 2026-11-20T08:00:00+07:00 2026-11-20T10:00:00+07:00'),
        '20-11-2026 08:00 WIB sampai 20-11-2026 10:00 WIB');
    expect(historyValueText('event_time', 'weekly x -'), 'weekly x -');
    expect(historyValueText('validity', null), 'Tidak ada masa berlaku dari sumber');
    expect(historyValueText('validity', '2026-11-20T08:00:00+07:00 -'), 'Mulai 20-11-2026 08:00 WIB');
    expect(historyValueText('validity', '- 2026-11-30T08:00:00+07:00'), 'Sampai 30-11-2026 08:00 WIB');
    expect(historyValueText('validity', '- -'), 'Tidak ada');
  });

  testWidgets('the disclosure is absent when an entry has no changes', (tester) async {
    await tester.pumpWidget(_host(const HistoryChangesTile(changes: [])));

    expect(find.byType(ExpansionTile), findsNothing);
    expect(find.textContaining('Lihat perubahan'), findsNothing);
  });

  testWidgets('the disclosure counts its changes and expands to labelled rows', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(_host(HistoryChangesTile(changes: _changesFrom(_syntheticChanges))));

    expect(find.text('Lihat perubahan (5)'), findsOneWidget);
    await tester.tap(find.text('Lihat perubahan (5)'));
    await tester.pumpAndSettle();

    expect(find.text('Dibandingkan dengan versi terbit sebelumnya.'), findsOneWidget);
    expect(find.text('Judul'), findsOneWidget);
    expect(find.text('Judul lama'), findsOneWidget);
    expect(find.text('Judul baru'), findsOneWidget);
    expect(find.text('Status kejadian'), findsOneWidget);
    expect(find.text('Direncanakan'), findsOneWidget);
    expect(find.text('Berlangsung'), findsOneWidget);
    expect(find.text('Waktu kejadian'), findsOneWidget);
    expect(find.text('24-11-2026 08:00 WIB'), findsOneWidget);
    expect(find.text('Lokasi'), findsOneWidget);
    expect(find.text('+ Kelurahan Contoh'), findsOneWidget);
    expect(find.text('− Kecamatan Contoh'), findsOneWidget);
    expect(find.bySemanticsLabel('Ditambahkan: Kelurahan Contoh'), findsOneWidget);
    expect(find.bySemanticsLabel('Dihapus: Kecamatan Contoh'), findsOneWidget);
    expect(find.bySemanticsLabel('Sebelum: Judul lama. Sesudah: Judul baru.'), findsOneWidget);
    expect(find.bySemanticsLabel(
            'Sebelum: Waktu tidak diketahui pada respons ini. Sesudah: 24-11-2026 08:00 WIB.'),
        findsOneWidget);
    expect(find.text('1 klaim'), findsOneWidget);
    expect(find.text('3 klaim'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('the disclosure never shows the word aman', (tester) async {
    final changes = _changesFrom([
      ..._syntheticChanges,
      {'field': 'category', 'before': 'crime_personal_security', 'after': 'disasters_weather'},
      {'field': 'freshness', 'before': 'current', 'after': 'expired'},
      {'field': 'validity', 'before': null, 'after': '2026-11-20T08:00:00+07:00 -'},
      {'field': 'audiences', 'added': ['Pengendara motor'], 'removed': []},
      {'field': 'impacts', 'before_count': 0, 'after_count': 2},
    ]);
    await tester.pumpWidget(_host(HistoryChangesTile(changes: changes)));
    await tester.tap(find.text('Lihat perubahan (10)'));
    await tester.pumpAndSettle();

    expect(find.text('Kejahatan dan keamanan pribadi'), findsOneWidget);
    expect(find.text('Tidak ada masa berlaku dari sumber'), findsOneWidget);
    expect(find.text('Mulai 20-11-2026 08:00 WIB'), findsOneWidget);
    for (final text in tester.widgetList<Text>(find.byType(Text))) {
      expect(_wholeWordAman.hasMatch(text.data ?? ''), isFalse, reason: text.data);
    }
  });

  testWidgets('the event detail shows the disclosure only on the entry that has changes', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = SyntheticPublicApi(
        history: HistoryPage.fromJson({
      'data': [
        {
          'event_id': 'synthetic-event-1',
          'version': 2,
          'change_type': 'corrected',
          'changed_at': '2026-09-24T09:15:00+07:00',
          'summary': 'Dengan perubahan.',
          'changes': [
            {'field': 'title', 'before': 'Lama', 'after': 'Baru'},
          ],
        },
        {
          'event_id': 'synthetic-event-1',
          'version': 1,
          'change_type': 'published',
          'changed_at': '2026-09-24T09:00:00+07:00',
          'summary': 'Tanpa perubahan.',
        },
      ],
      'page': {'next_cursor': null, 'cursor_expires_at': null},
    }));
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
    await tester.scrollUntilVisible(
      find.text('Lihat perubahan (1)'),
      250,
      scrollable: find.byType(Scrollable).first,
      maxScrolls: 30,
    );
    await tester.ensureVisible(find.text('Lihat perubahan (1)'));
    await tester.pumpAndSettle();

    expect(find.text('Dengan perubahan.'), findsOneWidget);
    expect(find.text('Tanpa perubahan.'), findsOneWidget);
    expect(find.byType(ExpansionTile), findsOneWidget);
    await tester.tap(find.text('Lihat perubahan (1)'));
    await tester.pumpAndSettle();
    expect(find.text('Lama'), findsOneWidget);
    expect(find.text('Baru'), findsOneWidget);
  });
}
