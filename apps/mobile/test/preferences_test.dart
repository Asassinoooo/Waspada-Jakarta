import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:waspada_jakarta_mobile/src/preferences.dart';
import 'package:waspada_jakarta_mobile/src/public_models.dart';

import 'support/fakes.dart';

class _DelayedWriteStorage extends MemoryStorage {
  final writeStarted = Completer<void>();
  final releaseWrite = Completer<void>();

  @override
  Future<bool> setString(String key, String value) async {
    writeStarted.complete();
    await releaseWrite.future;
    values[key] = value;
    return true;
  }
}

const _emptyScope = <String, Object?>{
  'places': <String>[],
  'services': <String>[],
  'institutions': <String>[],
  'audiences': <String>[],
};

const _syntheticImpactWithServiceScope = <String, Object?>{
  'impact_id': 'synthetic-impact-1',
  'version': 1,
  'impact_type': 'transport_service_disruption',
  'title': 'Perubahan layanan fiksi',
  'description': 'Fixture otomatis; bukan dampak aktual.',
  'lifecycle': 'ongoing',
  'freshness': {
    'status': 'current',
    'evaluated_at': '2026-09-24T09:10:00+07:00',
    'review_due_at': null,
    'basis': 'manual_review',
  },
  'event_time': {
    'start': '2026-09-24T10:00:00+07:00',
    'end': null,
    'precision': 'exact',
  },
  'validity': {'valid_from': null, 'valid_until': null},
  'scope': {
    'places': <String>[],
    'services': ['Transjakarta 12'],
    'institutions': <String>[],
    'audiences': <String>[],
  },
};

void main() {
  test(
      'interest values are local, normalized, and cleared by the Waspada-owned key only',
      () async {
    final storage = MemoryStorage()..values['other-app:key'] = 'leave intact';
    final repository = PreferencesRepository(storage);
    final interests = LocalInterests(
        places: ['  Jakarta Pusat  ', 'jakarta pusat'],
        categories: [EventCategory.disastersWeather]);

    expect(await repository.save(interests), PreferenceWriteStatus.saved);
    final loaded = await repository.load();
    expect(loaded.status, PreferenceLoadStatus.loaded);
    expect(loaded.interests.places, ['Jakarta Pusat']);
    expect(loaded.interests.categories, [EventCategory.disastersWeather]);
    expect(storage.values.keys, contains(preferencesStorageKey));
    expect(storage.values['other-app:key'], 'leave intact');
    expect(await repository.clear(), isTrue);
    expect(storage.values.containsKey(preferencesStorageKey), isFalse);
    expect(storage.values['other-app:key'], 'leave intact');
  });

  test('clear verifies readback and reports a silently ignored removal',
      () async {
    final storage = MemoryStorage()
      ..values[preferencesStorageKey] = 'saved preferences'
      ..values['other-app:key'] = 'leave intact'
      ..ignoreRemove = true;
    final repository = PreferencesRepository(storage);

    expect(await repository.clear(), isFalse);
    expect(storage.values[preferencesStorageKey], 'saved preferences');
    expect(storage.values['other-app:key'], 'leave intact');
  });

  test(
      'save and clear share a write lock so a pending save cannot recreate data',
      () async {
    final storage = _DelayedWriteStorage()
      ..values['other-app:key'] = 'leave intact';
    final repository = PreferencesRepository(storage);
    final saving = repository.save(const LocalInterests(places: ['Tempat']));
    await storage.writeStarted.future;
    final clearing = repository.clear();
    storage.releaseWrite.complete();

    expect(await saving, PreferenceWriteStatus.saved);
    expect(await clearing, isTrue);
    expect(storage.values.containsKey(preferencesStorageKey), isFalse);
    expect(storage.values['other-app:key'], 'leave intact');
  });

  test('malformed local choices and storage failures stay explicit', () async {
    final storage = MemoryStorage()..values[preferencesStorageKey] = '{broken';
    final repository = PreferencesRepository(storage);
    expect((await repository.load()).status, PreferenceLoadStatus.malformed);
    expect(
        await repository
            .save(LocalInterests(places: [List.filled(129, 'x').join()])),
        PreferenceWriteStatus.invalid);
    storage.failReads = true;
    expect((await repository.load()).status, PreferenceLoadStatus.unavailable);
    storage.failReads = false;
    storage.failWrites = true;
    expect(await repository.save(const LocalInterests()),
        PreferenceWriteStatus.unavailable);
    storage.failWrites = false;
    storage.failRemove = true;
    expect(await repository.clear(), isFalse);
  });

  test('interest matching is local, field-specific, NFC, and exact', () {
    final event = EventRecord.fromJson(syntheticEvent);
    expect(
        locallyMatches(
            event,
            const LocalInterests(
                categories: [EventCategory.transportRoadIncidents])),
        isTrue);
    expect(
        locallyMatches(event, const LocalInterests(places: ['Tempat Fiktif'])),
        isTrue);
    expect(
        locallyMatches(
            event, const LocalInterests(services: ['Tempat Fiktif'])),
        isFalse,
        reason: 'a place name must not match the service field');
    expect(
        locallyMatches(
            event, const LocalInterests(places: ['Tempat Fiktif Barat'])),
        isFalse);
    expect(locallyMatches(event, const LocalInterests()), isFalse);

    final claim = <String, Object?>{
      ...(syntheticEvent['claims'] as List).single as Map<String, Object?>,
      'scope': {
        ..._emptyScope,
        'places': ['E\u0301vakuasi Selatan'],
      },
    };
    final claimOnlyEvent = EventRecord.fromJson({
      ...syntheticEvent,
      'scope': _emptyScope,
      'claims': [claim],
      'impacts': <Object?>[],
    });
    expect(
        locallyMatches(claimOnlyEvent,
            const LocalInterests(places: ['  Évakuasi Selatan  '])),
        isTrue,
        reason: 'claim scopes use NFC, trim, and case-insensitive matching');
    expect(
        locallyMatches(claimOnlyEvent,
            const LocalInterests(services: ['Évakuasi Selatan'])),
        isFalse);

    final impactOnlyEvent = EventRecord.fromJson({
      ...syntheticEvent,
      'scope': _emptyScope,
      'claims': <Object?>[],
      'impacts': [_syntheticImpactWithServiceScope],
    });
    expect(
        locallyMatches(impactOnlyEvent,
            const LocalInterests(services: [' transjakarta 12 '])),
        isTrue);
    expect(
        locallyMatches(
            impactOnlyEvent, const LocalInterests(places: ['Transjakarta 12'])),
        isFalse);
  });
}
