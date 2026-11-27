# MOBILE-RECENT-01 build evidence (23 Nov 2026)

Run in WSL Ubuntu-26.04 with Flutter 3.47.7, from `apps/mobile` on branch `work/MOBILE-RECENT-01`:

| Check | Result |
| --- | --- |
| `flutter analyze` | No issues found |
| `flutter test` | 61 passed, 0 failed (4 new MOBILE-RECENT-01 tests in `test/mobile_v2_test.dart`) |
| `flutter build apk --debug` | Built `build/app/outputs/flutter-apk/app-debug.apk`, 159,142,748 bytes, sha256 `c170e0483609d1683c0945bb9f901322958843c5f89b0f278ed4da9c02fc8027` |

The APK is a debug build and is not committed (size). It was not installed on a device or emulator in this run.
