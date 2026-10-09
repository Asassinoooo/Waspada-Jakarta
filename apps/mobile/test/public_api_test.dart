import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:waspada_jakarta_mobile/src/public_api.dart';
import 'package:waspada_jakarta_mobile/src/public_models.dart';

import 'support/fakes.dart';

void main() {
  test('freshness labels distinguish review from source validity expiry', () {
    expect(FreshnessStatus.needsUpdate.label, 'Perlu diperbarui');
    expect(FreshnessStatus.expired.label, 'Masa berlaku sumber berakhir');
  });

  test('date and timestamp parsing rejects impossible calendar components', () {
    expect(
      () => PublicContext.fromJson({
        ...syntheticContext,
        'generated_at': '2026-02-31T09:00:00Z',
      }),
      throwsA(isA<ContractViolation>()),
    );
    expect(
      () => TimeScope.fromJson({
        'start': '2026-02-31',
        'end': null,
        'precision': 'date',
      }),
      throwsA(isA<ContractViolation>()),
    );
    expect(
      () => TimeScope.fromJson({
        'start': '2026-02-28T24:00:00Z',
        'end': null,
        'precision': 'exact',
      }),
      throwsA(isA<ContractViolation>()),
    );
  });

  group('API origin', () {
    test('missing origin stays unconfigured and HTTPS origin is accepted', () {
      expect(parseApiOrigin('', debugBuild: false), isNull);
      expect(parseApiOrigin('https://api.example.invalid', debugBuild: false),
          Uri.parse('https://api.example.invalid'));
    });

    test('insecure origins are limited to explicitly enabled local debug hosts',
        () {
      expect(
          () => parseApiOrigin('http://example.invalid',
              debugBuild: true, allowInsecureDebugOrigin: true),
          throwsA(isA<ApiFailure>()));
      expect(
          () => parseApiOrigin('http://10.0.2.2:8787',
              debugBuild: false, allowInsecureDebugOrigin: true),
          throwsA(isA<ApiFailure>()));
      expect(
          parseApiOrigin('http://10.0.2.2:8787',
              debugBuild: true, allowInsecureDebugOrigin: true),
          Uri.parse('http://10.0.2.2:8787'));
      expect(
          () => parseApiOrigin('https://user:pass@example.invalid',
              debugBuild: false),
          throwsA(isA<ApiFailure>()));
    });
  });

  test('list read uses existing bounded public endpoint and documented filters',
      () async {
    late http.Request seen;
    final client = MockClient((request) async {
      seen = request;
      return http.Response(jsonEncode(syntheticEventPage), 200,
          headers: {'content-type': 'application/json; charset=utf-8'});
    });
    final api = HttpPublicApi(
        origin: Uri.parse('https://api.example.invalid'), httpClient: client);
    final page = await api.listEvents(const EventQuery(
        category: EventCategory.transportRoadIncidents,
        lifecycle: EventLifecycle.planned,
        search: 'bus Jakarta'));

    expect(seen.url.path, '/api/v1/events');
    expect(seen.url.queryParameters, {
      'limit': '20',
      'category': 'transport_road_incidents',
      'lifecycle': 'planned',
      'q': 'bus Jakarta'
    });
    expect(seen.headers['cache-control'], 'no-store');
    expect(page.data.single.title, 'Contoh sintetis: perubahan layanan fiktif');
  });

  test(
      'context and detail/history use exact public endpoints and safe encoded identifiers',
      () async {
    final requests = <Uri>[];
    final client = MockClient((request) async {
      requests.add(request.url);
      if (request.url.path == '/api/v1/context') {
        return http.Response(jsonEncode(syntheticContext), 200,
            headers: {'content-type': 'application/json'});
      }
      if (request.url.path == '/api/v1/events/one%2Ftwo') {
        return http.Response(
            jsonEncode({...syntheticEventDetail, 'event_id': 'one/two'}), 200,
            headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode(syntheticHistoryPage), 200,
          headers: {'content-type': 'application/json'});
    });
    final api = HttpPublicApi(
        origin: Uri.parse('https://api.example.invalid'), httpClient: client);
    expect((await api.getContext()).datasetMode, DatasetMode.demo);
    expect((await api.getEventDetail('one/two')).id, 'one/two');
    expect((await api.getEventHistory('one/two')).data, isEmpty);
    expect(requests.map((uri) => uri.path), [
      '/api/v1/context',
      '/api/v1/events/one%2Ftwo',
      '/api/v1/events/one%2Ftwo/history',
    ]);
    expect(requests.last.queryParameters, {'limit': '20'});
  });

  test('detail and history reject records that belong to another event',
      () async {
    final mismatchDetail = HttpPublicApi(
      origin: Uri.parse('https://api.example.invalid'),
      httpClient: MockClient((_) async => http.Response(
          jsonEncode({...syntheticEventDetail, 'event_id': 'other-event'}), 200,
          headers: {'content-type': 'application/json'})),
    );
    await expectLater(
        mismatchDetail.getEventDetail('requested-event'),
        throwsA(isA<ApiFailure>()
            .having((error) => error.kind, 'kind', ApiFailureKind.payload)));

    final mismatchHistory = HttpPublicApi(
      origin: Uri.parse('https://api.example.invalid'),
      httpClient: MockClient((_) async => http.Response(
          jsonEncode({
            'data': [
              {
                'event_id': 'other-event',
                'version': 1,
                'change_type': 'corrected',
                'changed_at': '2026-09-24T09:15:00+07:00',
                'summary': 'Fixture mismatch.'
              }
            ],
            'page': {'next_cursor': null, 'cursor_expires_at': null}
          }),
          200,
          headers: {'content-type': 'application/json'})),
    );
    await expectLater(
        mismatchHistory.getEventHistory('requested-event'),
        throwsA(isA<ApiFailure>()
            .having((error) => error.kind, 'kind', ApiFailureKind.payload)));
  });

  test(
      'unknown dataset mode and unknown category are treated as unreadable payloads',
      () async {
    final contextApi = HttpPublicApi(
      origin: Uri.parse('https://api.example.invalid'),
      httpClient: MockClient((_) async => http.Response(
          jsonEncode({...syntheticContext, 'dataset_mode': 'preview'}), 200,
          headers: {'content-type': 'application/json'})),
    );
    await expectLater(
        contextApi.getContext(),
        throwsA(isA<ApiFailure>()
            .having((error) => error.kind, 'kind', ApiFailureKind.payload)));

    final unknownCategory = <String, Object?>{
      ...syntheticEvent,
      'category': 'danger_score'
    };
    final pageApi = HttpPublicApi(
      origin: Uri.parse('https://api.example.invalid'),
      httpClient: MockClient((_) async => http.Response(
          jsonEncode({
            'data': [unknownCategory],
            'page': {'next_cursor': null, 'cursor_expires_at': null}
          }),
          200,
          headers: {'content-type': 'application/json'})),
    );
    await expectLater(
        pageApi.listEvents(const EventQuery()),
        throwsA(isA<ApiFailure>()
            .having((error) => error.kind, 'kind', ApiFailureKind.payload)));
  });

  test(
      'empty event page is valid and a failed response never exposes its raw body',
      () async {
    final emptyApi = HttpPublicApi(
      origin: Uri.parse('https://api.example.invalid'),
      httpClient: MockClient((_) async => http.Response(
          '{"data":[],"page":{"next_cursor":null,"cursor_expires_at":null}}',
          200,
          headers: {'content-type': 'application/json'})),
    );
    expect((await emptyApi.listEvents(const EventQuery())).data, isEmpty);

    final failedApi = HttpPublicApi(
      origin: Uri.parse('https://api.example.invalid'),
      httpClient: MockClient((_) async => http.Response(
          'private diagnostic marker', 503,
          headers: {'content-type': 'text/plain'})),
    );
    try {
      await failedApi.getContext();
      fail('expected an API error');
    } on ApiFailure catch (error) {
      expect(error.kind, ApiFailureKind.http);
      expect(error.userMessage, isNot(contains('private diagnostic marker')));
    }
  });
}
