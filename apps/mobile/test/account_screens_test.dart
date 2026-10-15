import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:waspada_jakarta_mobile/src/account_auth.dart';
import 'package:waspada_jakarta_mobile/src/account_models.dart';
import 'package:waspada_jakarta_mobile/src/account_screens.dart';
import 'package:waspada_jakarta_mobile/src/preferences.dart';
import 'package:waspada_jakarta_mobile/src/theme.dart';

import 'support/account_fakes.dart';
import 'support/fakes.dart';

void _setCompactViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(640, 1600);
  tester.view.devicePixelRatio = 2;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}

void main() {
  testWidgets('guest can read and finish the optional three-step onboarding', (
    tester,
  ) async {
    final api = FakeAccountApi();
    final auth = AccountAuthController(
      api: api,
      tokenStore: MemorySecureTokenStore(),
      identityProvider: FakeGoogleIdentityProvider(),
      nativeSupported: false,
    );
    addTearDown(auth.dispose);
    await auth.restore();
    final preferences = PreferencesRepository(MemoryStorage());
    await tester.pumpWidget(
      MaterialApp(
        theme: buildWaspadaTheme(),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: FilledButton(
                onPressed: () => Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                    builder: (_) => AccountOnboardingScreen(
                      auth: auth,
                      preferences: preferences,
                    ),
                  ),
                ),
                child: const Text('Buka panduan'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Buka panduan'));
    await tester.pumpAndSettle();
    expect(find.text('Langkah 1 dari 3'), findsOneWidget);
    expect(find.textContaining('Kesegaran menjelaskan'), findsOneWidget);
    expect(
      find.textContaining('tidak membuktikan kondisi fisik aman'),
      findsOneWidget,
    );

    await tester.tap(find.text('Lanjut'));
    await tester.pumpAndSettle();
    expect(find.text('Langkah 2 dari 3'), findsOneWidget);
    expect(find.text('Atur minat di perangkat ini'), findsOneWidget);
    expect(find.textContaining('Minat tidak diunggah'), findsOneWidget);
    expect(
      find.textContaining('aplikasi tidak meminta lokasi'),
      findsOneWidget,
    );

    await tester.tap(find.text('Lanjut'));
    await tester.pumpAndSettle();
    expect(find.text('Langkah 3 dari 3'), findsOneWidget);
    expect(find.text('Privasi dan akun'), findsOneWidget);
    await tester.ensureVisible(find.text('Selesaikan panduan'));
    await tester.tap(find.text('Selesaikan panduan'));
    await tester.pumpAndSettle();

    expect(find.text('Buka panduan'), findsOneWidget);
    expect(api.onboardingCalls, 0);
  });

  testWidgets(
    'privileged account sees its assigned role without admin controls',
    (tester) async {
      final token = List.filled(48, 'x').join();
      final api = FakeAccountApi()
        ..session = authenticatedAccountSession(
          role: AccountRole.admin,
          onboardingVersion: 1,
        );
      final auth = AccountAuthController(
        api: api,
        tokenStore: MemorySecureTokenStore()..token = token,
        identityProvider: FakeGoogleIdentityProvider(),
      );
      addTearDown(auth.dispose);
      await auth.restore();
      await tester.pumpWidget(
        MaterialApp(
          theme: buildWaspadaTheme(),
          home: AccountScreen(
            auth: auth,
            preferences: PreferencesRepository(MemoryStorage()),
            onOpenOnboarding: () {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Peran: Administrator'), findsOneWidget);
      expect(find.text('Keluar dari akun'), findsOneWidget);
      expect(find.textContaining('Kelola'), findsNothing);
      expect(find.text('Ubah peran'), findsNothing);
      expect(find.text('Dashboard admin'), findsNothing);
      expect(find.text('Moderasi'), findsNothing);
    },
  );

  testWidgets('account and onboarding layouts fit 320px at 200% text', (
    tester,
  ) async {
    _setCompactViewport(tester);
    final auth = AccountAuthController.guestOnly();
    addTearDown(auth.dispose);
    await auth.restore();
    final preferences = PreferencesRepository(MemoryStorage());
    final screens = <Widget>[
      AccountScreen(
        auth: auth,
        preferences: preferences,
        onOpenOnboarding: () {},
      ),
      AccountOnboardingScreen(auth: auth, preferences: preferences),
    ];

    for (final screen in screens) {
      await tester.pumpWidget(
        MaterialApp(
          theme: buildWaspadaTheme(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(2)),
            child: child!,
          ),
          home: screen,
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.takeException(),
        isNull,
        reason: '${screen.runtimeType} should fit a narrow viewport',
      );
    }
  });
}
