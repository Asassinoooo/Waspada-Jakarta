import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'account_models.dart';
import 'public_api.dart' show ApiFailure, parseApiOrigin;

enum AccountApiFailureKind {
  configuration,
  network,
  unauthorized,
  rejected,
  payload,
}

class AccountApiFailure implements Exception {
  const AccountApiFailure(this.kind);
  final AccountApiFailureKind kind;
}

abstract interface class AccountApi {
  Future<AccountSession> getSession({String? bearerToken});
  Future<NativeSessionExchange> exchangeGoogleIdToken(String idToken);
  Future<AccountSession> completeOnboarding(String bearerToken);
  Future<void> logout(String bearerToken);
}

class HttpAccountApi implements AccountApi {
  HttpAccountApi({required Uri? origin, required http.Client httpClient})
    : _origin = origin,
      _httpClient = httpClient;

  factory HttpAccountApi.fromEnvironment({http.Client? httpClient}) {
    final raw = const String.fromEnvironment('API_ORIGIN');
    try {
      return HttpAccountApi(
        origin: parseApiOrigin(
          raw,
          debugBuild: false,
          allowInsecureDebugOrigin: false,
        ),
        httpClient: httpClient ?? http.Client(),
      );
    } on ApiFailure {
      return HttpAccountApi(
        origin: null,
        httpClient: httpClient ?? http.Client(),
      );
    }
  }

  final Uri? _origin;
  final http.Client _httpClient;

  @override
  Future<AccountSession> getSession({String? bearerToken}) async =>
      AccountSession.fromJson(
        await _jsonRequest(
          'GET',
          '/api/v1/auth/session',
          bearerToken: bearerToken,
        ),
      );

  @override
  Future<NativeSessionExchange> exchangeGoogleIdToken(String idToken) async {
    if (idToken.isEmpty ||
        idToken.length > 8192 ||
        idToken.contains(RegExp(r'[\s\u0000-\u001f\u007f]'))) {
      throw const AccountApiFailure(AccountApiFailureKind.payload);
    }
    return NativeSessionExchange.fromJson(
      await _jsonRequest(
        'POST',
        '/api/v1/auth/google/native',
        body: {'id_token': idToken},
      ),
    );
  }

  @override
  Future<AccountSession> completeOnboarding(String bearerToken) async =>
      AccountSession.fromJson(
        await _jsonRequest(
          'POST',
          '/api/v1/account/onboarding',
          bearerToken: bearerToken,
          body: const {'version': 1},
        ),
      );

  @override
  Future<void> logout(String bearerToken) async {
    final response = await _send(
      'POST',
      '/api/v1/auth/logout',
      bearerToken: bearerToken,
    );
    if (response.statusCode == 401 || response.statusCode == 403) {
      await _discard(response);
      throw const AccountApiFailure(AccountApiFailureKind.unauthorized);
    }
    if (response.statusCode != 204) {
      await _discard(response);
      throw const AccountApiFailure(AccountApiFailureKind.rejected);
    }
  }

  Future<Object?> _jsonRequest(
    String method,
    String path, {
    String? bearerToken,
    Map<String, Object?>? body,
  }) async {
    final response = await _send(
      method,
      path,
      bearerToken: bearerToken,
      body: body,
    );
    if (response.statusCode == 401 || response.statusCode == 403) {
      await _discard(response);
      throw const AccountApiFailure(AccountApiFailureKind.unauthorized);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await _discard(response);
      throw const AccountApiFailure(AccountApiFailureKind.rejected);
    }
    final contentType = response.headers['content-type']
        ?.split(';')
        .first
        .trim()
        .toLowerCase();
    if (contentType != 'application/json') {
      throw const AccountApiFailure(AccountApiFailureKind.payload);
    }
    final length = response.contentLength;
    const maxBytes = 64 * 1024;
    if (length != null && length > maxBytes) {
      throw const AccountApiFailure(AccountApiFailureKind.payload);
    }
    final bytes = BytesBuilder(copy: false);
    var count = 0;
    try {
      await for (final chunk in response.stream.timeout(
        const Duration(seconds: 18),
      )) {
        count += chunk.length;
        if (count > maxBytes) {
          throw const AccountApiFailure(AccountApiFailureKind.payload);
        }
        bytes.add(chunk);
      }
      return jsonDecode(utf8.decode(bytes.takeBytes(), allowMalformed: false));
    } on AccountApiFailure {
      rethrow;
    } catch (_) {
      throw const AccountApiFailure(AccountApiFailureKind.payload);
    }
  }

  Future<void> _discard(http.StreamedResponse response) async {
    try {
      await response.stream.timeout(const Duration(seconds: 18)).drain<void>();
    } catch (_) {
      // Error bodies are untrusted and intentionally discarded.
    }
  }

  Future<http.StreamedResponse> _send(
    String method,
    String path, {
    String? bearerToken,
    Map<String, Object?>? body,
  }) async {
    final origin = _origin;
    if (origin == null || !_safeOrigin(origin)) {
      throw const AccountApiFailure(AccountApiFailureKind.configuration);
    }
    if (bearerToken != null &&
        (bearerToken.length < 32 ||
            bearerToken.length > 512 ||
            bearerToken.contains(RegExp(r'[\s\u0000-\u001f\u007f]')))) {
      throw const AccountApiFailure(AccountApiFailureKind.payload);
    }
    final request = http.Request(method, origin.resolve(path))
      ..headers['accept'] = 'application/json'
      ..headers['cache-control'] = 'no-store'
      ..headers['pragma'] = 'no-cache'
      ..followRedirects = false
      ..maxRedirects = 0;
    if (bearerToken != null) {
      request.headers['authorization'] = 'Bearer $bearerToken';
    }
    if (body != null) {
      final encoded = utf8.encode(jsonEncode(body));
      final maximum = path == '/api/v1/auth/google/native'
          ? 16 * 1024
          : 4 * 1024;
      if (encoded.length > maximum) {
        throw const AccountApiFailure(AccountApiFailureKind.payload);
      }
      request
        ..headers['content-type'] = 'application/json'
        ..bodyBytes = encoded;
    }
    // Native requests intentionally have no Origin or Cookie header. No response
    // token or provider error is copied into an exception or a log.
    try {
      return await _httpClient
          .send(request)
          .timeout(const Duration(seconds: 18));
    } catch (_) {
      throw const AccountApiFailure(AccountApiFailureKind.network);
    }
  }

  bool _safeOrigin(Uri origin) {
    if (!origin.isAbsolute ||
        origin.host.isEmpty ||
        origin.userInfo.isNotEmpty ||
        origin.hasQuery ||
        origin.hasFragment ||
        (origin.path.isNotEmpty && origin.path != '/')) {
      return false;
    }
    if (origin.scheme == 'https') return true;
    return false;
  }
}
