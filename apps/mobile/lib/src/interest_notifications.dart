import 'dart:convert';

import 'preferences.dart';
import 'public_api.dart';
import 'public_models.dart';

/// NOTIFY-01 (owner, 23 Nov 2026): local "Area saya" notifications on Android.
///
/// The phone polls the public updates feed in the background, reads each changed event's public detail and matches
/// it against the interests saved on this device, with the same rule as the web (UpdatesCenter matchPublicUpdate):
/// a chosen category, or a chosen place, service, institution or audience named in the event, claim or impact
/// scope. Interests never leave the device: there is no push service and no server-side subscription.
///
/// The first run only takes a baseline cursor, so turning notifications on never replays older events. An expired
/// cursor (410) starts a new baseline. Each run shows at most [notifyMaxPerRun] notifications plus one summary.
const notifyEnabledKey = 'waspada.notify.enabled.v1';
const notifyStateKey = 'waspada.notify.state.v1';
const notifyMaxPerRun = 3;
const notifyMaxPagesPerRun = 5;
const notifyPageSize = 20;
const notifyRememberedKeys = 200;
const notifyEmergencyLine = 'Bukan layanan darurat. Darurat: 112.';
const notifySummaryId = 1;

class NotifyContent {
  const NotifyContent(
      {required this.id,
      required this.title,
      required this.body,
      required this.eventId});

  /// Stable per event, so a newer version replaces the older notification.
  final int id;
  final String title;
  final String body;

  /// The event to open on tap, or null for the summary.
  final String? eventId;
}

enum NotifyRunOutcome { off, baseline, checked, rebaselined, failed }

class NotifyRunResult {
  const NotifyRunResult(this.outcome, {this.shown = 0});
  final NotifyRunOutcome outcome;
  final int shown;
}

/// FNV-1a over the UTF-16 code units: the same id on every run, unlike String.hashCode.
int notificationIdFor(String eventId) {
  var hash = 0x811c9dc5;
  for (final unit in eventId.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0x7fffffff;
  }
  return hash < 2 ? hash + 2 : hash; // 0 and 1 are reserved (1 is the summary).
}

/// Plain and factual: it names the change and the event, never says an area is safe, and carries the 112 line.
NotifyContent notificationFor(EventRecord event, String changeType) =>
    NotifyContent(
      id: notificationIdFor(event.id),
      title: changeType == 'published'
          ? 'Laporan baru di area Anda'
          : 'Laporan diperbarui di area Anda',
      body: '${event.title}\n$notifyEmergencyLine',
      eventId: event.id,
    );

NotifyContent summaryNotification(int extra) => NotifyContent(
      id: notifySummaryId,
      title: '$extra laporan lain di area Anda',
      body: 'Buka Waspada Jakarta untuk melihat semuanya.\n$notifyEmergencyLine',
      eventId: null,
    );

bool hasAnyInterest(LocalInterests interests) => !interests.isEmpty;

/// The web rule, on the device: a chosen category, or a chosen scope name in the event, a claim or an impact.
bool matchesInterests(EventRecord event, LocalInterests interests) {
  if (interests.categories.contains(event.category)) return true;
  final scopes = <PublicScope>[
    event.scope,
    ...event.claims.map((claim) => claim.scope),
    ...event.impacts.map((impact) => impact.scope),
  ];
  bool any(List<String> chosen, List<String> Function(PublicScope) field) {
    if (chosen.isEmpty) return false;
    final wanted = chosen.map(normalizeLocalInterestText).toSet();
    return scopes.any((scope) =>
        field(scope).any((name) => wanted.contains(normalizeLocalInterestText(name))));
  }

  return any(interests.places, (s) => s.places) ||
      any(interests.services, (s) => s.services) ||
      any(interests.institutions, (s) => s.institutions) ||
      any(interests.audiences, (s) => s.audiences);
}

class NotifyState {
  const NotifyState({this.cursor, this.notified = const []});
  final String? cursor;

  /// `event_id:version` keys already shown, newest last, bounded to [notifyRememberedKeys].
  final List<String> notified;

  String toJson() => jsonEncode({'cursor': cursor, 'notified': notified});

  static NotifyState parse(String? raw) {
    if (raw == null) return const NotifyState();
    try {
      final json = jsonDecode(raw);
      if (json is! Map) return const NotifyState();
      final cursor = json['cursor'];
      final notified = json['notified'];
      return NotifyState(
        cursor: cursor is String && cursor.isNotEmpty && cursor.length <= 2048
            ? cursor
            : null,
        notified: notified is List
            ? notified.whereType<String>().take(notifyRememberedKeys).toList()
            : const [],
      );
    } catch (_) {
      return const NotifyState();
    }
  }
}

Future<bool> readNotifyEnabled(KeyValueStorage storage) async {
  try {
    return await storage.getString(notifyEnabledKey) == 'on';
  } catch (_) {
    return false;
  }
}

/// Turning off also forgets the cursor, so turning on again starts from a fresh baseline.
Future<bool> writeNotifyEnabled(KeyValueStorage storage, bool enabled) async {
  try {
    if (enabled) return await storage.setString(notifyEnabledKey, 'on');
    await storage.remove(notifyStateKey);
    return await storage.remove(notifyEnabledKey);
  } catch (_) {
    return false;
  }
}

/// One background run. Safe to call when off: it returns [NotifyRunOutcome.off] without any network call.
Future<NotifyRunResult> runNotifyCycle({
  required NotifyApi api,
  required KeyValueStorage storage,
  required LocalInterests interests,
  required Future<void> Function(NotifyContent content) show,
}) async {
  if (!await readNotifyEnabled(storage) || !hasAnyInterest(interests)) {
    return const NotifyRunResult(NotifyRunOutcome.off);
  }
  final state = NotifyState.parse(await storage.getString(notifyStateKey));
  try {
    if (state.cursor == null) {
      final baseline = await api.getUpdates();
      await storage.setString(notifyStateKey,
          NotifyState(cursor: baseline.nextCursor, notified: state.notified).toJson());
      return const NotifyRunResult(NotifyRunOutcome.baseline);
    }

    var cursor = state.cursor!;
    final notified = [...state.notified];
    final seen = notified.toSet();
    final changes = <HistoryEntry>[];
    for (var page = 0; page < notifyMaxPagesPerRun; page++) {
      final UpdatePage result;
      try {
        result = await api.getUpdates(cursor: cursor);
      } on ApiFailure catch (failure) {
        if (failure.kind == ApiFailureKind.http && failure.statusCode == 410) {
          // The gap is not replayed: the next run takes a new baseline.
          await storage.setString(
              notifyStateKey, NotifyState(notified: notified).toJson());
          return const NotifyRunResult(NotifyRunOutcome.rebaselined);
        }
        rethrow;
      }
      changes.addAll(result.items.where((c) => c.changeType != 'retracted'));
      cursor = result.nextCursor;
      if (result.items.length < notifyPageSize) break;
    }

    // Newest change per event that has not been shown yet.
    final latest = <String, HistoryEntry>{};
    for (final change in changes) {
      if (seen.contains('${change.eventId}:${change.version}')) continue;
      final current = latest[change.eventId];
      if (current == null || change.version > current.version) {
        latest[change.eventId] = change;
      }
    }

    final matched = <NotifyContent>[];
    for (final change in latest.values) {
      EventRecord detail;
      try {
        detail = await api.getEventDetail(change.eventId);
      } on ApiFailure catch (failure) {
        if (failure.kind == ApiFailureKind.notFound) continue; // withdrawn since
        rethrow;
      }
      // A detail older than the change is a stale cache; skip it rather than describe the wrong version.
      if (detail.version < change.version) continue;
      notified.add('${change.eventId}:${change.version}');
      if (matchesInterests(detail, interests)) {
        matched.add(notificationFor(detail, change.changeType));
      }
    }

    for (final content in matched.take(notifyMaxPerRun)) {
      await show(content);
    }
    if (matched.length > notifyMaxPerRun) {
      await show(summaryNotification(matched.length - notifyMaxPerRun));
    }
    final kept = notified.length > notifyRememberedKeys
        ? notified.sublist(notified.length - notifyRememberedKeys)
        : notified;
    await storage.setString(
        notifyStateKey, NotifyState(cursor: cursor, notified: kept).toJson());
    return NotifyRunResult(NotifyRunOutcome.checked,
        shown: matched.length.clamp(0, notifyMaxPerRun) +
            (matched.length > notifyMaxPerRun ? 1 : 0));
  } catch (_) {
    // Quiet: the next scheduled run tries again. Notifications are a convenience, not the feed of record.
    return const NotifyRunResult(NotifyRunOutcome.failed);
  }
}
