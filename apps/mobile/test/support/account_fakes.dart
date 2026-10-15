import 'dart:async';

import 'package:waspada_jakarta_mobile/src/account_api.dart';
import 'package:waspada_jakarta_mobile/src/account_auth.dart';
import 'package:waspada_jakarta_mobile/src/account_models.dart';

class MemorySecureTokenStore implements SessionTokenStore {
  String? token;
  bool failReads = false;
  bool failWrites = false;
  bool failClears = false;
  int readCalls = 0;
  int writeCalls = 0;
  int clearCalls = 0;

  @override
  Future<String?> read() async {
    readCalls++;
    if (failReads) throw StateError('synthetic secure read failure');
    return token;
  }

  @override
  Future<void> write(String value) async {
    writeCalls++;
    if (failWrites) throw StateError('synthetic secure write failure');
    token = value;
  }

  @override
  Future<void> clear() async {
    clearCalls++;
    if (failClears) throw StateError('synthetic secure clear failure');
    token = null;
  }
}

class FakeGoogleIdentityProvider implements GoogleIdentityProvider {
  bool configured = true;
  String idToken = 'synthetic-google-id-token';
  Object? authenticateFailure;
  int authenticateCalls = 0;
  int signOutCalls = 0;

  @override
  bool get isConfigured => configured;

  @override
  Future<String> authenticate() async {
    authenticateCalls++;
    final failure = authenticateFailure;
    if (failure != null) throw failure;
    return idToken;
  }

  @override
  Future<void> signOut() async {
    signOutCalls++;
  }
}

class FakeAccountApi implements AccountApi {
  AccountSession session = anonymousAccountSession();
  AccountSession? onboardingResult;
  NativeSessionExchange exchangeResult = NativeSessionExchange(
    sessionToken: List.filled(48, 's').join(),
    session: authenticatedAccountSession(),
  );
  AccountApiFailure? sessionFailure;
  AccountApiFailure? exchangeFailure;
  AccountApiFailure? onboardingFailure;
  AccountApiFailure? logoutFailure;
  final List<String?> sessionBearerTokens = [];
  final List<String> onboardingBearerTokens = [];
  final List<String> logoutBearerTokens = [];
  final List<String> receivedGoogleIdTokens = [];
  final List<Future<AccountSession> Function()> sessionReplies = [];
  int onboardingCalls = 0;
  int exchangeCalls = 0;

  @override
  Future<AccountSession> getSession({String? bearerToken}) {
    sessionBearerTokens.add(bearerToken);
    if (sessionReplies.isNotEmpty) return sessionReplies.removeAt(0)();
    final failure = sessionFailure;
    if (failure != null) return Future<AccountSession>.error(failure);
    return Future<AccountSession>.value(session);
  }

  @override
  Future<NativeSessionExchange> exchangeGoogleIdToken(String idToken) {
    exchangeCalls++;
    receivedGoogleIdTokens.add(idToken);
    final failure = exchangeFailure;
    if (failure != null) return Future<NativeSessionExchange>.error(failure);
    return Future<NativeSessionExchange>.value(exchangeResult);
  }

  @override
  Future<AccountSession> completeOnboarding(String bearerToken) {
    onboardingCalls++;
    onboardingBearerTokens.add(bearerToken);
    final failure = onboardingFailure;
    if (failure != null) return Future<AccountSession>.error(failure);
    return Future<AccountSession>.value(
      onboardingResult ?? authenticatedAccountSession(onboardingVersion: 1),
    );
  }

  @override
  Future<void> logout(String bearerToken) {
    logoutBearerTokens.add(bearerToken);
    final failure = logoutFailure;
    if (failure != null) return Future<void>.error(failure);
    return Future<void>.value();
  }
}

AccountUser accountUser({
  AccountRole role = AccountRole.user,
  int onboardingVersion = 0,
  bool active = true,
}) => AccountUser(
  id: 'account-fixture-1',
  displayName: 'Pengguna Contoh',
  email: 'person@example.invalid',
  role: role,
  active: active,
  onboardingVersion: onboardingVersion,
  onboardingCompletedAt: onboardingVersion == 0
      ? null
      : DateTime.parse('2026-10-15T02:00:00Z'),
  version: 1,
);

AccountSession anonymousAccountSession({bool nativeLoginAvailable = true}) =>
    AccountSession(
      status: AccountSessionStatus.anonymous,
      googleLoginAvailable: true,
      nativeLoginAvailable: nativeLoginAvailable,
      user: null,
    );

AccountSession authenticatedAccountSession({
  AccountRole role = AccountRole.user,
  int onboardingVersion = 0,
  bool active = true,
}) => AccountSession(
  status: AccountSessionStatus.authenticated,
  googleLoginAvailable: true,
  nativeLoginAvailable: true,
  user: accountUser(
    role: role,
    onboardingVersion: onboardingVersion,
    active: active,
  ),
);
