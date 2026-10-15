import 'package:waspada_jakarta_mobile/src/preferences.dart';
import 'package:waspada_jakarta_mobile/src/public_api.dart';
import 'package:waspada_jakarta_mobile/src/public_models.dart';

class MemoryStorage implements KeyValueStorage {
  final values = <String, String>{};
  bool failReads = false;
  bool failWrites = false;
  bool failRemove = false;
  bool ignoreRemove = false;
  @override
  Future<String?> getString(String key) async {
    if (failReads) throw StateError('synthetic read failure');
    return values[key];
  }

  @override
  Future<bool> setString(String key, String value) async {
    if (failWrites) throw StateError('synthetic write failure');
    values[key] = value;
    return true;
  }

  @override
  Future<bool> remove(String key) async {
    if (failRemove) throw StateError('synthetic remove failure');
    if (!ignoreRemove) values.remove(key);
    return true;
  }
}

class SyntheticPublicApi implements PublicApi {
  SyntheticPublicApi(
      {PublicContext? context,
      EventPage? events,
      EventDetail? detail,
      HistoryPage? history,
      this.contextFailure,
      this.pageFailure,
      this.detailFailure,
      this.historyFailure})
      : context = context ?? PublicContext.fromJson(syntheticContext),
        events = events ?? EventPage.fromJson(syntheticEventPage),
        detail = detail ?? EventDetail.fromJson(syntheticEventDetail),
        history = history ?? HistoryPage.fromJson(syntheticHistoryPage);

  final PublicContext context;
  final EventPage events;
  final EventDetail detail;
  final HistoryPage history;
  final ApiFailure? contextFailure;
  final ApiFailure? pageFailure;
  final ApiFailure? detailFailure;
  final ApiFailure? historyFailure;
  int contextCalls = 0;
  int pageCalls = 0;
  int detailCalls = 0;
  int historyCalls = 0;

  @override
  Future<PublicContext> getContext() async {
    contextCalls++;
    if (contextFailure != null) throw contextFailure!;
    return context;
  }

  @override
  Future<EventPage> listEvents(EventQuery query) async {
    pageCalls++;
    if (pageFailure != null) throw pageFailure!;
    return events;
  }

  @override
  Future<EventDetail> getEventDetail(String eventId) async {
    detailCalls++;
    if (detailFailure != null) throw detailFailure!;
    return detail;
  }

  @override
  Future<HistoryPage> getEventHistory(String eventId, {String? cursor}) async {
    historyCalls++;
    if (historyFailure != null) throw historyFailure!;
    return history;
  }
}

const syntheticContext = <String, Object?>{
  'dataset_mode': 'demo',
  'dataset_label': 'synthetic',
  'generated_at': '2026-09-24T09:15:00+07:00',
  'sources': [
    {
      'display_name': 'Penyedia fiksi',
      'health': 'unknown',
      'last_success_at': null
    },
  ],
};

const syntheticEvent = <String, Object?>{
  'event_id': 'synthetic-event-1',
  'version': 1,
  'title': 'Contoh sintetis: perubahan layanan fiktif',
  'summary':
      'Fixture otomatis; bukan laporan aktual dan bukan kondisi Jakarta.',
  'category': 'transport_road_incidents',
  'tags': [],
  'lifecycle': 'planned',
  'freshness': {
    'status': 'current',
    'evaluated_at': '2026-09-24T09:10:00+07:00',
    'review_due_at': '2026-09-24T10:00:00+07:00',
    'basis': 'manual_review'
  },
  'event_time': {
    'start': '2026-09-24T10:00:00+07:00',
    'end': null,
    'precision': 'exact'
  },
  'validity': {
    'valid_from': '2026-09-24T09:00:00+07:00',
    'valid_until': '2026-09-24T11:00:00+07:00'
  },
  'scope': {
    'places': ['Tempat Fiktif'],
    'services': [],
    'institutions': [],
    'audiences': []
  },
  'claims': [
    {
      'claim_id': 'synthetic-claim-1',
      'text': 'Klaim contoh sintetis tanpa dampak aktual.',
      'event_time': {
        'start': '2026-09-24T10:00:00+07:00',
        'end': null,
        'precision': 'exact'
      },
      'validity': {
        'valid_from': '2026-09-24T09:00:00+07:00',
        'valid_until': '2026-09-24T11:00:00+07:00'
      },
      'scope': {
        'places': ['Tempat Fiktif'],
        'services': [],
        'institutions': [],
        'audiences': []
      },
      'qualifiers': ['Contoh sintetis; bukan informasi terkini.'],
      'evidence_label': 'crowdsourced_observation',
      'sources': [
        {
          'display_name': 'Sumber fiksi',
          'url': 'https://example.invalid/synthetic-event-1',
          'published_at': '2026-09-24T09:00:00+07:00',
          'observed_at': '2026-09-24T08:55:00+07:00',
          'excerpt': 'Kutipan sintetis.'
        },
      ],
    },
  ],
  'impacts': [],
  'published_at': '2026-09-24T09:05:00+07:00',
};

const syntheticEventDetail = <String, Object?>{
  ...syntheticEvent,
  'geometries': []
};
const syntheticEventPage = <String, Object?>{
  'data': [syntheticEvent],
  'page': {'next_cursor': null, 'cursor_expires_at': null},
};
const syntheticHistoryPage = <String, Object?>{
  'data': [],
  'page': {'next_cursor': null, 'cursor_expires_at': null},
};
