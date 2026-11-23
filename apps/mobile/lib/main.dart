import 'package:flutter/material.dart';

import 'src/app.dart';
import 'src/notify_platform.dart';
import 'src/preferences.dart';
import 'src/public_api.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final storage = SharedPreferencesStorage();
  final app = WaspadaApp(
    api: HttpPublicApi.fromEnvironment(),
    preferences: PreferencesRepository(storage),
  );
  // NOTIFY-01: Android only. Elsewhere there is no scope, so the Minat screen shows no notification switch.
  if (!AndroidNotifyController.supported) {
    runApp(app);
    return;
  }
  final notify = AndroidNotifyController(storage);
  runApp(NotifyScope(controller: notify, child: app));
  notify.start().catchError((Object _) {});
}
