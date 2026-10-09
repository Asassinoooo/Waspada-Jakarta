import 'package:flutter/material.dart';

import 'src/app.dart';
import 'src/preferences.dart';
import 'src/public_api.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    WaspadaApp(
      api: HttpPublicApi.fromEnvironment(),
      preferences: PreferencesRepository(SharedPreferencesStorage()),
    ),
  );
}
