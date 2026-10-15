import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:waspada_jakarta_mobile/src/account_api.dart';
import 'package:waspada_jakarta_mobile/src/account_auth.dart';
import 'package:waspada_jakarta_mobile/src/account_models.dart';

import 'support/account_fakes.dart';

void main() {
  test(
    'optional Google sign-in exchanges the ID token and stores only session token',
    () async {
      final api = FakeAccountApi();
      final store = MemorySecureTokenStore();
      final google = FakeGoogleIdentityProvider();
      final auth = AccountAuthController(
        api: api,
        tokenStore: store,
        identityProvider: google,
      );
      addTearDown(auth.dispose);

      await auth.restore();
      expect(auth.status, AccountAuthStatus.anonymous);
      expect(auth.googleLoginAvailable, isTrue);

      await auth.signInWithGoogle();

      expect(api.receivedGoogleIdTokens, [google.idToken]);
      expect(store.token, api.exchangeResult.sessionToken);
      expect(store.token, isNot(google.idToken));
      expect(auth.status, AccountAuthStatus.authenticated);
      expect(auth.user?.role, AccountRole.user);
    },
  );

  test('cancelled provider flow leaves the visitor anonymous', () async {
    final api = FakeAccountApi();
    final store = MemorySecureTokenStore();
    final google = FakeGoogleIdentityProvider()
      ..authenticateFailure = const GoogleIdentityCancelled();
    final auth = AccountAuthController(
      api: api,
      tokenStore: store,
      identityProvider: google,
    );
    addTearDown(auth.dispose);

    await auth.restore();
    await auth.signInWithGoogle();

    expect(auth.status, AccountAuthStatus.anonymous);
    expect(auth.message, 'Masuk dengan Google dibatalkan.');
    expect(api.exchangeCalls, 0);
    expect(store.token, isNull);
  });

  test('a revoked bearer session is cleared and shown as expired', () async {
    final store = MemorySecureTokenStore()..token = List.filled(48, 'x').join();
    final api = FakeAccountApi()..session = anonymousAccountSession();
    final auth = AccountAuthController(
      api: api,
      tokenStore: store,
      identityProvider: FakeGoogleIdentityProvider(),
    );
    addTearDown(auth.dispose);

    await auth.restore();

    expect(api.sessionBearerTokens, [List.filled(48, 'x').join()]);
    expect(store.token, isNull);
    expect(auth.status, AccountAuthStatus.expired);
    expect(auth.user, isNull);
  });

  test('offline restore preserves secure token for a later retry', () async {
    final token = List.filled(48, 'x').join();
    final store = MemorySecureTokenStore()..token = token;
    final api = FakeAccountApi()
      ..sessionFailure = const AccountApiFailure(AccountApiFailureKind.network);
    final auth = AccountAuthController(
      api: api,
      tokenStore: store,
      identityProvider: FakeGoogleIdentityProvider(),
    );
    addTearDown(auth.dispose);

    await auth.restore();

    expect(auth.status, AccountAuthStatus.offline);
    expect(store.token, token);
  });

  test(
    'onboarding submits only version 1 using the native bearer session',
    () async {
      final token = List.filled(48, 'x').join();
      final api = FakeAccountApi()
        ..session = authenticatedAccountSession(onboardingVersion: 0);
      final store = MemorySecureTokenStore()..token = token;
      final auth = AccountAuthController(
        api: api,
        tokenStore: store,
        identityProvider: FakeGoogleIdentityProvider(),
      );
      addTearDown(auth.dispose);

      await auth.restore();
      final completed = await auth.completeOnboarding();

      expect(completed, isTrue);
      expect(api.onboardingCalls, 1);
      expect(api.onboardingBearerTokens, [token]);
      expect(auth.user?.onboardingVersion, 1);
      expect(auth.user?.role, AccountRole.user);
    },
  );

  test(
    'logout clears local token even if the server cannot confirm revocation',
    () async {
      final token = List.filled(48, 'x').join();
      final api = FakeAccountApi()
        ..session = authenticatedAccountSession()
        ..logoutFailure = const AccountApiFailure(
          AccountApiFailureKind.network,
        );
      final store = MemorySecureTokenStore()..token = token;
      final auth = AccountAuthController(
        api: api,
        tokenStore: store,
        identityProvider: FakeGoogleIdentityProvider(),
      );
      addTearDown(auth.dispose);

      await auth.restore();
      await auth.logout();

      expect(api.logoutBearerTokens, [token]);
      expect(store.token, isNull);
      expect(auth.status, AccountAuthStatus.anonymous);
      expect(auth.user, isNull);
      expect(auth.message, contains('belum mengonfirmasi'));
    },
  );

  test('secure storage write failure revokes the exchanged session', () async {
    final api = FakeAccountApi();
    final store = MemorySecureTokenStore()..failWrites = true;
    final auth = AccountAuthController(
      api: api,
      tokenStore: store,
      identityProvider: FakeGoogleIdentityProvider(),
    );
    addTearDown(auth.dispose);

    await auth.restore();
    await auth.signInWithGoogle();

    expect(api.logoutBearerTokens, [api.exchangeResult.sessionToken]);
    expect(store.token, isNull);
    expect(auth.status, AccountAuthStatus.error);
    expect(auth.user, isNull);
  });

  test(
    'guest-only platform never reads token storage or calls account APIs',
    () async {
      final api = FakeAccountApi();
      final store = MemorySecureTokenStore()
        ..token = List.filled(48, 'x').join();
      final google = FakeGoogleIdentityProvider();
      final auth = AccountAuthController(
        api: api,
        tokenStore: store,
        identityProvider: google,
        nativeSupported: false,
      );
      addTearDown(auth.dispose);
      await auth.restore();
      await auth.signInWithGoogle();
      expect(auth.status, AccountAuthStatus.anonymous);
      expect(auth.googleLoginAvailable, isFalse);
      expect(
        auth.loginUnavailableMessage,
        'Google login tersedia di aplikasi Android.',
      );
      expect(store.readCalls, 0);
      expect(api.sessionBearerTokens, isEmpty);
      expect(api.exchangeCalls, 0);
      expect(google.authenticateCalls, 0);
    },
  );

  test(
    'a late session response cannot replace a more recent restore',
    () async {
      final late = Completer<AccountSession>();
      final api = FakeAccountApi()
        ..sessionReplies.add(() => late.future)
        ..sessionReplies.add(() => Future.value(anonymousAccountSession()));
      final auth = AccountAuthController(
        api: api,
        tokenStore: MemorySecureTokenStore(),
        identityProvider: FakeGoogleIdentityProvider(),
      );
      addTearDown(auth.dispose);

      final first = auth.restore();
      await Future<void>.delayed(Duration.zero);
      final second = auth.restore();
      await second;
      late.complete(authenticatedAccountSession(role: AccountRole.admin));
      await first;

      expect(auth.status, AccountAuthStatus.anonymous);
      expect(auth.user, isNull);
    },
  );

  test('account session parser rejects browser CSRF and unknown fields', () {
    final valid = {
      'version': accountContractVersion,
      'status': 'anonymous',
      'google_login_available': true,
      'native_login_available': true,
      'csrf_token': null,
      'user': null,
    };
    expect(
      AccountSession.fromJson(valid).status,
      AccountSessionStatus.anonymous,
    );
    expect(
      () => AccountSession.fromJson({...valid, 'csrf_token': 'browser-token'}),
      throwsFormatException,
    );
    expect(
      () => AccountSession.fromJson({...valid, 'extra': 'unexpected'}),
      throwsFormatException,
    );
  });
}
