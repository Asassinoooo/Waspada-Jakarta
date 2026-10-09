import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';
import 'package:unorm_dart/unorm_dart.dart' as unorm;

import 'public_models.dart';

const preferencesStorageKey = 'waspada-jakarta:preferences:v1';
const preferencesSchemaVersion = 1;
const maxTextInterestsPerField = 30;
const maxInterestCharacters = 128;

abstract interface class KeyValueStorage {
  Future<String?> getString(String key);
  Future<bool> setString(String key, String value);
  Future<bool> remove(String key);
}

class SharedPreferencesStorage implements KeyValueStorage {
  Future<SharedPreferences> get _preferences => SharedPreferences.getInstance();
  @override
  Future<String?> getString(String key) async =>
      (await _preferences).getString(key);
  @override
  Future<bool> setString(String key, String value) async =>
      (await _preferences).setString(key, value);
  @override
  Future<bool> remove(String key) async => (await _preferences).remove(key);
}

class LocalInterests {
  const LocalInterests({
    this.places = const [],
    this.services = const [],
    this.institutions = const [],
    this.audiences = const [],
    this.categories = const [],
  });

  final List<String> places;
  final List<String> services;
  final List<String> institutions;
  final List<String> audiences;
  final List<EventCategory> categories;

  bool get isEmpty =>
      places.isEmpty &&
      services.isEmpty &&
      institutions.isEmpty &&
      audiences.isEmpty &&
      categories.isEmpty;

  Map<String, Object?> toJson() => {
        'places': places,
        'services': services,
        'institutions': institutions,
        'audiences': audiences,
        'categories': categories.map((item) => item.wireValue).toList(),
      };

  factory LocalInterests.fromJson(Object? json) {
    if (json is! Map) throw const FormatException();
    final fields = {
      'places',
      'services',
      'institutions',
      'audiences',
      'categories'
    };
    if (json.keys.length != fields.length || !fields.every(json.containsKey)) {
      throw const FormatException();
    }
    List<String> read(String field) {
      final raw = json[field];
      if (raw is! List || raw.length > maxTextInterestsPerField) {
        throw const FormatException();
      }
      return _normalizeValues(raw.cast<Object?>());
    }

    final rawCategories = json['categories'];
    if (rawCategories is! List ||
        rawCategories.length > EventCategory.values.length) {
      throw const FormatException();
    }
    final categories = <EventCategory>[];
    for (final value in rawCategories) {
      final category = EventCategory.parse(value);
      if (!categories.contains(category)) categories.add(category);
    }
    return LocalInterests(
      places: read('places'),
      services: read('services'),
      institutions: read('institutions'),
      audiences: read('audiences'),
      categories: categories,
    );
  }

  LocalInterests copyWith({
    List<String>? places,
    List<String>? services,
    List<String>? institutions,
    List<String>? audiences,
    List<EventCategory>? categories,
  }) =>
      LocalInterests(
        places: places ?? this.places,
        services: services ?? this.services,
        institutions: institutions ?? this.institutions,
        audiences: audiences ?? this.audiences,
        categories: categories ?? this.categories,
      );
}

List<String> _normalizeValues(Iterable<Object?> values) {
  final result = <String>[];
  final seen = <String>{};
  for (final raw in values) {
    if (raw is! String) throw const FormatException();
    final normalized = raw.trim();
    if (normalized.runes.length > maxInterestCharacters) {
      throw const FormatException();
    }
    if (normalized.isEmpty) continue;
    final identity = normalized.toLowerCase();
    if (seen.add(identity)) result.add(normalized);
  }
  return result;
}

enum PreferenceLoadStatus { empty, loaded, malformed, unavailable }

enum PreferenceWriteStatus { saved, unavailable, invalid }

class PreferenceLoadResult {
  const PreferenceLoadResult(this.status, this.interests);
  final PreferenceLoadStatus status;
  final LocalInterests interests;
}

class PreferencesRepository {
  const PreferencesRepository(this.storage);
  final KeyValueStorage storage;
  static Future<void> _writeQueue = Future<void>.value();

  Future<T> _withWriteLock<T>(Future<T> Function() operation) {
    final result = _writeQueue.then((_) => operation());
    _writeQueue = result.then<void>((_) {},
        onError: (Object error, StackTrace stackTrace) {});
    return result;
  }

  Future<PreferenceLoadResult> load() async {
    String? raw;
    try {
      raw = await storage.getString(preferencesStorageKey);
    } catch (_) {
      return const PreferenceLoadResult(
          PreferenceLoadStatus.unavailable, LocalInterests());
    }
    if (raw == null) {
      return const PreferenceLoadResult(
          PreferenceLoadStatus.empty, LocalInterests());
    }
    late final Object? parsed;
    try {
      parsed = jsonDecode(raw);
    } catch (_) {
      return const PreferenceLoadResult(
          PreferenceLoadStatus.malformed, LocalInterests());
    }
    if (parsed is! Map ||
        parsed['version'] != preferencesSchemaVersion ||
        parsed.keys.length != 2 ||
        !parsed.containsKey('interests')) {
      return const PreferenceLoadResult(
          PreferenceLoadStatus.malformed, LocalInterests());
    }
    try {
      return PreferenceLoadResult(PreferenceLoadStatus.loaded,
          LocalInterests.fromJson(parsed['interests']));
    } catch (_) {
      return const PreferenceLoadResult(
          PreferenceLoadStatus.malformed, LocalInterests());
    }
  }

  Future<PreferenceWriteStatus> save(LocalInterests raw) async {
    late final LocalInterests normalized;
    try {
      normalized = LocalInterests(
        places: _normalizeValues(raw.places),
        services: _normalizeValues(raw.services),
        institutions: _normalizeValues(raw.institutions),
        audiences: _normalizeValues(raw.audiences),
        categories: raw.categories.toSet().toList(),
      );
      if (normalized.places.length > maxTextInterestsPerField ||
          normalized.services.length > maxTextInterestsPerField ||
          normalized.institutions.length > maxTextInterestsPerField ||
          normalized.audiences.length > maxTextInterestsPerField) {
        return PreferenceWriteStatus.invalid;
      }
    } catch (_) {
      return PreferenceWriteStatus.invalid;
    }
    return _withWriteLock(() async {
      try {
        final written = await storage.setString(
          preferencesStorageKey,
          jsonEncode({
            'version': preferencesSchemaVersion,
            'interests': normalized.toJson()
          }),
        );
        return written
            ? PreferenceWriteStatus.saved
            : PreferenceWriteStatus.unavailable;
      } catch (_) {
        return PreferenceWriteStatus.unavailable;
      }
    });
  }

  Future<bool> clear() => _withWriteLock(() async {
        try {
          await storage.remove(preferencesStorageKey);
          return await storage.getString(preferencesStorageKey) == null;
        } catch (_) {
          return false;
        }
      });
}

bool locallyMatches(EventRecord event, LocalInterests interests) =>
    localMatchReasons(event, interests).isNotEmpty;

List<String> localMatchReasons(EventRecord event, LocalInterests interests) {
  final reasons = <String>[];
  if (interests.categories.contains(event.category)) {
    reasons.add(event.category.label);
  }
  final scopes = <PublicScope>[
    event.scope,
    ...event.claims.map((claim) => claim.scope),
    ...event.impacts.map((impact) => impact.scope),
  ];
  final scopeInterests = <({
    String label,
    List<String> values,
    List<String> Function(PublicScope) read
  })>[
    (label: 'Tempat', values: interests.places, read: (scope) => scope.places),
    (
      label: 'Layanan',
      values: interests.services,
      read: (scope) => scope.services
    ),
    (
      label: 'Lembaga',
      values: interests.institutions,
      read: (scope) => scope.institutions
    ),
    (
      label: 'Kelompok',
      values: interests.audiences,
      read: (scope) => scope.audiences
    ),
  ];
  for (final field in scopeInterests) {
    final returnedNames = scopes.expand(field.read).toSet();
    for (final interest in field.values) {
      final normalizedInterest = _normalizeMatchText(interest);
      if (returnedNames
          .any((name) => _normalizeMatchText(name) == normalizedInterest)) {
        reasons.add('${field.label}: $interest');
      }
    }
  }
  return reasons;
}

String _normalizeMatchText(String value) =>
    unorm.nfc(value).trim().toLowerCase();
