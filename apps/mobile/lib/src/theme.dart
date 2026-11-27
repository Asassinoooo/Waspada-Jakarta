import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

/// MOBILE-V2: the Waspada Jakarta palette. Warm "paper" surfaces, deep petrol ink and a signal scale that runs amber to
/// deep red. There is deliberately no green "safe" colour anywhere: an absent report never means an area is safe.
///
/// [WaspadaColors] keeps the light values as constants for painters and legacy call sites. Widgets that should follow
/// dark mode read [WaspadaPalette] through `context.palette`.
abstract final class WaspadaColors {
  static const canvas = Color(0xFFF4F4F2); // Kertas
  static const ink = Color(0xFF0E1112); // Tinta
  static const teal = Color(0xFF0B6B66); // Kali Teal
  static const concrete = Color(0xFFE2E2DE); // Garis
  static const caution = Color(0xFFF2B84B); // Kuning Perhatian
  static const marker = Color(0xFFC0392B); // Merah Tanda
  static const white = Color(0xFFFFFFFF);
  static const softPanel = Color(0xFFECECE9);
}

const _fontFamily = 'PlusJakartaSans';

@immutable
class WaspadaPalette extends ThemeExtension<WaspadaPalette> {
  const WaspadaPalette({
    required this.canvas,
    required this.surface,
    required this.surfaceAlt,
    required this.ink,
    required this.inkMuted,
    required this.line,
    required this.brand,
    required this.onBrand,
    required this.brandSoft,
    required this.signalLow,
    required this.signalMedium,
    required this.signalHigh,
    required this.signalCritical,
    required this.onSignal,
    required this.demo,
    required this.heroStart,
    required this.heroEnd,
  });

  final Color canvas;
  final Color surface;
  final Color surfaceAlt;
  final Color ink;
  final Color inkMuted;
  final Color line;
  final Color brand;
  final Color onBrand;
  final Color brandSoft;
  final Color signalLow;
  final Color signalMedium;
  final Color signalHigh;
  final Color signalCritical;
  final Color onSignal;
  final Color demo;
  final Color heroStart;
  final Color heroEnd;

  static const light = WaspadaPalette(
    canvas: Color(0xFFF4F4F2),
    surface: Color(0xFFFFFFFF),
    surfaceAlt: Color(0xFFECECE9),
    ink: Color(0xFF0E1112),
    inkMuted: Color(0xFF565D60),
    line: Color(0xFFE2E2DE),
    brand: Color(0xFF0B6B66),
    onBrand: Color(0xFFFFFFFF),
    brandSoft: Color(0xFFE3EFEE),
    signalLow: Color(0xFFF6D77A),
    signalMedium: Color(0xFFF2A541),
    signalHigh: Color(0xFFE4572E),
    signalCritical: Color(0xFFA4161A),
    onSignal: Color(0xFF0E1112),
    demo: Color(0xFFF2B84B),
    heroStart: Color(0xFF0E1112),
    heroEnd: Color(0xFF1B2022),
  );

  static const dark = WaspadaPalette(
    canvas: Color(0xFF0B0D0E),
    surface: Color(0xFF131617),
    surfaceAlt: Color(0xFF1A1E1F),
    ink: Color(0xFFEDEFEF),
    inkMuted: Color(0xFF9CA3A5),
    line: Color(0xFF262B2D),
    brand: Color(0xFF5DC4BA),
    onBrand: Color(0xFF04211F),
    brandSoft: Color(0xFF132A28),
    signalLow: Color(0xFFE9C766),
    signalMedium: Color(0xFFF0A04B),
    signalHigh: Color(0xFFF26B45),
    signalCritical: Color(0xFFE0474C),
    onSignal: Color(0xFF0B0D0E),
    demo: Color(0xFFE9B04A),
    heroStart: Color(0xFF16191A),
    heroEnd: Color(0xFF0B0D0E),
  );

  @override
  WaspadaPalette copyWith() => this;

  @override
  WaspadaPalette lerp(ThemeExtension<WaspadaPalette>? other, double t) {
    if (other is! WaspadaPalette) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return WaspadaPalette(
      canvas: l(canvas, other.canvas),
      surface: l(surface, other.surface),
      surfaceAlt: l(surfaceAlt, other.surfaceAlt),
      ink: l(ink, other.ink),
      inkMuted: l(inkMuted, other.inkMuted),
      line: l(line, other.line),
      brand: l(brand, other.brand),
      onBrand: l(onBrand, other.onBrand),
      brandSoft: l(brandSoft, other.brandSoft),
      signalLow: l(signalLow, other.signalLow),
      signalMedium: l(signalMedium, other.signalMedium),
      signalHigh: l(signalHigh, other.signalHigh),
      signalCritical: l(signalCritical, other.signalCritical),
      onSignal: l(onSignal, other.onSignal),
      demo: l(demo, other.demo),
      heroStart: l(heroStart, other.heroStart),
      heroEnd: l(heroEnd, other.heroEnd),
    );
  }
}

extension WaspadaThemeContext on BuildContext {
  WaspadaPalette get palette =>
      Theme.of(this).extension<WaspadaPalette>() ?? WaspadaPalette.light;
}

/// Radii and spacing shared by the screens.
abstract final class WaspadaShape {
  static const card = 20.0;
  static const control = 14.0;
  static const pill = 999.0;
}

ThemeData buildWaspadaTheme({Brightness brightness = Brightness.light}) {
  final p = brightness == Brightness.dark
      ? WaspadaPalette.dark
      : WaspadaPalette.light;
  final scheme = ColorScheme.fromSeed(
    seedColor: p.brand,
    brightness: brightness,
    primary: p.brand,
    onPrimary: p.onBrand,
    secondary: p.ink,
    onSecondary: p.canvas,
    surface: p.surface,
    onSurface: p.ink,
    surfaceContainerHighest: p.surfaceAlt,
    outline: p.line,
    outlineVariant: p.line,
    error: p.signalCritical,
    onError: Colors.white,
  );

  TextStyle t(double size, double height, FontWeight weight,
          {double spacing = 0}) =>
      TextStyle(
          fontFamily: _fontFamily,
          fontSize: size,
          height: height,
          fontWeight: weight,
          letterSpacing: spacing,
          color: p.ink);

  final textTheme = TextTheme(
    displayLarge: t(48, 1.04, FontWeight.w800, spacing: -1.6),
    displayMedium: t(40, 1.06, FontWeight.w800, spacing: -1.2),
    displaySmall: t(34, 1.08, FontWeight.w800, spacing: -1.0),
    headlineMedium: t(26, 1.15, FontWeight.w800, spacing: -0.6),
    headlineSmall: t(22, 1.2, FontWeight.w700, spacing: -0.4),
    titleLarge: t(19, 1.28, FontWeight.w700, spacing: -0.2),
    titleMedium: t(16, 1.35, FontWeight.w700),
    titleSmall: t(14, 1.35, FontWeight.w700),
    bodyLarge: t(16, 1.55, FontWeight.w400),
    bodyMedium: t(14, 1.5, FontWeight.w400).copyWith(color: p.ink),
    bodySmall: t(13, 1.45, FontWeight.w500).copyWith(color: p.inkMuted),
    labelLarge: t(14, 1.2, FontWeight.w700),
    labelMedium: t(12.5, 1.2, FontWeight.w600).copyWith(color: p.inkMuted),
    labelSmall: t(11.5, 1.2, FontWeight.w700, spacing: 0.6),
  );

  final controlShape =
      RoundedRectangleBorder(borderRadius: BorderRadius.circular(WaspadaShape.control));

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    fontFamily: _fontFamily,
    extensions: [p],
    scaffoldBackgroundColor: p.canvas,
    canvasColor: p.canvas,
    textTheme: textTheme,
    splashFactory: InkSparkle.splashFactory,
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
      TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
    }),
    appBarTheme: AppBarTheme(
      backgroundColor: p.canvas,
      foregroundColor: p.ink,
      surfaceTintColor: Colors.transparent,
      centerTitle: false,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      titleTextStyle: t(18, 1.2, FontWeight.w800, spacing: -0.3),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: p.surface,
      surfaceTintColor: Colors.transparent,
      indicatorColor: p.brandSoft,
      elevation: 0,
      height: 68,
      labelTextStyle: WidgetStateProperty.resolveWith((states) => t(
          12, 1.2,
          states.contains(WidgetState.selected)
              ? FontWeight.w800
              : FontWeight.w600)),
      iconTheme: WidgetStateProperty.resolveWith((states) => IconThemeData(
          color: states.contains(WidgetState.selected) ? p.brand : p.inkMuted)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.surface,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
      labelStyle: TextStyle(color: p.inkMuted, fontFamily: _fontFamily),
      border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(WaspadaShape.control),
          borderSide: BorderSide(color: p.line)),
      enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(WaspadaShape.control),
          borderSide: BorderSide(color: p.line)),
      focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(WaspadaShape.control),
          borderSide: BorderSide(color: p.brand, width: 2)),
    ),
    cardTheme: CardThemeData(
      color: p.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(WaspadaShape.card),
          side: BorderSide(color: p.line)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
          minimumSize: const Size(48, 52),
          padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 14),
          textStyle: t(15, 1.2, FontWeight.w800),
          shape: controlShape),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
          minimumSize: const Size(48, 52),
          foregroundColor: p.ink,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          textStyle: t(15, 1.2, FontWeight.w700),
          shape: controlShape,
          side: BorderSide(color: p.line, width: 1.2)),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
          minimumSize: const Size(48, 48),
          foregroundColor: p.brand,
          textStyle: t(14, 1.2, FontWeight.w700),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10)),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: SegmentedButton.styleFrom(
        backgroundColor: p.surface,
        selectedBackgroundColor: p.ink,
        selectedForegroundColor: p.canvas,
        foregroundColor: p.ink,
        side: BorderSide(color: p.line),
        textStyle: t(13.5, 1.2, FontWeight.w700),
      ),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: p.surfaceAlt,
      selectedColor: p.brandSoft,
      side: BorderSide(color: p.line),
      labelStyle: t(13, 1.3, FontWeight.w600),
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(WaspadaShape.pill)),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: p.surface,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
      dragHandleColor: p.line,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
        color: p.brand, linearTrackColor: p.surfaceAlt),
    dividerTheme: DividerThemeData(color: p.line, thickness: 1, space: 1),
    dividerColor: p.line,
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: p.ink,
      contentTextStyle: t(14, 1.4, FontWeight.w600).copyWith(color: p.canvas),
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(WaspadaShape.control)),
    ),
    visualDensity: VisualDensity.standard,
  );
}
