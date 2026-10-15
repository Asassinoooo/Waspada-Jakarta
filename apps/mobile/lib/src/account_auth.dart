import 'package:flutter/foundation.dart';

import 'account_api.dart';
import 'account_models.dart';

const nativeSessionTokenStorageKey = 'waspada-jakarta:native-session:v1';

enum AccountAuthStatus {
  restoring,
  anonymous,
  authenticated,
  expired,
  offline,
  unavailable,
  error,
}

enum AccountAuthAction { none, signingIn, completingOnboarding, loggingOut }

abstract interface class SessionTokenStore {
  Future<String?> read();
  Future<void> write(String token);
  Future<void> clear();
}

abstract interface class GoogleIdentityProvider {
  bool get isConfigured;
  Future<String> authenticate();
  Future<void> signOut();
}

class GoogleIdentityCancelled implements Exception {
  const GoogleIdentityCancelled();
}

class GoogleIdentityUnavailable implements Exception {
  const GoogleIdentityUnavailable();
}

class AccountAuthController extends ChangeNotifier {
  AccountAuthController({
    required AccountApi api,
    required SessionTokenStore tokenStore,
    required GoogleIdentityProvider identityProvider,
    this.nativeSupported = true,
  }) : _api = api,
       _tokenStore = tokenStore,
       _identityProvider = identityProvider;

  AccountAuthController.guestOnly()
    : _api = null,
      _tokenStore = null,
      _identityProvider = null,
      nativeSupported = false;

  final AccountApi? _api;
  final SessionTokenStore? _tokenStore;
  final GoogleIdentityProvider? _identityProvider;
  final bool nativeSupported;

  AccountAuthStatus status = AccountAuthStatus.restoring;
  AccountAuthAction action = AccountAuthAction.none;
  AccountSession? session;
  String? message;
  String? _sessionToken;
  int _operation = 0;
  bool _disposed = false;

  AccountUser? get user => session?.user;
  bool get isBusy => action != AccountAuthAction.none;
  bool get isAuthenticated =>
      status == AccountAuthStatus.authenticated && user?.active == true;
  bool get needsOnboarding => isAuthenticated && user?.onboardingVersion == 0;
  bool get googleLoginAvailable =>
      nativeSupported &&
      (status == AccountAuthStatus.anonymous ||
          status == AccountAuthStatus.expired) &&
      session?.nativeLoginAvailable == true &&
      (_identityProvider?.isConfigured ?? false);

  String get loginUnavailableMessage {
    if (!nativeSupported) return 'Google login tersedia di aplikasi Android.';
    if (!(_identityProvider?.isConfigured ?? false)) {
      return 'Pengelola perlu menyiapkan konfigurasi Google untuk Android.';
    }
    if (session?.nativeLoginAvailable != true) {
      return 'Login akun sedang tidak tersedia. Kamu tetap dapat membaca tanpa akun.';
    }
    return '';
  }

  Future<void> restore() async {
    final operation = ++_operation;
    if (!nativeSupported) {
      _sessionToken = null;
      session = null;
      status = AccountAuthStatus.anonymous;
      action = AccountAuthAction.none;
      message = null;
      _notify();
      return;
    }
    action = AccountAuthAction.none;
    status = AccountAuthStatus.restoring;
    session = null;
    _sessionToken = null;
    message = null;
    action = AccountAuthAction.none;
    _notify();

    String? token;
    try {
      token = await _tokenStore!.read();
    } catch (_) {
      if (!_isCurrent(operation)) return;
      status = AccountAuthStatus.error;
      message = 'Sesi akun tidak dapat dibaca dari penyimpanan aman.';
      _notify();
      return;
    }
    if (!_isCurrent(operation)) return;
    if (token != null && !_validSessionToken(token)) {
      await _clearToken(operation);
      if (!_isCurrent(operation)) return;
      status = AccountAuthStatus.expired;
      message = 'Sesi akun perlu diperbarui. Masuk kembali untuk melanjutkan.';
      _notify();
      return;
    }
    _sessionToken = token;
    try {
      final result = await _api!.getSession(bearerToken: token);
      if (!_isCurrent(operation)) return;
      if (result.status == AccountSessionStatus.anonymous) {
        if (token != null) {
          await _clearToken(operation);
          if (!_isCurrent(operation)) return;
          status = AccountAuthStatus.expired;
          message = 'Sesi akun berakhir. Masuk kembali untuk melanjutkan.';
        } else {
          status = AccountAuthStatus.anonymous;
        }
        session = result;
      } else if (token == null || result.user?.active != true) {
        await _clearToken(operation);
        if (!_isCurrent(operation)) return;
        session = null;
        status = AccountAuthStatus.expired;
        message =
            'Sesi akun perlu diperbarui. Masuk kembali untuk melanjutkan.';
      } else {
        session = result;
        status = AccountAuthStatus.authenticated;
      }
    } on AccountApiFailure catch (failure) {
      if (!_isCurrent(operation)) return;
      if (failure.kind == AccountApiFailureKind.unauthorized && token != null) {
        await _clearToken(operation);
        if (!_isCurrent(operation)) return;
        session = null;
        status = AccountAuthStatus.expired;
        message = 'Sesi akun berakhir. Masuk kembali untuk melanjutkan.';
      } else {
        session = null;
        status = switch (failure.kind) {
          AccountApiFailureKind.configuration => AccountAuthStatus.unavailable,
          AccountApiFailureKind.network => AccountAuthStatus.offline,
          AccountApiFailureKind.unauthorized => AccountAuthStatus.anonymous,
          AccountApiFailureKind.rejected ||
          AccountApiFailureKind.payload => AccountAuthStatus.error,
        };
        message = _messageFor(failure.kind);
      }
    } catch (_) {
      if (!_isCurrent(operation)) return;
      session = null;
      status = AccountAuthStatus.error;
      message = 'Status akun belum dapat dibaca. Coba lagi nanti.';
    }
    _notify();
  }

  Future<void> signInWithGoogle() async {
    final api = _api;
    final tokenStore = _tokenStore;
    final identityProvider = _identityProvider;
    if (!nativeSupported ||
        api == null ||
        tokenStore == null ||
        identityProvider == null) {
      message = loginUnavailableMessage;
      _notify();
      return;
    }
    if (isAuthenticated) return;
    if (isBusy || !googleLoginAvailable) {
      if (!googleLoginAvailable) message = loginUnavailableMessage;
      _notify();
      return;
    }
    final operation = ++_operation;
    action = AccountAuthAction.signingIn;
    message = null;
    _notify();
    try {
      final idToken = await identityProvider.authenticate();
      if (!_isCurrent(operation)) return;
      final exchange = await api.exchangeGoogleIdToken(idToken);
      if (!_isCurrent(operation)) return;
      if (exchange.session.user?.active != true) {
        throw const AccountApiFailure(AccountApiFailureKind.payload);
      }
      try {
        await tokenStore.write(exchange.sessionToken);
      } catch (_) {
        try {
          await api.logout(exchange.sessionToken);
        } catch (_) {
          // A failed secure write must never leave a local reusable token.
        }
        if (!_isCurrent(operation)) return;
        status = AccountAuthStatus.error;
        action = AccountAuthAction.none;
        message = 'Sesi akun tidak dapat disimpan dengan aman di perangkat.';
        _notify();
        return;
      }
      if (!_isCurrent(operation)) return;
      _sessionToken = exchange.sessionToken;
      session = exchange.session;
      status = AccountAuthStatus.authenticated;
      action = AccountAuthAction.none;
      message = null;
      _notify();
    } on GoogleIdentityCancelled {
      if (!_isCurrent(operation)) return;
      action = AccountAuthAction.none;
      message = 'Masuk dengan Google dibatalkan.';
      _notify();
    } on GoogleIdentityUnavailable {
      if (!_isCurrent(operation)) return;
      action = AccountAuthAction.none;
      status = AccountAuthStatus.unavailable;
      message = 'Google login belum siap di perangkat ini.';
      _notify();
    } on AccountApiFailure catch (failure) {
      if (!_isCurrent(operation)) return;
      action = AccountAuthAction.none;
      if (failure.kind == AccountApiFailureKind.configuration) {
        status = AccountAuthStatus.unavailable;
      }
      message = _messageFor(failure.kind);
      _notify();
    } catch (_) {
      if (!_isCurrent(operation)) return;
      action = AccountAuthAction.none;
      message = 'Login belum berhasil. Coba lagi nanti.';
      _notify();
    }
  }

  Future<bool> completeOnboarding() async {
    final api = _api;
    final token = _sessionToken;
    if (!isAuthenticated || token == null || api == null || isBusy) {
      return false;
    }
    final operation = ++_operation;
    action = AccountAuthAction.completingOnboarding;
    message = null;
    _notify();
    try {
      final updated = await api.completeOnboarding(token);
      if (!_isCurrent(operation)) return false;
      if (updated.status != AccountSessionStatus.authenticated ||
          updated.user?.active != true) {
        await _expire(operation);
        return false;
      }
      session = updated;
      status = AccountAuthStatus.authenticated;
      action = AccountAuthAction.none;
      message = null;
      _notify();
      return updated.user!.onboardingComplete;
    } on AccountApiFailure catch (failure) {
      if (!_isCurrent(operation)) return false;
      action = AccountAuthAction.none;
      if (failure.kind == AccountApiFailureKind.unauthorized) {
        await _expire(operation);
      } else {
        if (failure.kind == AccountApiFailureKind.network) {
          status = AccountAuthStatus.offline;
        } else if (failure.kind == AccountApiFailureKind.configuration) {
          status = AccountAuthStatus.unavailable;
        }
        message = _messageFor(failure.kind);
        _notify();
      }
      return false;
    } catch (_) {
      if (!_isCurrent(operation)) return false;
      action = AccountAuthAction.none;
      message = 'Panduan akun belum dapat disimpan. Coba lagi nanti.';
      _notify();
      return false;
    }
  }

  Future<void> logout() async {
    final tokenStore = _tokenStore;
    final api = _api;
    if (!nativeSupported || tokenStore == null || api == null || isBusy) return;
    final operation = ++_operation;
    final token = _sessionToken;
    action = AccountAuthAction.loggingOut;
    message = null;
    _notify();
    var serverConfirmed = token == null;
    if (token != null) {
      try {
        await api.logout(token);
        serverConfirmed = true;
      } on AccountApiFailure catch (failure) {
        serverConfirmed = failure.kind == AccountApiFailureKind.unauthorized;
      } catch (_) {
        serverConfirmed = false;
      }
    }
    if (!_isCurrent(operation)) return;
    var localCleared = false;
    try {
      await tokenStore.clear();
      localCleared = true;
    } catch (_) {
      localCleared = false;
    }
    if (!_isCurrent(operation)) return;
    try {
      await _identityProvider?.signOut();
    } catch (_) {
      // Clearing the app session does not depend on clearing the provider UI.
    }
    if (!_isCurrent(operation)) return;
    _sessionToken = null;
    session = null;
    action = AccountAuthAction.none;
    if (localCleared) {
      status = AccountAuthStatus.anonymous;
      message = serverConfirmed
          ? 'Perangkat ini telah keluar dari akun.'
          : 'Perangkat ini telah keluar. Layanan belum mengonfirmasi pencabutan sesi.';
    } else {
      status = AccountAuthStatus.error;
      message = 'Token sesi tidak dapat dihapus dari penyimpanan aman.';
    }
    _notify();
  }

  Future<void> retry() => restore();

  Future<bool> _expire(int operation) async {
    await _clearToken(operation);
    if (!_isCurrent(operation)) return false;
    _sessionToken = null;
    session = null;
    action = AccountAuthAction.none;
    status = AccountAuthStatus.expired;
    message = 'Sesi akun berakhir. Masuk kembali untuk melanjutkan.';
    _notify();
    return false;
  }

  Future<void> _clearToken(int operation) async {
    if (!_isCurrent(operation)) return;
    try {
      await _tokenStore?.clear();
    } catch (_) {
      // The UI remains signed out; the next restore will fail closed again.
    }
    if (_isCurrent(operation)) _sessionToken = null;
  }

  bool _validSessionToken(String token) =>
      token.length >= 32 &&
      token.length <= 512 &&
      !token.contains(RegExp(r'[\s\u0000-\u001f\u007f]'));

  bool _isCurrent(int operation) => !_disposed && operation == _operation;

  String _messageFor(AccountApiFailureKind kind) => switch (kind) {
    AccountApiFailureKind.configuration =>
      'Akun belum tersedia karena konfigurasi layanan belum siap.',
    AccountApiFailureKind.network =>
      'Layanan akun belum dapat dijangkau. Periksa koneksi lalu coba lagi.',
    AccountApiFailureKind.unauthorized =>
      'Sesi akun perlu diperbarui. Masuk kembali untuk melanjutkan.',
    AccountApiFailureKind.rejected =>
      'Layanan akun belum dapat menyelesaikan permintaan. Coba lagi nanti.',
    AccountApiFailureKind.payload =>
      'Respons akun tidak dapat dibaca dengan aman. Coba lagi nanti.',
  };

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _operation++;
    super.dispose();
  }
}
