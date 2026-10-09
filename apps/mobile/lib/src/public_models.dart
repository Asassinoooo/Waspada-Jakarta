import 'dart:convert';

enum EventCategory {
  crimePersonalSecurity(
      'crime_personal_security', 'Kejahatan dan keamanan pribadi'),
  demonstrationsPublicGatherings(
      'demonstrations_public_gatherings', 'Demonstrasi dan keramaian publik'),
  crowdsMajorEvents('crowds_major_events', 'Kerumunan dan acara besar'),
  violenceImmediateThreats(
      'violence_immediate_threats', 'Kekerasan dan ancaman langsung'),
  disastersWeather('disasters_weather', 'Bencana dan cuaca'),
  firesInfrastructureHazards(
      'fires_infrastructure_hazards', 'Kebakaran dan bahaya infrastruktur'),
  transportRoadIncidents(
      'transport_road_incidents', 'Transportasi dan insiden jalan'),
  utilitiesEssentialServices(
      'utilities_essential_services', 'Utilitas dan layanan penting'),
  healthEnvironmentalAdvisories('health_environmental_advisories',
      'Pemberitahuan kesehatan dan lingkungan'),
  groupSpecificCriticalNotices('group_specific_critical_notices',
      'Pemberitahuan penting untuk kelompok tertentu');

  const EventCategory(this.wireValue, this.label);
  final String wireValue;
  final String label;

  static EventCategory parse(Object? value) => EventCategory.values.firstWhere(
        (item) => item.wireValue == value,
        orElse: () => throw const ContractViolation(),
      );
}

enum EventLifecycle {
  planned('planned', 'Direncanakan'),
  ongoing('ongoing', 'Berlangsung'),
  resolved('resolved', 'Selesai'),
  cancelled('cancelled', 'Dibatalkan'),
  unknown('unknown', 'Belum diketahui');

  const EventLifecycle(this.wireValue, this.label);
  final String wireValue;
  final String label;

  static EventLifecycle parse(Object? value) =>
      EventLifecycle.values.firstWhere(
        (item) => item.wireValue == value,
        orElse: () => throw const ContractViolation(),
      );
}

enum FreshnessStatus {
  current('current', 'Pembaruan dalam batas waktu'),
  needsUpdate('needs_update', 'Perlu diperbarui'),
  expired('expired', 'Masa berlaku sumber berakhir');

  const FreshnessStatus(this.wireValue, this.label);
  final String wireValue;
  final String label;

  static FreshnessStatus parse(Object? value) =>
      FreshnessStatus.values.firstWhere(
        (item) => item.wireValue == value,
        orElse: () => throw const ContractViolation(),
      );
}

enum EvidenceLabel {
  issuerNotice('issuer_notice', 'Pemberitahuan resmi (sesuai kewenangan)'),
  attributedReport(
      'attributed_report', 'Dilaporkan oleh sumber yang disebutkan'),
  independentCorroboration(
      'independent_corroboration', 'Didukung laporan independen'),
  crowdsourcedObservation('crowdsourced_observation', 'Laporan warga');

  const EvidenceLabel(this.wireValue, this.label);
  final String wireValue;
  final String label;

  static EvidenceLabel parse(Object? value) => EvidenceLabel.values.firstWhere(
        (item) => item.wireValue == value,
        orElse: () => throw const ContractViolation(),
      );
}

enum DatasetMode { live, demo }

enum DatasetLabel { live, historical, synthetic }

enum SourceHealth { unknown, healthy, degraded, unavailable }

class ContractViolation implements Exception {
  const ContractViolation();
}

typedef JsonMap = Map<String, Object?>;

JsonMap _object(Object? value, Set<String> keys) {
  if (value is! Map) throw const ContractViolation();
  final map = <String, Object?>{};
  for (final entry in value.entries) {
    if (entry.key is! String) throw const ContractViolation();
    map[entry.key as String] = entry.value;
  }
  if (map.keys.length != keys.length || !keys.every(map.containsKey)) {
    throw const ContractViolation();
  }
  return map;
}

String _string(Object? value, {int maxLength = 10000, bool allowEmpty = true}) {
  if (value is! String ||
      value.length > maxLength ||
      (!allowEmpty && value.trim().isEmpty)) {
    throw const ContractViolation();
  }
  return value;
}

String? _nullableString(Object? value, {int maxLength = 10000}) =>
    value == null ? null : _string(value, maxLength: maxLength);

int _positiveInt(Object? value) {
  if (value is! int || value < 1) throw const ContractViolation();
  return value;
}

List<String> _stringList(Object? value, {int maxItems = 100}) {
  if (value is! List || value.length > maxItems) {
    throw const ContractViolation();
  }
  return value
      .map((item) => _string(item, maxLength: 1000))
      .toList(growable: false);
}

List<T> _list<T>(Object? value, T Function(Object?) parse,
    {int maxItems = 100}) {
  if (value is! List || value.length > maxItems) {
    throw const ContractViolation();
  }
  return value.map(parse).toList(growable: false);
}

bool _isInstant(String? value) {
  if (value == null || value.length > 100) return false;
  final match = RegExp(
          r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$')
      .firstMatch(value);
  if (match == null) return false;
  final year = int.parse(match.group(1)!);
  final month = int.parse(match.group(2)!);
  final day = int.parse(match.group(3)!);
  final hour = int.parse(match.group(4)!);
  final minute = int.parse(match.group(5)!);
  final second = int.parse(match.group(6)!);
  if (!_isValidCalendarDate(year, month, day) ||
      hour > 23 ||
      minute > 59 ||
      second > 59) {
    return false;
  }
  if (match.group(8) != null &&
      (int.parse(match.group(8)!) > 23 || int.parse(match.group(9)!) > 59)) {
    return false;
  }
  return DateTime.tryParse(value) != null;
}

bool _isDate(String? value) {
  if (value == null) return false;
  final match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
  if (match == null) return false;
  return _isValidCalendarDate(
    int.parse(match.group(1)!),
    int.parse(match.group(2)!),
    int.parse(match.group(3)!),
  );
}

bool _isValidCalendarDate(int year, int month, int day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  final date = DateTime.utc(year, month, day);
  return date.year == year && date.month == month && date.day == day;
}

String _requiredInstant(Object? value) {
  final text = _string(value, maxLength: 100, allowEmpty: false);
  if (!_isInstant(text)) throw const ContractViolation();
  return text;
}

class TimeScope {
  const TimeScope(
      {required this.start, required this.end, required this.precision});
  final String? start;
  final String? end;
  final String precision;

  factory TimeScope.fromJson(Object? json) {
    final map = _object(json, {'start', 'end', 'precision'});
    final precision =
        _string(map['precision'], maxLength: 10, allowEmpty: false);
    final start = _nullableString(map['start'], maxLength: 100);
    final end = _nullableString(map['end'], maxLength: 100);
    switch (precision) {
      case 'exact':
        if (!_isInstant(start) || !(end == null || _isInstant(end))) {
          throw const ContractViolation();
        }
        break;
      case 'date':
        if (!_isDate(start) || !(end == null || _isDate(end))) {
          throw const ContractViolation();
        }
        break;
      case 'range':
        if (!_isInstant(start) || !_isInstant(end)) {
          throw const ContractViolation();
        }
        break;
      case 'unknown':
        if (start != null || end != null) throw const ContractViolation();
        break;
      default:
        throw const ContractViolation();
    }
    return TimeScope(start: start, end: end, precision: precision);
  }
}

class Validity {
  const Validity({required this.validFrom, required this.validUntil});
  final String? validFrom;
  final String? validUntil;

  factory Validity.fromJson(Object? json) {
    final map = _object(json, {'valid_from', 'valid_until'});
    final from = _nullableString(map['valid_from'], maxLength: 100);
    final until = _nullableString(map['valid_until'], maxLength: 100);
    if (!(from == null || _isInstant(from)) ||
        !(until == null || _isInstant(until))) {
      throw const ContractViolation();
    }
    return Validity(validFrom: from, validUntil: until);
  }
}

class Freshness {
  const Freshness(
      {required this.status,
      required this.evaluatedAt,
      required this.reviewDueAt,
      required this.basis});
  final FreshnessStatus status;
  final String evaluatedAt;
  final String? reviewDueAt;
  final String basis;

  factory Freshness.fromJson(Object? json) {
    final map =
        _object(json, {'status', 'evaluated_at', 'review_due_at', 'basis'});
    final basis = _string(map['basis'], maxLength: 40, allowEmpty: false);
    const bases = {
      'source_validity',
      'fast_observation_review',
      'undated_advisory_review',
      'manual_review',
      'unknown'
    };
    final due = _nullableString(map['review_due_at'], maxLength: 100);
    if (!bases.contains(basis) || !(due == null || _isInstant(due))) {
      throw const ContractViolation();
    }
    return Freshness(
      status: FreshnessStatus.parse(map['status']),
      evaluatedAt: _requiredInstant(map['evaluated_at']),
      reviewDueAt: due,
      basis: basis,
    );
  }
}

class PublicScope {
  const PublicScope(
      {required this.places,
      required this.services,
      required this.institutions,
      required this.audiences});
  final List<String> places;
  final List<String> services;
  final List<String> institutions;
  final List<String> audiences;

  Iterable<String> get all =>
      [...places, ...services, ...institutions, ...audiences];

  factory PublicScope.fromJson(Object? json) {
    final map =
        _object(json, {'places', 'services', 'institutions', 'audiences'});
    return PublicScope(
      places: _stringList(map['places']),
      services: _stringList(map['services']),
      institutions: _stringList(map['institutions']),
      audiences: _stringList(map['audiences']),
    );
  }
}

class PublicSource {
  const PublicSource(
      {required this.displayName,
      required this.url,
      required this.publishedAt,
      required this.observedAt,
      required this.excerpt});
  final String displayName;
  final String url;
  final String? publishedAt;
  final String? observedAt;
  final String? excerpt;

  factory PublicSource.fromJson(Object? json) {
    final map = _object(json,
        {'display_name', 'url', 'published_at', 'observed_at', 'excerpt'});
    final published = _nullableString(map['published_at'], maxLength: 100);
    final observed = _nullableString(map['observed_at'], maxLength: 100);
    if (!(published == null || _isInstant(published)) ||
        !(observed == null || _isInstant(observed))) {
      throw const ContractViolation();
    }
    return PublicSource(
      displayName:
          _string(map['display_name'], maxLength: 500, allowEmpty: false),
      url: _string(map['url'], maxLength: 2048, allowEmpty: false),
      publishedAt: published,
      observedAt: observed,
      excerpt: _nullableString(map['excerpt'], maxLength: 300),
    );
  }
}

class PublicClaim {
  const PublicClaim({
    required this.id,
    required this.text,
    required this.eventTime,
    required this.validity,
    required this.scope,
    required this.qualifiers,
    required this.evidenceLabel,
    required this.sources,
  });
  final String id;
  final String text;
  final TimeScope eventTime;
  final Validity validity;
  final PublicScope scope;
  final List<String> qualifiers;
  final EvidenceLabel evidenceLabel;
  final List<PublicSource> sources;

  factory PublicClaim.fromJson(Object? json) {
    final map = _object(json, {
      'claim_id',
      'text',
      'event_time',
      'validity',
      'scope',
      'qualifiers',
      'evidence_label',
      'sources'
    });
    final sources = _list(map['sources'], PublicSource.fromJson);
    if (sources.isEmpty) throw const ContractViolation();
    return PublicClaim(
      id: _string(map['claim_id'], maxLength: 256, allowEmpty: false),
      text: _string(map['text'], maxLength: 10000),
      eventTime: TimeScope.fromJson(map['event_time']),
      validity: Validity.fromJson(map['validity']),
      scope: PublicScope.fromJson(map['scope']),
      qualifiers: _stringList(map['qualifiers']),
      evidenceLabel: EvidenceLabel.parse(map['evidence_label']),
      sources: sources,
    );
  }
}

class PublicImpact {
  const PublicImpact({
    required this.id,
    required this.version,
    required this.impactType,
    required this.title,
    required this.description,
    required this.lifecycle,
    required this.freshness,
    required this.eventTime,
    required this.validity,
    required this.scope,
  });
  final String id;
  final int version;
  final String impactType;
  final String title;
  final String description;
  final EventLifecycle lifecycle;
  final Freshness freshness;
  final TimeScope eventTime;
  final Validity validity;
  final PublicScope scope;

  factory PublicImpact.fromJson(Object? json) {
    final map = _object(json, {
      'impact_id',
      'version',
      'impact_type',
      'title',
      'description',
      'lifecycle',
      'freshness',
      'event_time',
      'validity',
      'scope'
    });
    const types = {
      'road_closure',
      'traffic_diversion',
      'transport_service_disruption',
      'facility_closure',
      'utility_outage',
      'hazard_observation',
      'public_access_restriction',
      'event_attendance',
      'audience_notice',
      'other'
    };
    final kind = _string(map['impact_type'], maxLength: 64, allowEmpty: false);
    if (!types.contains(kind)) throw const ContractViolation();
    return PublicImpact(
      id: _string(map['impact_id'], maxLength: 256, allowEmpty: false),
      version: _positiveInt(map['version']),
      impactType: kind,
      title: _string(map['title'], maxLength: 1000, allowEmpty: false),
      description: _string(map['description'], maxLength: 10000),
      lifecycle: EventLifecycle.parse(map['lifecycle']),
      freshness: Freshness.fromJson(map['freshness']),
      eventTime: TimeScope.fromJson(map['event_time']),
      validity: Validity.fromJson(map['validity']),
      scope: PublicScope.fromJson(map['scope']),
    );
  }
}

class EventRecord {
  const EventRecord({
    required this.id,
    required this.version,
    required this.title,
    required this.summary,
    required this.category,
    required this.tags,
    required this.lifecycle,
    required this.freshness,
    required this.eventTime,
    required this.validity,
    required this.scope,
    required this.claims,
    required this.impacts,
    required this.publishedAt,
  });

  final String id;
  final int version;
  final String title;
  final String summary;
  final EventCategory category;
  final List<EventTag> tags;
  final EventLifecycle lifecycle;
  final Freshness freshness;
  final TimeScope eventTime;
  final Validity validity;
  final PublicScope scope;
  final List<PublicClaim> claims;
  final List<PublicImpact> impacts;
  final String publishedAt;

  static const keys = {
    'event_id',
    'version',
    'title',
    'summary',
    'category',
    'tags',
    'lifecycle',
    'freshness',
    'event_time',
    'validity',
    'scope',
    'claims',
    'impacts',
    'published_at',
  };

  factory EventRecord.fromJson(Object? json) {
    final map = _object(json, keys);
    return EventRecord(
      id: _string(map['event_id'], maxLength: 128, allowEmpty: false),
      version: _positiveInt(map['version']),
      title: _string(map['title'], maxLength: 500, allowEmpty: false),
      summary: _string(map['summary'], maxLength: 10000),
      category: EventCategory.parse(map['category']),
      tags: _list(map['tags'], EventTag.fromJson),
      lifecycle: EventLifecycle.parse(map['lifecycle']),
      freshness: Freshness.fromJson(map['freshness']),
      eventTime: TimeScope.fromJson(map['event_time']),
      validity: Validity.fromJson(map['validity']),
      scope: PublicScope.fromJson(map['scope']),
      claims: _list(map['claims'], PublicClaim.fromJson),
      impacts: _list(map['impacts'], PublicImpact.fromJson),
      publishedAt: _requiredInstant(map['published_at']),
    );
  }
}

class EventTag {
  const EventTag({required this.namespace, required this.value});
  final String namespace;
  final String value;

  factory EventTag.fromJson(Object? json) {
    final map = _object(json, {'namespace', 'value'});
    const namespaces = {
      'topic',
      'service',
      'audience',
      'hazard',
      'transport_mode',
      'place_type'
    };
    final namespace =
        _string(map['namespace'], maxLength: 32, allowEmpty: false);
    final value = _string(map['value'], maxLength: 64, allowEmpty: false);
    if (!namespaces.contains(namespace) ||
        !RegExp(r'^[a-z][a-z0-9_]*$').hasMatch(value)) {
      throw const ContractViolation();
    }
    return EventTag(namespace: namespace, value: value);
  }
}

class EventDetail extends EventRecord {
  const EventDetail(
      {required super.id,
      required super.version,
      required super.title,
      required super.summary,
      required super.category,
      required super.tags,
      required super.lifecycle,
      required super.freshness,
      required super.eventTime,
      required super.validity,
      required super.scope,
      required super.claims,
      required super.impacts,
      required super.publishedAt,
      required this.geometries});
  final List<PublicGeometry> geometries;

  factory EventDetail.fromJson(Object? json) {
    final map = _object(json, {...EventRecord.keys, 'geometries'});
    final event = EventRecord.fromJson(
        Map<String, Object?>.from(map)..remove('geometries'));
    return EventDetail(
      id: event.id,
      version: event.version,
      title: event.title,
      summary: event.summary,
      category: event.category,
      tags: event.tags,
      lifecycle: event.lifecycle,
      freshness: event.freshness,
      eventTime: event.eventTime,
      validity: event.validity,
      scope: event.scope,
      claims: event.claims,
      impacts: event.impacts,
      publishedAt: event.publishedAt,
      geometries: _list(map['geometries'], PublicGeometry.fromJson),
    );
  }
}

class PublicGeometry {
  const PublicGeometry({required this.role, required this.label});
  final String role;
  final String? label;

  factory PublicGeometry.fromJson(Object? json) {
    final map = _object(
        json, {'geometry_id', 'role', 'geometry', 'precision_m', 'label'});
    const roles = {
      'incident_scene',
      'affected_area',
      'warning_boundary',
      'route_segment',
      'service_stop',
      'facility',
      'venue',
      'service_area',
      'approximate_place'
    };
    final role = _string(map['role'], maxLength: 40, allowEmpty: false);
    final precision = map['precision_m'];
    if (!roles.contains(role) ||
        !(precision == null || precision is num && precision >= 0)) {
      throw const ContractViolation();
    }
    _validateGeometry(map['geometry']);
    return PublicGeometry(
        role: role, label: _nullableString(map['label'], maxLength: 500));
  }
}

void _validateGeometry(Object? value, [int depth = 0]) {
  if (depth > 8 || value is! Map) throw const ContractViolation();
  final map = <String, Object?>{};
  for (final entry in value.entries) {
    if (entry.key is! String) throw const ContractViolation();
    map[entry.key as String] = entry.value;
  }
  final type = _string(map['type'], maxLength: 32, allowEmpty: false);
  if (type == 'GeometryCollection') {
    if (map.keys.length != 2 ||
        !map.containsKey('geometries') ||
        map['geometries'] is! List) {
      throw const ContractViolation();
    }
    final children = map['geometries'] as List;
    if (children.length > 500) throw const ContractViolation();
    for (final child in children) {
      _validateGeometry(child, depth + 1);
    }
    return;
  }
  if (!{
        'Point',
        'MultiPoint',
        'LineString',
        'MultiLineString',
        'Polygon',
        'MultiPolygon'
      }.contains(type) ||
      map.keys.length != 2 ||
      !map.containsKey('coordinates')) {
    throw const ContractViolation();
  }
  var positions = 0;
  void walk(Object? node) {
    if (node is! List || node.isEmpty) throw const ContractViolation();
    if (node.every((item) => item is num)) {
      if ((node.length != 2 && node.length != 3) ||
          node.any((item) => !(item as num).isFinite)) {
        throw const ContractViolation();
      }
      positions++;
      if (positions > 50000) throw const ContractViolation();
      return;
    }
    for (final child in node) {
      walk(child);
    }
  }

  walk(map['coordinates']);
}

class EventPage {
  const EventPage(
      {required this.data,
      required this.nextCursor,
      required this.cursorExpiresAt});
  final List<EventRecord> data;
  final String? nextCursor;
  final String? cursorExpiresAt;

  factory EventPage.fromJson(Object? json) {
    final map = _object(json, {'data', 'page'});
    final page = _object(map['page'], {'next_cursor', 'cursor_expires_at'});
    final cursor = _nullableString(page['next_cursor'], maxLength: 2048);
    final expiry = _nullableString(page['cursor_expires_at'], maxLength: 100);
    if (cursor != null && cursor.isEmpty ||
        !(expiry == null || _isInstant(expiry))) {
      throw const ContractViolation();
    }
    return EventPage(
        data: _list(map['data'], EventRecord.fromJson),
        nextCursor: cursor,
        cursorExpiresAt: expiry);
  }
}

class HistoryEntry {
  const HistoryEntry(
      {required this.eventId,
      required this.version,
      required this.changeType,
      required this.changedAt,
      required this.summary});
  final String eventId;
  final int version;
  final String changeType;
  final String changedAt;
  final String summary;

  factory HistoryEntry.fromJson(Object? json) {
    final map = _object(
        json, {'event_id', 'version', 'change_type', 'changed_at', 'summary'});
    const changes = {'published', 'corrected', 'impact_changed', 'retracted'};
    final type = _string(map['change_type'], maxLength: 40, allowEmpty: false);
    if (!changes.contains(type)) throw const ContractViolation();
    return HistoryEntry(
      eventId: _string(map['event_id'], maxLength: 128, allowEmpty: false),
      version: _positiveInt(map['version']),
      changeType: type,
      changedAt: _requiredInstant(map['changed_at']),
      summary: _string(map['summary'], maxLength: 500),
    );
  }
}

class HistoryPage {
  const HistoryPage(
      {required this.data,
      required this.nextCursor,
      required this.cursorExpiresAt});
  final List<HistoryEntry> data;
  final String? nextCursor;
  final String? cursorExpiresAt;

  factory HistoryPage.fromJson(Object? json) {
    final map = _object(json, {'data', 'page'});
    final page = _object(map['page'], {'next_cursor', 'cursor_expires_at'});
    final cursor = _nullableString(page['next_cursor'], maxLength: 2048);
    final expiry = _nullableString(page['cursor_expires_at'], maxLength: 100);
    if (cursor != null && cursor.isEmpty ||
        !(expiry == null || _isInstant(expiry))) {
      throw const ContractViolation();
    }
    return HistoryPage(
        data: _list(map['data'], HistoryEntry.fromJson),
        nextCursor: cursor,
        cursorExpiresAt: expiry);
  }
}

class PublicSourceStatus {
  const PublicSourceStatus(
      {required this.displayName,
      required this.health,
      required this.lastSuccessAt});
  final String displayName;
  final SourceHealth health;
  final String? lastSuccessAt;
}

class PublicContext {
  const PublicContext(
      {required this.datasetMode,
      required this.datasetLabel,
      required this.generatedAt,
      required this.sources});
  final DatasetMode datasetMode;
  final DatasetLabel datasetLabel;
  final String generatedAt;
  final List<PublicSourceStatus> sources;

  String get notice {
    if (datasetMode == DatasetMode.demo || datasetLabel != DatasetLabel.live) {
      final label = switch (datasetLabel) {
        DatasetLabel.historical => 'historis',
        DatasetLabel.synthetic => 'sintetis',
        DatasetLabel.live => 'mode demo',
      };
      return 'DEMO — data $label; bukan peringatan langsung.';
    }
    return 'LIVE — informasi publik; bukan layanan darurat.';
  }

  factory PublicContext.fromJson(Object? json) {
    final map = _object(
        json, {'dataset_mode', 'dataset_label', 'generated_at', 'sources'});
    final modeText =
        _string(map['dataset_mode'], maxLength: 10, allowEmpty: false);
    final labelText =
        _string(map['dataset_label'], maxLength: 10, allowEmpty: false);
    final mode = switch (modeText) {
      'live' => DatasetMode.live,
      'demo' => DatasetMode.demo,
      _ => throw const ContractViolation()
    };
    final label = switch (labelText) {
      'live' => DatasetLabel.live,
      'historical' => DatasetLabel.historical,
      'synthetic' => DatasetLabel.synthetic,
      _ => throw const ContractViolation()
    };
    // The deployment mode and dataset label jointly gate display of report content.
    if ((mode == DatasetMode.live) != (label == DatasetLabel.live)) {
      throw const ContractViolation();
    }
    final sourceJson = _list(map['sources'], (value) {
      final source =
          _object(value, {'display_name', 'health', 'last_success_at'});
      final healthText =
          _string(source['health'], maxLength: 20, allowEmpty: false);
      final health = switch (healthText) {
        'unknown' => SourceHealth.unknown,
        'healthy' => SourceHealth.healthy,
        'degraded' => SourceHealth.degraded,
        'unavailable' => SourceHealth.unavailable,
        _ => throw const ContractViolation(),
      };
      final lastSuccess =
          _nullableString(source['last_success_at'], maxLength: 100);
      if (!(lastSuccess == null || _isInstant(lastSuccess))) {
        throw const ContractViolation();
      }
      return PublicSourceStatus(
          displayName: _string(source['display_name'],
              maxLength: 500, allowEmpty: false),
          health: health,
          lastSuccessAt: lastSuccess);
    });
    return PublicContext(
        datasetMode: mode,
        datasetLabel: label,
        generatedAt: _requiredInstant(map['generated_at']),
        sources: sourceJson);
  }
}

Object? decodeJson(String source) {
  try {
    return jsonDecode(source);
  } on FormatException {
    throw const ContractViolation();
  }
}
