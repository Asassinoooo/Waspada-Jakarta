import 'dart:ui' show DartPluginRegistrant;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:workmanager/workmanager.dart';

import 'interest_notifications.dart';
import 'preferences.dart';
import 'public_api.dart';

/// NOTIFY-01: the Android glue around [runNotifyCycle]. A periodic WorkManager task (15 minutes, the OS minimum,
/// network required) runs the cycle in a background isolate and shows local notifications. A tap opens the event.
const notifyUniqueWork = 'waspada-area-saya';
const notifyTaskName = 'waspada.notify.area-saya';
const _channelId = 'area_saya';
const _channelName = 'Area saya';
const _channelDescription =
    'Laporan terbit atau diperbarui yang cocok dengan minat di perangkat ini. Bukan peringatan darurat.';

final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();

const _details = NotificationDetails(
  android: AndroidNotificationDetails(
    _channelId,
    _channelName,
    channelDescription: _channelDescription,
    importance: Importance.defaultImportance,
    priority: Priority.defaultPriority,
    styleInformation: BigTextStyleInformation(''),
    category: AndroidNotificationCategory.recommendation,
  ),
);

Future<void> _initPlugin(
    {DidReceiveNotificationResponseCallback? onTap}) async {
  await _plugin.initialize(
    const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher')),
    onDidReceiveNotificationResponse: onTap,
  );
}

Future<void> _show(NotifyContent content) => _plugin.show(
    content.id, content.title, content.body, _details,
    payload: content.eventId ?? '');

/// Runs in the WorkManager background isolate.
@pragma('vm:entry-point')
void notifyCallbackDispatcher() {
  Workmanager().executeTask((task, _) async {
    if (task != notifyTaskName) return true;
    WidgetsFlutterBinding.ensureInitialized();
    DartPluginRegistrant.ensureInitialized();
    final storage = SharedPreferencesStorage();
    final saved = await PreferencesRepository(storage).load();
    if (saved.status != PreferenceLoadStatus.loaded) return true;
    await _initPlugin();
    await runNotifyCycle(
      api: HttpPublicApi.fromEnvironment(),
      storage: storage,
      interests: saved.interests,
      show: _show,
    );
    // Always "success": a failed poll waits for the next period instead of a retry storm.
    return true;
  });
}

enum NotifyToggleResult { on, off, permissionDenied, unavailable }

/// What the Minat screen needs. Tests pass a fake; production uses [AndroidNotifyController].
abstract class NotifyController {
  /// Event ids from tapped notifications, for [HomeShell] to open.
  ValueListenable<String?> get openRequests;
  Future<bool> isEnabled();
  Future<NotifyToggleResult> enable();
  Future<NotifyToggleResult> disable();
  void consumeOpenRequest();
}

class AndroidNotifyController implements NotifyController {
  AndroidNotifyController(this._storage);
  final KeyValueStorage _storage;
  final _open = ValueNotifier<String?>(null);

  static bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  /// Called once from main. Wires taps and re-registers the task if it was on (idempotent: KEEP policy).
  Future<void> start() async {
    if (!supported) return;
    await _initPlugin(onTap: (response) => _open.value = response.payload);
    final launch = await _plugin.getNotificationAppLaunchDetails();
    if (launch?.didNotificationLaunchApp == true) {
      _open.value = launch!.notificationResponse?.payload;
    }
    await Workmanager().initialize(notifyCallbackDispatcher);
    if (await readNotifyEnabled(_storage)) await _schedule();
  }

  Future<void> _schedule() => Workmanager().registerPeriodicTask(
        notifyUniqueWork,
        notifyTaskName,
        frequency: const Duration(minutes: 15),
        constraints: Constraints(networkType: NetworkType.connected),
        existingWorkPolicy: ExistingPeriodicWorkPolicy.keep,
      );

  @override
  ValueListenable<String?> get openRequests => _open;

  @override
  void consumeOpenRequest() => _open.value = null;

  @override
  Future<bool> isEnabled() => readNotifyEnabled(_storage);

  @override
  Future<NotifyToggleResult> enable() async {
    if (!supported) return NotifyToggleResult.unavailable;
    final android = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    final granted = await android?.requestNotificationsPermission() ?? false;
    if (!granted) return NotifyToggleResult.permissionDenied;
    if (!await writeNotifyEnabled(_storage, true)) {
      return NotifyToggleResult.unavailable;
    }
    await _schedule();
    return NotifyToggleResult.on;
  }

  @override
  Future<NotifyToggleResult> disable() async {
    await writeNotifyEnabled(_storage, false);
    if (supported) await Workmanager().cancelByUniqueName(notifyUniqueWork);
    return NotifyToggleResult.off;
  }
}

/// Gives the Minat screen and [HomeShell] the controller without threading it through every constructor.
class NotifyScope extends InheritedWidget {
  const NotifyScope({super.key, required this.controller, required super.child});
  final NotifyController controller;

  static NotifyController? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<NotifyScope>()?.controller;

  @override
  bool updateShouldNotify(NotifyScope oldWidget) =>
      controller != oldWidget.controller;
}
