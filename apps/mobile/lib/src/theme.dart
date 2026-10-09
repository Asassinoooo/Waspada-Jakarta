import 'package:flutter/material.dart';

abstract final class WaspadaColors {
  static const canvas = Color(0xFFF4F7F5); // Hujan Pagi
  static const ink = Color(0xFF18323A); // Tinta Kota
  static const teal = Color(0xFF087B75); // Kali Teal
  static const concrete = Color(0xFFD5DEDB); // Beton
  static const caution = Color(0xFFE7B448); // Kuning Perhatian
  static const marker = Color(0xFFA7433B); // Merah Tanda
  static const white = Color(0xFFFFFFFF);
  static const softPanel = Color(0xFFEAF0ED);
}

ThemeData buildWaspadaTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: WaspadaColors.teal,
    brightness: Brightness.light,
    primary: WaspadaColors.teal,
    onPrimary: WaspadaColors.white,
    secondary: WaspadaColors.ink,
    onSecondary: WaspadaColors.white,
    surface: WaspadaColors.white,
    onSurface: WaspadaColors.ink,
    error: WaspadaColors.marker,
    onError: WaspadaColors.white,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: WaspadaColors.canvas,
    textTheme: const TextTheme(
      displaySmall: TextStyle(
          fontSize: 36,
          height: 1.12,
          fontWeight: FontWeight.w700,
          color: WaspadaColors.ink),
      headlineMedium: TextStyle(
          fontSize: 28,
          height: 1.2,
          fontWeight: FontWeight.w700,
          color: WaspadaColors.ink),
      titleLarge: TextStyle(
          fontSize: 21,
          height: 1.25,
          fontWeight: FontWeight.w700,
          color: WaspadaColors.ink),
      titleMedium: TextStyle(
          fontSize: 17,
          height: 1.35,
          fontWeight: FontWeight.w600,
          color: WaspadaColors.ink),
      bodyLarge:
          TextStyle(fontSize: 16, height: 1.55, color: WaspadaColors.ink),
      bodyMedium:
          TextStyle(fontSize: 14, height: 1.5, color: WaspadaColors.ink),
      bodySmall:
          TextStyle(fontSize: 14, height: 1.45, color: WaspadaColors.ink),
      labelLarge: TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: WaspadaColors.canvas,
      foregroundColor: WaspadaColors.ink,
      centerTitle: false,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleTextStyle: TextStyle(
          fontSize: 18, fontWeight: FontWeight.w700, color: WaspadaColors.ink),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: WaspadaColors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: WaspadaColors.concrete)),
      enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: WaspadaColors.concrete)),
      focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: WaspadaColors.teal, width: 2)),
    ),
    cardTheme: CardThemeData(
      color: WaspadaColors.white,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: const BorderSide(color: WaspadaColors.concrete)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
          minimumSize: const Size(48, 48),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
          minimumSize: const Size(48, 48),
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          side: const BorderSide(color: WaspadaColors.concrete)),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
          minimumSize: const Size(48, 48),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10)),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: WaspadaColors.softPanel,
      selectedColor: WaspadaColors.teal.withValues(alpha: 0.12),
      side: const BorderSide(color: WaspadaColors.concrete),
      labelStyle:
          const TextStyle(fontSize: 13, height: 1.3, color: WaspadaColors.ink),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    ),
    dividerColor: WaspadaColors.concrete,
    visualDensity: VisualDensity.standard,
  );
}
