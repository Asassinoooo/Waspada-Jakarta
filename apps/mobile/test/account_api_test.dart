import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:waspada_jakarta_mobile/src/account_api.dart';

Map<String, Object?> _user({int onboardingVersion = 0}) => {
  'id': 'account-fixture-1',
  'display_name': 'Pengguna Contoh',
  'email': 'person@example.invalid',
  'role': 'user',
  'active': true,
  'onboarding_version': onboardingVersion,
  'onboarding_completed_at': onboardingVersion == 0
      ? null
      : '2026-10-15T02:00:00Z',
  'version': 1,
};

Map<String, Object?> _session({
  required String status,
  int onboardingVersion = 0,
}) => {
  'version': 'account-v1',
  'status': status,
  'google_login_available': true,
  'native_login_available': true,
  'csrf_token': null,
  'user': status == 'authenticated'
      ? _user(onboardingVersion: onboardingVersion)
      : null,
};

http.Response _json(Object body, {int status = 200}) => http.Response(
  jsonEncode(body),
  status,
  headers: const {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
);

void main() {
  test(
    'native account calls use exact routes and bearer-only requests',
    () async {
      final requests = <http.Request>[];
      final client = MockClient((request) async {
        requests.add(request);
        return switch (request.url.path) {
          '/api/v1/auth/google/native' => _json({
            'session_token': List.filled(48, 's').join(),
            'session': _session(status: 'authenticated'),
          }),
          '/api/v1/auth/session' => _json(_session(status: 'authenticated')),
          '/api/v1/account/onboarding' => _json(
            _session(status: 'authenticated', onboardingVersion: 1),
          ),
          '/api/v1/auth/logout' => http.Response('', 204),
          _ => http.Response('', 404),
        };
      });
      final api = HttpAccountApi(
        origin: Uri.https('api.example.invalid', ''),
        httpClient: client,
      );
      final token = List.filled(48, 's').join();

      final exchange = await api.exchangeGoogleIdToken(
        'header.payload.signature',
      );
      final restored = await api.getSession(bearerToken: token);
      final completed = await api.completeOnboarding(token);
      await api.logout(token);

      expect(exchange.sessionToken, token);
      expect(restored.user?.role.name, 'user');
      expect(completed.user?.onboardingVersion, 1);
      expect(requests.map((request) => request.url.path), [
        '/api/v1/auth/google/native',
        '/api/v1/auth/session',
        '/api/v1/account/onboarding',
        '/api/v1/auth/logout',
      ]);
      expect(jsonDecode(requests[0].body), {
        'id_token': 'header.payload.signature',
      });
      expect(requests[0].headers['authorization'], isNull);
      expect(jsonDecode(requests[2].body), {'version': 1});
      expect(requests[3].body, isEmpty);
      for (final request in requests) {
        expect(request.headers['origin'], isNull);
        expect(request.headers['cookie'], isNull);
        expect(request.headers['cache-control'], 'no-store');
        expect(request.headers['pragma'], 'no-cache');
        expect(request.followRedirects, isFalse);
        expect(request.maxRedirects, 0);
      }
      expect(requests[1].headers['authorization'], 'Bearer $token');
      expect(requests[2].headers['authorization'], 'Bearer $token');
      expect(requests[3].headers['authorization'], 'Bearer $token');
    },
  );

  test(
    'native account endpoints reject 307 and 308 without following them',
    () async {
      for (final status in [307, 308]) {
        final requests = <http.Request>[];
        final api = HttpAccountApi(
          origin: Uri.https('api.example.invalid', ''),
          httpClient: MockClient((request) async {
            requests.add(request);
            return http.Response(
              '',
              status,
              headers: const {
                'location': 'https://redirect.example.invalid/collect',
              },
            );
          }),
        );

        await expectLater(
          api.exchangeGoogleIdToken('header.payload.signature'),
          throwsA(
            isA<AccountApiFailure>().having(
              (failure) => failure.kind,
              'kind',
              AccountApiFailureKind.rejected,
            ),
          ),
        );
        expect(requests, hasLength(1));
        expect(requests.single.followRedirects, isFalse);
      }
    },
  );

  test(
    'native account API rejects cleartext origins, including debug hosts',
    () async {
      var sent = false;
      final api = HttpAccountApi(
        origin: Uri.http('10.0.2.2:8787', ''),
        httpClient: MockClient((_) async {
          sent = true;
          return _json(_session(status: 'anonymous'));
        }),
      );

      await expectLater(
        api.exchangeGoogleIdToken('header.payload.signature'),
        throwsA(
          isA<AccountApiFailure>().having(
            (failure) => failure.kind,
            'kind',
            AccountApiFailureKind.configuration,
          ),
        ),
      );
      expect(sent, isFalse);
    },
  );

  test(
    'provider and server errors are discarded from safe client failures',
    () async {
      final client = MockClient(
        (_) async => http.Response(
          'private provider diagnostic and email@example.com',
          502,
          headers: const {'content-type': 'text/plain'},
        ),
      );
      final api = HttpAccountApi(
        origin: Uri.https('api.example.invalid', ''),
        httpClient: client,
      );

      try {
        await api.exchangeGoogleIdToken('header.payload.signature');
        fail('Expected a safe account API failure.');
      } on AccountApiFailure catch (error) {
        expect(error.kind, AccountApiFailureKind.rejected);
        expect(
          error.toString(),
          isNot(contains('private provider diagnostic')),
        );
        expect(error.toString(), isNot(contains('email@example.invalid')));
      }
    },
  );
}
