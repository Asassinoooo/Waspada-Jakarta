
import 'package:flutter_test/flutter_test.dart';
import 'package:waspada_jakarta_mobile/src/public_api.dart';
import 'package:waspada_jakarta_mobile/src/public_models.dart';

import 'support/fakes.dart';

void main() {
  group('IncidentCategory and EventCategory mappings', () {
    test('IncidentCategory parses standard incident types', () {
      expect(IncidentCategory.parse('flood'), IncidentCategory.flood);
      expect(IncidentCategory.parse('fire'), IncidentCategory.fire);
      expect(IncidentCategory.parse('accident'), IncidentCategory.accident);
      expect(IncidentCategory.parse('tree_fall'), IncidentCategory.treeFall);
      expect(IncidentCategory.parse('crime'), IncidentCategory.crime);
      expect(IncidentCategory.parse('weather'), IncidentCategory.weather);

      expect(IncidentCategory.flood.label, 'Banjir');
      expect(IncidentCategory.fire.label, 'Kebakaran');
      expect(IncidentCategory.accident.label, 'Kecelakaan');
      expect(IncidentCategory.treeFall.label, 'Pohon Tumbang');
      expect(IncidentCategory.crime.label, 'Kriminalitas');
      expect(IncidentCategory.weather.label, 'Cuaca Ekstrem');

      expect(IncidentCategory.flood.icon, '🌊');
      expect(IncidentCategory.fire.icon, '🔥');
      expect(IncidentCategory.accident.icon, '🚗');
      expect(IncidentCategory.treeFall.icon, '🌳');
      expect(IncidentCategory.crime.icon, '🚨');
      expect(IncidentCategory.weather.icon, '⛈️');
    });

    test('IncidentCategory maps canonical category wire values', () {
      expect(IncidentCategory.tryParse('disasters_weather'),
          IncidentCategory.flood);
      expect(IncidentCategory.tryParse('fires_infrastructure_hazards'),
          IncidentCategory.fire);
      expect(IncidentCategory.tryParse('transport_road_incidents'),
          IncidentCategory.accident);
      expect(IncidentCategory.tryParse('health_environmental_advisories'),
          IncidentCategory.treeFall);
      expect(IncidentCategory.tryParse('crime_personal_security'),
          IncidentCategory.crime);
      expect(IncidentCategory.tryParse('violence_immediate_threats'),
          IncidentCategory.crime);
      expect(IncidentCategory.tryParse('demonstrations_public_gatherings'),
          isNull);
    });

    test('IncidentCategory toEventCategory maps cleanly', () {
      expect(IncidentCategory.flood.toEventCategory(),
          EventCategory.disastersWeather);
      expect(IncidentCategory.weather.toEventCategory(),
          EventCategory.disastersWeather);
      expect(IncidentCategory.fire.toEventCategory(),
          EventCategory.firesInfrastructureHazards);
      expect(IncidentCategory.accident.toEventCategory(),
          EventCategory.transportRoadIncidents);
      expect(IncidentCategory.treeFall.toEventCategory(),
          EventCategory.healthEnvironmentalAdvisories);
      expect(IncidentCategory.crime.toEventCategory(),
          EventCategory.crimePersonalSecurity);
    });

    test('EventCategory.parse supports canonical wire values and incident types',
        () {
      expect(EventCategory.parse('disasters_weather'),
          EventCategory.disastersWeather);
      expect(EventCategory.parse('flood'), EventCategory.disastersWeather);
      expect(EventCategory.parse('weather'), EventCategory.disastersWeather);
      expect(EventCategory.parse('fire'),
          EventCategory.firesInfrastructureHazards);
      expect(EventCategory.parse('accident'),
          EventCategory.transportRoadIncidents);
      expect(EventCategory.parse('tree_fall'),
          EventCategory.healthEnvironmentalAdvisories);
      expect(EventCategory.parse('crime'),
          EventCategory.crimePersonalSecurity);

      expect(() => EventCategory.parse('unknown_hazard'),
          throwsA(isA<ContractViolation>()));
      expect(() => EventCategory.parse('danger_score'),
          throwsA(isA<ContractViolation>()));
    });

    test('EventCategory categoryAccent and icon match desktop client', () {
      expect(EventCategory.disastersWeather.categoryAccent, 'flood');
      expect(EventCategory.disastersWeather.icon, '🌊');
      expect(EventCategory.firesInfrastructureHazards.categoryAccent, 'fire');
      expect(EventCategory.firesInfrastructureHazards.icon, '🔥');
      expect(EventCategory.transportRoadIncidents.categoryAccent, 'accident');
      expect(EventCategory.transportRoadIncidents.icon, '🚗');
      expect(EventCategory.healthEnvironmentalAdvisories.categoryAccent,
          'tree_fall');
      expect(EventCategory.healthEnvironmentalAdvisories.icon, '🌳');
      expect(EventCategory.crimePersonalSecurity.categoryAccent, 'crime');
      expect(EventCategory.crimePersonalSecurity.icon, '🚨');
      expect(EventCategory.demonstrationsPublicGatherings.categoryAccent,
          'general');
      expect(EventCategory.demonstrationsPublicGatherings.icon, '⚠️');
    });
  });

  group('IncidentSeverity', () {
    test('IncidentSeverity parses valid values and maps radius correctly', () {
      expect(IncidentSeverity.parse('critical'), IncidentSeverity.critical);
      expect(IncidentSeverity.parse('high'), IncidentSeverity.high);
      expect(IncidentSeverity.parse('medium'), IncidentSeverity.medium);
      expect(IncidentSeverity.parse('low'), IncidentSeverity.low);

      expect(IncidentSeverity.critical.label, 'Kritis');
      expect(IncidentSeverity.high.label, 'Tinggi');
      expect(IncidentSeverity.medium.label, 'Sedang');
      expect(IncidentSeverity.low.label, 'Rendah');

      // Flood radius
      expect(
          IncidentSeverity.critical.affectedRadiusMeters(IncidentCategory.flood),
          1500);
      expect(IncidentSeverity.high.affectedRadiusMeters(IncidentCategory.flood),
          1000);
      expect(
          IncidentSeverity.medium.affectedRadiusMeters(IncidentCategory.flood),
          600);
      expect(IncidentSeverity.low.affectedRadiusMeters(IncidentCategory.flood),
          300);

      // Other incident radius
      expect(
          IncidentSeverity.critical.affectedRadiusMeters(IncidentCategory.fire),
          1200);
      expect(IncidentSeverity.high.affectedRadiusMeters(IncidentCategory.accident),
          800);
      expect(
          IncidentSeverity.medium.affectedRadiusMeters(IncidentCategory.treeFall),
          500);
      expect(IncidentSeverity.low.affectedRadiusMeters(IncidentCategory.crime),
          250);

      expect(() => IncidentSeverity.parse('extreme'),
          throwsA(isA<ContractViolation>()));
    });
  });

  group('Schema 2.0 EventRecord & EventDetail Serialization', () {
    test('EventRecord parses standard fixture without schema 2.0 fields', () {
      final event = EventRecord.fromJson(syntheticEvent);
      expect(event.id, 'synthetic-event-1');
      expect(event.version, 1);
      expect(event.schemaVersion, '2.0');
      expect(event.recordType, 'Event');
      expect(event.publicationStatus, 'published');
      expect(event.supersedesVersion, isNull);
      expect(event.traceId, isNull);
      expect(event.incidentType, isNull);
      expect(event.incidentCategory, IncidentCategory.accident);
      expect(event.categoryAccent, 'accident');
      expect(event.icon, '🚗');
    });

    test('EventRecord parses complete Schema 2.0 fields cleanly', () {
      final json = <String, Object?>{
        ...syntheticEvent,
        'schema_version': '2.0',
        'trace_id': 'trace-abc-123',
        'record_type': 'Event',
        'dataset_kind': 'live',
        'supersedes_version': 2,
        'publication_status': 'published',
        'withdrawal_reason': null,
        'publication_decision_id': 'pub-dec-001',
        'withdrawn_at': null,
        'incident_type': 'flood',
        'severity': 'high',
        'location_label': 'Kampung Melayu, Jakarta Timur',
        'coordinates': [106.8650, -6.2280],
      };

      final event = EventRecord.fromJson(json);
      expect(event.schemaVersion, '2.0');
      expect(event.traceId, 'trace-abc-123');
      expect(event.recordType, 'Event');
      expect(event.datasetKind, 'live');
      expect(event.supersedesVersion, 2);
      expect(event.publicationStatus, 'published');
      expect(event.publicationDecisionId, 'pub-dec-001');
      expect(event.incidentType, IncidentCategory.flood);
      expect(event.incidentCategory, IncidentCategory.flood);
      expect(event.severity, IncidentSeverity.high);
      expect(event.locationLabel, 'Kampung Melayu, Jakarta Timur');
      expect(event.coordinates, [106.8650, -6.2280]);
      expect(event.categoryAccent, 'flood');
      expect(event.icon, '🌊');
    });

    test('EventRecord parses incident category directly in category field', () {
      final json = <String, Object?>{
        ...syntheticEvent,
        'category': 'tree_fall',
      };
      final event = EventRecord.fromJson(json);
      expect(event.category, EventCategory.healthEnvironmentalAdvisories);
      expect(event.incidentCategory, IncidentCategory.treeFall);
      expect(event.categoryAccent, 'tree_fall');
      expect(event.icon, '🌳');
    });

    test('EventDetail inherits Schema 2.0 fields and parses geometries', () {
      final json = <String, Object?>{
        ...syntheticEventDetail,
        'schema_version': '2.0',
        'supersedes_version': 1,
        'incident_type': 'fire',
        'severity': 'critical',
        'location_label': 'Pasar Senen, Jakarta Pusat',
        'coordinates': [106.8436, -6.1770],
        'geometries': [
          {
            'geometry_id': 'geom-001',
            'role': 'incident_scene',
            'precision_m': 10.0,
            'label': 'Titik kebakaran awal',
            'geometry': {
              'type': 'Point',
              'coordinates': [106.8436, -6.1770],
            },
          }
        ],
      };

      final detail = EventDetail.fromJson(json);
      expect(detail.supersedesVersion, 1);
      expect(detail.incidentType, IncidentCategory.fire);
      expect(detail.severity, IncidentSeverity.critical);
      expect(detail.locationLabel, 'Pasar Senen, Jakarta Pusat');
      expect(detail.coordinates, [106.8436, -6.1770]);
      expect(detail.geometries.length, 1);
      expect(detail.geometries.first.role, 'incident_scene');
      expect(detail.geometries.first.id, 'geom-001');
      expect(detail.geometries.first.precisionM, 10.0);
      expect(detail.geometries.first.label, 'Titik kebakaran awal');
    });

    test('ContractViolation thrown on invalid schema_version or publication_status', () {
      expect(
        () => EventRecord.fromJson({
          ...syntheticEvent,
          'schema_version': '1.0',
        }),
        throwsA(isA<ContractViolation>()),
      );

      expect(
        () => EventRecord.fromJson({
          ...syntheticEvent,
          'publication_status': 'invalid_status',
        }),
        throwsA(isA<ContractViolation>()),
      );

      expect(
        () => EventRecord.fromJson({
          ...syntheticEvent,
          'unauthorized_extra_field': 'malformed',
        }),
        throwsA(isA<ContractViolation>()),
      );
    });

    test('PublicClaim parses cleanly with optional schema 2.0 fields', () {
      final claimJson = <String, Object?>{
        ...((syntheticEvent['claims'] as List).first as Map<String, Object?>),
        'quote_text': 'Air mulai naik pukul 06.00 WIB mencapai 50 cm.',
        'support_assessment': 'supported',
        'evidence_ref_id': 'ref-001',
      };
      final claim = PublicClaim.fromJson(claimJson);
      expect(claim.quoteText, 'Air mulai naik pukul 06.00 WIB mencapai 50 cm.');
      expect(claim.supportAssessment, 'supported');
      expect(claim.evidenceRefId, 'ref-001');
    });

    test('PublicImpact parses cleanly with optional schema 2.0 fields', () {
      final impactJson = <String, Object?>{
        'impact_id': 'impact-001',
        'version': 1,
        'impact_type': 'road_closure',
        'title': 'Penutupan Jalan Raya Jatinegara Barat',
        'description': 'Lalu lintas dialihkan via Jalan Otista.',
        'lifecycle': 'ongoing',
        'freshness': {
          'status': 'current',
          'evaluated_at': '2026-09-24T09:10:00+07:00',
          'review_due_at': '2026-09-24T10:00:00+07:00',
          'basis': 'manual_review',
        },
        'event_time': {
          'start': '2026-09-24T07:00:00+07:00',
          'end': null,
          'precision': 'exact',
        },
        'validity': {
          'valid_from': '2026-09-24T07:00:00+07:00',
          'valid_until': null,
        },
        'scope': {
          'places': ['Jatinegara Barat'],
          'services': ['Transjakarta Koridor 5'],
          'institutions': [],
          'audiences': [],
        },
        'schema_version': '2.0',
        'event_id': 'synthetic-event-1',
        'event_version': 1,
        'supporting_claim_ids': ['claim-001'],
        'published_at': '2026-09-24T07:30:00+07:00',
      };

      final impact = PublicImpact.fromJson(impactJson);
      expect(impact.id, 'impact-001');
      expect(impact.eventId, 'synthetic-event-1');
      expect(impact.eventVersion, 1);
      expect(impact.supportingClaimIds, ['claim-001']);
      expect(impact.publishedAt, '2026-09-24T07:30:00+07:00');
    });
  });

  group('Schema 2.0 EventProposal DTO Parsing', () {
    test('EventProposal parses schema 2.0 proposal DTO cleanly', () {
      final proposalJson = <String, Object?>{
        'schema_version': '2.0',
        'proposal_id': 'proposal-flood-001',
        'title': 'Banjir 50 cm di Kampung Melayu Jakarta Timur',
        'incident_type': 'flood',
        'severity': 'high',
        'event_time': {
          'precision': 'exact',
          'value': '2026-10-26T07:00:00.000Z',
        },
        'location_label': 'Kampung Melayu, Jatinegara, Jakarta Timur',
        'coordinates': [106.8650, -6.2280],
        'claims': [
          {
            'claim_id': 'claim-001',
            'claim_text': 'Genangan setinggi 50 cm merendam permukiman warga RW 01 Kampung Melayu.',
            'evidence_label': 'under_review',
            'support_assessment': 'supported',
            'quote_text': 'Ketinggian air mencapai 50 cm di RW 01',
            'evidence_ref_id': 'chunk-001',
          }
        ],
        'unresolved_fields': <String>[],
        'proposed_at': '2026-10-26T07:15:00.000Z',
      };

      final proposal = EventProposal.fromJson(proposalJson);
      expect(proposal.schemaVersion, '2.0');
      expect(proposal.proposalId, 'proposal-flood-001');
      expect(proposal.incidentType, IncidentCategory.flood);
      expect(proposal.severity, IncidentSeverity.high);
      expect(proposal.locationLabel, 'Kampung Melayu, Jatinegara, Jakarta Timur');
      expect(proposal.coordinates, [106.8650, -6.2280]);
      expect(proposal.claims.length, 1);
      expect(proposal.claims.first.claimId, 'claim-001');
      expect(proposal.claims.first.evidenceLabel, 'under_review');
    });
  });

  group('EventQuery incident category query parameters', () {
    test('EventQuery serializes incidentCategory when category is absent', () {
      const query = EventQuery(incidentCategory: IncidentCategory.treeFall);
      expect(query.toQueryParameters(), {
        'limit': '20',
        'category': 'tree_fall',
      });
    });

    test('EventQuery prioritizes canonical category over incidentCategory if both provided', () {
      const query = EventQuery(
        category: EventCategory.disastersWeather,
        incidentCategory: IncidentCategory.flood,
      );
      expect(query.toQueryParameters(), {
        'limit': '20',
        'category': 'disasters_weather',
      });
    });
  });
}
