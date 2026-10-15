import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:waspada_jakarta_mobile/src/preferences.dart';
import 'package:waspada_jakarta_mobile/src/preferences_screen.dart';
import 'package:waspada_jakarta_mobile/src/theme.dart';

import 'support/fakes.dart';

class _UnavailableReadDelayedWriteStorage extends MemoryStorage {
  final writeStarted = Completer<void>();
  final releaseWrite = Completer<void>();
  int readCalls = 0;

  @override
  Future<String?> getString(String key) {
    readCalls++;
    return super.getString(key);
  }

  @override
  Future<bool> setString(String key, String value) async {
    writeStarted.complete();
    await releaseWrite.future;
    return super.setString(key, value);
  }
}

void main() {
  testWidgets(
      'a stale retry cannot replace unsaved choices, and retry stays disabled while saving',
      (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final storage = _UnavailableReadDelayedWriteStorage()..failReads = true;
    await tester.pumpWidget(MaterialApp(
      theme: buildWaspadaTheme(),
      home: PreferencesScreen(repository: PreferencesRepository(storage)),
    ));
    await tester.pumpAndSettle();

    final retryText = find.text('Coba baca lagi');
    await tester.scrollUntilVisible(retryText, 220,
        scrollable: find.byType(Scrollable).first, maxScrolls: 10);
    expect(retryText, findsOneWidget);
    final retryFinder =
        find.ancestor(of: retryText, matching: find.byType(TextButton));
    expect(storage.readCalls, 1);
    final staleRetry = tester.widget<TextButton>(retryFinder).onPressed;
    expect(staleRetry, isNotNull);

    final placeField = find.byWidgetPredicate((widget) =>
        widget is TextField &&
        widget.decoration?.hintText == 'Tambahkan tempat');
    await tester.scrollUntilVisible(placeField, 240,
        scrollable: find.byType(Scrollable).first, maxScrolls: 20);
    await tester.ensureVisible(find.byTooltip('Tambahkan tempat'));
    await tester.drag(find.byType(ListView).first, const Offset(0, 120));
    await tester.pumpAndSettle();
    await tester.enterText(placeField, 'E\u0301vakuasi Selatan');
    await tester.tap(find.byTooltip('Tambahkan tempat'));
    await tester.pumpAndSettle();
    expect(find.text('E\u0301vakuasi Selatan'), findsOneWidget);

    await tester.enterText(placeField, 'Évakuasi Selatan');
    await tester.tap(find.byTooltip('Tambahkan tempat'));
    await tester.pumpAndSettle();
    expect(find.text('Pilihan ini sudah ada.'), findsOneWidget);
    expect(find.text('E\u0301vakuasi Selatan'), findsOneWidget);

    staleRetry!();
    await tester.pumpAndSettle();
    expect(storage.readCalls, 1);
    expect(find.text('E\u0301vakuasi Selatan'), findsOneWidget);

    await tester.drag(find.byType(ListView).first, const Offset(0, 5000));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(retryText, 220,
        scrollable: find.byType(Scrollable).first, maxScrolls: 10);
    expect(tester.widget<TextButton>(retryFinder).onPressed, isNull);

    final saveFinder = find.widgetWithText(FilledButton, 'Simpan di perangkat');
    await tester.scrollUntilVisible(saveFinder, 260,
        scrollable: find.byType(Scrollable).first, maxScrolls: 20);
    await tester.tap(saveFinder);
    await tester.pump();
    await storage.writeStarted.future;

    await tester.drag(find.byType(ListView).first, const Offset(0, 5000));
    await tester.pump();
    await tester.scrollUntilVisible(retryText, 220,
        scrollable: find.byType(Scrollable).first, maxScrolls: 10);
    expect(tester.widget<TextButton>(retryFinder).onPressed, isNull);
    staleRetry();
    await tester.pump();
    expect(storage.readCalls, 1);

    storage.releaseWrite.complete();
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
        find.text('Pilihan tersimpan di perangkat ini.'), 260,
        scrollable: find.byType(Scrollable).first, maxScrolls: 20);
    expect(find.text('Pilihan tersimpan di perangkat ini.'), findsOneWidget);
    expect(storage.values[preferencesStorageKey], isNotNull);
  });
}
