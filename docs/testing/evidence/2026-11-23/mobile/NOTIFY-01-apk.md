# NOTIFY-01 Android build evidence (23 Nov 2026)

Branch `work/NOTIFY-01`, Flutter 3.47.7, WSL Ubuntu 26.04.

| Check | Result |
| --- | --- |
| `flutter analyze` | No issues found |
| `flutter test` | 71 passed (10 new in `test/notify_01_test.dart`) |
| `flutter build apk --debug` | Built, 162,205,137 bytes |
| APK sha256 | `0bd0f5ec12e0d90a0a24520f5e445be424dc2a2007d07bb07eb2a9166c58516b` |

New dependencies (exact pins, `pubspec.lock`): `workmanager 0.10.10`, `flutter_local_notifications 19.5.0`
(23.x needs compileSdk 37, which the local SDK does not have). Core library desugaring is enabled, as the plugin requires.

Merged APK permissions: INTERNET, POST_NOTIFICATIONS (asked at runtime only when the switch is turned on), and from the
WorkManager/notification plugin manifests VIBRATE, WAKE_LOCK, ACCESS_NETWORK_STATE, RECEIVE_BOOT_COMPLETED,
FOREGROUND_SERVICE, FOREGROUND_SERVICE_SHORT_SERVICE.

Not verified on a device or emulator: the background run, the permission prompt and a tap opening the detail were not
exercised; the cycle logic is covered by the unit tests above with a fake API and storage. The APK is not committed.
