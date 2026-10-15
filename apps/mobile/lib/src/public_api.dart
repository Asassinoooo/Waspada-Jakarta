import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'public_models.dart';

enum ApiFailureKind { configuration, network, http, notFound, payload }

class ApiFailure implements Exception {
  const ApiFailure(this.kind, {this.statusCode});
  final ApiFailureKind kind;
  final int? statusCode;

  String get userMessage => switch (kind) {
        ApiFailureKind.configuration =>
          'Alamat API belum disetel dengan benar. Minta pengelola menyiapkan origin HTTPS, lalu coba lagi.',
        ApiFailureKind.network =>
          'Layanan belum dapat dijangkau. Periksa koneksi lalu coba lagi.',
        ApiFailureKind.http => statusCode == 429
            ? 'Permintaan sedang dibatasi. Tunggu sebentar lalu coba lagi.'
            : 'Layanan belum dapat memuat informasi. Coba lagi nanti.',
        ApiFailureKind.notFound =>
          'Laporan atau riwayat ini tidak tersedia pada dataset yang dipilih.',
        ApiFailureKind.payload =>
          'Respons layanan tidak dapat dibaca dengan aman. Coba lagi nanti.',
      };
}

abstract interface class PublicApi {
  Future<PublicContext> getContext();
  Future<EventPage> listEvents(EventQuery query);
  Future<EventDetail> getEventDetail(String eventId);
  Future<HistoryPage> getEventHistory(String eventId, {String? cursor});
}

class EventQuery {
  const EventQuery(
      {this.category,
      this.lifecycle,
      this.freshness,
      this.search,
      this.cursor});
  final EventCategory? category;
  final EventLifecycle? lifecycle;
  final FreshnessStatus? freshness;
  final String? search;
  final String? cursor;

  Map<String, String> toQueryParameters() {
    final result = <String, String>{'limit': '20'};
    if (category != null) result['category'] = category!.wireValue;
    if (lifecycle != null) result['lifecycle'] = lifecycle!.wireValue;
    if (freshness != null) result['freshness'] = freshness!.wireValue;
    final q = search?.trim();
    if (q != null && q.isNotEmpty) result['q'] = q;
    if (cursor != null) result['cursor'] = cursor!;
    return result;
  }
}

Uri? parseApiOrigin(
  String raw, {
  required bool debugBuild,
  bool allowInsecureDebugOrigin = false,
}) {
  final text = raw.trim();
  if (text.isEmpty) return null;
  final uri = Uri.tryParse(text);
  if (uri == null ||
      !uri.isAbsolute ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment) {
    throw const ApiFailure(ApiFailureKind.configuration);
  }
  if (uri.path.isNotEmpty && uri.path != '/') {
    throw const ApiFailure(ApiFailureKind.configuration);
  }
  final isSecure = uri.scheme == 'https';
  final localHosts = {'localhost', '127.0.0.1', '10.0.2.2'};
  final isAllowedDebugHttp = debugBuild &&
      allowInsecureDebugOrigin &&
      uri.scheme == 'http' &&
      localHosts.contains(uri.host);
  if (!isSecure && !isAllowedDebugHttp) {
    throw const ApiFailure(ApiFailureKind.configuration);
  }
  return uri.replace(path: '', query: null, fragment: null);
}

class HttpPublicApi implements PublicApi {
  HttpPublicApi({required Uri? origin, required http.Client httpClient})
      : _origin = origin,
        _httpClient = httpClient;

  factory HttpPublicApi.fromEnvironment({http.Client? httpClient}) {
    final raw = const String.fromEnvironment('API_ORIGIN');
    final allowLocalHttp =
        const bool.fromEnvironment('ALLOW_INSECURE_DEBUG_ORIGIN');
    try {
      return HttpPublicApi(
        origin: parseApiOrigin(raw,
            debugBuild: kDebugMode, allowInsecureDebugOrigin: allowLocalHttp),
        httpClient: httpClient ?? http.Client(),
      );
    } on ApiFailure {
      return HttpPublicApi(
          origin: null, httpClient: httpClient ?? http.Client());
    }
  }

  final Uri? _origin;
  final http.Client _httpClient;

  Uri _uri(String path, [Map<String, String>? query]) {
    final origin = _origin;
    if (origin == null) throw const ApiFailure(ApiFailureKind.configuration);
    final suffix = query == null || query.isEmpty
        ? ''
        : '?${Uri(queryParameters: query).query}';
    return Uri.parse('${origin.scheme}://${origin.authority}$path$suffix');
  }

  Future<Object?> _get(String path, [Map<String, String>? query]) async {
    final uri = _uri(path, query);
    final request = http.Request('GET', uri)
      ..headers['accept'] = 'application/json'
      ..headers['cache-control'] = 'no-store';
    late final http.StreamedResponse response;
    try {
      response =
          await _httpClient.send(request).timeout(const Duration(seconds: 18));
    } on ApiFailure {
      rethrow;
    } catch (_) {
      throw const ApiFailure(ApiFailureKind.network);
    }
    if (response.statusCode == 404) {
      throw const ApiFailure(ApiFailureKind.notFound);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiFailure(ApiFailureKind.http, statusCode: response.statusCode);
    }
    final contentType =
        response.headers['content-type']?.split(';').first.trim().toLowerCase();
    if (contentType != 'application/json') {
      throw const ApiFailure(ApiFailureKind.payload);
    }
    final length = response.contentLength;
    const maxBytes = 2 * 1024 * 1024;
    if (length != null && length > maxBytes) {
      throw const ApiFailure(ApiFailureKind.payload);
    }
    final builder = BytesBuilder(copy: false);
    var byteCount = 0;
    try {
      await for (final chunk
          in response.stream.timeout(const Duration(seconds: 18))) {
        byteCount += chunk.length;
        if (byteCount > maxBytes) {
          throw const ApiFailure(ApiFailureKind.payload);
        }
        builder.add(chunk);
      }
      final text = utf8.decode(builder.takeBytes(), allowMalformed: false);
      return jsonDecode(text);
    } on ApiFailure {
      rethrow;
    } catch (_) {
      throw const ApiFailure(ApiFailureKind.payload);
    }
  }

  T _parse<T>(Object? body, T Function(Object?) parse) {
    try {
      return parse(body);
    } on ContractViolation {
      throw const ApiFailure(ApiFailureKind.payload);
    } catch (_) {
      throw const ApiFailure(ApiFailureKind.payload);
    }
  }

  @override
  Future<PublicContext> getContext() async =>
      _parse(await _get('/api/v1/context'), PublicContext.fromJson);

  @override
  Future<EventPage> listEvents(EventQuery query) async {
    final cursor = query.cursor;
    if (cursor != null && (cursor.isEmpty || cursor.length > 2048)) {
      throw const ApiFailure(ApiFailureKind.payload);
    }
    final search = query.search?.trim();
    if (search != null && search.length > 120) {
      throw const ApiFailure(ApiFailureKind.payload);
    }
    return _parse(await _get('/api/v1/events', query.toQueryParameters()),
        EventPage.fromJson);
  }

  @override
  Future<EventDetail> getEventDetail(String eventId) async {
    if (eventId.isEmpty || eventId.length > 128) {
      throw const ApiFailure(ApiFailureKind.payload);
    }
    final detail = _parse(
        await _get('/api/v1/events/${Uri.encodeComponent(eventId)}'),
        EventDetail.fromJson);
    if (detail.id != eventId) throw const ApiFailure(ApiFailureKind.payload);
    return detail;
  }

  @override
  Future<HistoryPage> getEventHistory(String eventId, {String? cursor}) async {
    if (eventId.isEmpty ||
        eventId.length > 128 ||
        cursor != null && (cursor.isEmpty || cursor.length > 2048)) {
      throw const ApiFailure(ApiFailureKind.payload);
    }
    final query = <String, String>{'limit': '20'};
    if (cursor != null) query['cursor'] = cursor;
    final history = _parse(
        await _get(
            '/api/v1/events/${Uri.encodeComponent(eventId)}/history', query),
        HistoryPage.fromJson);
    if (history.data.any((entry) => entry.eventId != eventId)) {
      throw const ApiFailure(ApiFailureKind.payload);
    }
    return history;
  }
}
