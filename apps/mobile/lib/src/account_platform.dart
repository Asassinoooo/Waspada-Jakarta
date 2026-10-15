import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:google_sign_in/google_sign_in.dart';

import 'account_api.dart';
import 'account_auth.dart';

class FlutterSecureSessionTokenStore implements SessionTokenStore {
  FlutterSecureSessionTokenStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read() => _storage.read(key: nativeSessionTokenStorageKey);

  @override
  Future<void> write(String token) =>
      _storage.write(key: nativeSessionTokenStorageKey, value: token);

  @override
  Future<void> clear() => _storage.delete(key: nativeSessionTokenStorageKey);
}

class GoogleSdkIdentityProvider implements GoogleIdentityProvider {
  GoogleSdkIdentityProvider({required this.serverClientId});

  final String serverClientId;
  final GoogleSignIn _google = GoogleSignIn.instance;
  Future<void>? _initialization;

  @override
  bool get isConfigured => serverClientId.trim().isNotEmpty;

  @override
  Future<String> authenticate() async {
    if (!isConfigured) throw const GoogleIdentityUnavailable();
    try {
      await (_initialization ??= _google.initialize(
        serverClientId: serverClientId.trim(),
      ));
      if (!_google.supportsAuthenticate()) {
        throw const GoogleIdentityUnavailable();
      }
      final account = await _google.authenticate();
      final idToken = account.authentication.idToken;
      if (idToken == null || idToken.isEmpty || idToken.length > 8192) {
        throw const GoogleIdentityUnavailable();
      }
      return idToken;
    } on GoogleSignInException catch (error) {
      if (error.code == GoogleSignInExceptionCode.canceled) {
        throw const GoogleIdentityCancelled();
      }
      throw const GoogleIdentityUnavailable();
    } on GoogleIdentityUnavailable {
      rethrow;
    } catch (_) {
      throw const GoogleIdentityUnavailable();
    }
  }

  @override
  Future<void> signOut() async {
    try {
      await _google.signOut();
    } catch (_) {
      // The app session is cleared independently from Google's account chooser.
    }
  }
}

AccountAuthController createPlatformAccountAuthController() {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) {
    return AccountAuthController.guestOnly();
  }
  return AccountAuthController(
    api: HttpAccountApi.fromEnvironment(),
    tokenStore: FlutterSecureSessionTokenStore(),
    identityProvider: GoogleSdkIdentityProvider(
      serverClientId: const String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID'),
    ),
  );
}
