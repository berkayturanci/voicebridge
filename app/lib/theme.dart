import 'package:flutter/material.dart';

/// voicebridge design system.
///
/// A cohesive Material 3 dark theme tuned to a GitHub-dark surface palette with
/// a signature brand-green accent. Uses built-in fonts only (no extra deps) but
/// applies a deliberate type scale, rounded shapes, and refined component
/// themes. Light variant is provided as a tasteful fallback.
class VbColors {
  VbColors._();

  // Brand
  static const Color accent = Color(0xFF3FB950); // signature green
  static const Color accentDim = Color(0xFF2EA043);
  static const Color accentBright = Color(0xFF56D364);

  // GitHub-dark surface palette
  static const Color bg = Color(0xFF0D1117);
  static const Color surface = Color(0xFF161B22);
  static const Color surfaceHigh = Color(0xFF1C2230);
  static const Color border = Color(0xFF30363D);
  static const Color textPrimary = Color(0xFFE6EDF3);
  static const Color textMuted = Color(0xFF8B949E);

  // Semantic
  static const Color danger = Color(0xFFF85149);
  static const Color warning = Color(0xFFD29922);
  static const Color info = Color(0xFF58A6FF);

  /// A stable, pleasant accent color derived from an arbitrary string
  /// (e.g. a session name or agent id). Hue is hashed; saturation/lightness are
  /// fixed so every avatar reads as part of the same family.
  static Color seededFor(String input) {
    var hash = 0;
    for (final code in input.isEmpty ? const [0] : input.codeUnits) {
      hash = (hash * 31 + code) & 0x7fffffff;
    }
    final hue = (hash % 360).toDouble();
    return HSLColor.fromAHSL(1, hue, 0.52, 0.55).toColor();
  }
}

class VbRadius {
  VbRadius._();
  static const double card = 16;
  static const double button = 12;
  static const double field = 12;
  static const double chip = 8;
  static const double bubble = 18;
}

class VbTheme {
  VbTheme._();

  static const String _mono = 'monospace';

  static ThemeData dark() {
    final scheme = ColorScheme.fromSeed(
      seedColor: VbColors.accent,
      brightness: Brightness.dark,
    ).copyWith(
      primary: VbColors.accent,
      onPrimary: const Color(0xFF06210C),
      secondary: VbColors.accentBright,
      surface: VbColors.surface,
      onSurface: VbColors.textPrimary,
      surfaceContainerHighest: VbColors.surfaceHigh,
      outline: VbColors.border,
      outlineVariant: VbColors.border,
      error: VbColors.danger,
    );

    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: scheme,
      scaffoldBackgroundColor: VbColors.bg,
      canvasColor: VbColors.bg,
      dividerColor: VbColors.border,
      splashFactory: InkSparkle.splashFactory,
    );

    return base.copyWith(
      textTheme: _textTheme(base.textTheme, VbColors.textPrimary, VbColors.textMuted),
      appBarTheme: const AppBarTheme(
        backgroundColor: VbColors.bg,
        surfaceTintColor: Colors.transparent,
        foregroundColor: VbColors.textPrimary,
        elevation: 0,
        scrolledUnderElevation: 0.5,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.2,
          color: VbColors.textPrimary,
        ),
      ),
      cardTheme: CardThemeData(
        color: VbColors.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(VbRadius.card),
          side: const BorderSide(color: VbColors.border),
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: VbColors.border,
        thickness: 1,
        space: 1,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: VbColors.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        hintStyle: const TextStyle(color: VbColors.textMuted),
        labelStyle: const TextStyle(color: VbColors.textMuted),
        floatingLabelStyle: const TextStyle(color: VbColors.accent),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(VbRadius.field),
          borderSide: const BorderSide(color: VbColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(VbRadius.field),
          borderSide: const BorderSide(color: VbColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(VbRadius.field),
          borderSide: const BorderSide(color: VbColors.accent, width: 1.6),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(VbRadius.field),
          borderSide: const BorderSide(color: VbColors.danger),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(VbRadius.field),
          borderSide: const BorderSide(color: VbColors.danger, width: 1.6),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: VbColors.accent,
          foregroundColor: const Color(0xFF06210C),
          disabledBackgroundColor: VbColors.surfaceHigh,
          disabledForegroundColor: VbColors.textMuted,
          minimumSize: const Size(0, 52),
          padding: const EdgeInsets.symmetric(horizontal: 20),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(VbRadius.button),
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: VbColors.textPrimary,
          minimumSize: const Size(0, 52),
          side: const BorderSide(color: VbColors.border),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(VbRadius.button),
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: VbColors.accent,
          textStyle: const TextStyle(fontWeight: FontWeight.w600),
        ),
      ),
      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: VbColors.accent,
        foregroundColor: Color(0xFF06210C),
        elevation: 2,
        highlightElevation: 4,
      ),
      iconTheme: const IconThemeData(color: VbColors.textPrimary),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(foregroundColor: VbColors.textPrimary),
      ),
      listTileTheme: const ListTileThemeData(
        iconColor: VbColors.textMuted,
        textColor: VbColors.textPrimary,
      ),
      chipTheme: ChipThemeData(
        backgroundColor: VbColors.surfaceHigh,
        side: const BorderSide(color: VbColors.border),
        labelStyle: const TextStyle(fontSize: 12, color: VbColors.textMuted),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(VbRadius.chip),
        ),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: VbColors.surface,
        surfaceTintColor: Colors.transparent,
        modalBackgroundColor: VbColors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        ),
      ),
      dialogTheme: const DialogThemeData(
        backgroundColor: VbColors.surface,
        surfaceTintColor: Colors.transparent,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: VbColors.surfaceHigh,
        contentTextStyle: const TextStyle(color: VbColors.textPrimary),
        actionTextColor: VbColors.accent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(VbRadius.button),
        ),
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: VbColors.accent,
      ),
      dropdownMenuTheme: const DropdownMenuThemeData(
        menuStyle: MenuStyle(
          backgroundColor: WidgetStatePropertyAll(VbColors.surfaceHigh),
          surfaceTintColor: WidgetStatePropertyAll(Colors.transparent),
        ),
      ),
      popupMenuTheme: const PopupMenuThemeData(
        color: VbColors.surfaceHigh,
        surfaceTintColor: Colors.transparent,
      ),
    );
  }

  /// Monospace text style helper for code blocks / runner labels.
  static TextStyle mono({double size = 13, Color? color, FontWeight? weight}) =>
      TextStyle(
        fontFamily: _mono,
        fontSize: size,
        height: 1.45,
        color: color ?? VbColors.textPrimary,
        fontWeight: weight,
      );

  static TextTheme _textTheme(TextTheme base, Color primary, Color muted) {
    return base
        .copyWith(
          displaySmall: base.displaySmall?.copyWith(
            fontWeight: FontWeight.w700,
            letterSpacing: -0.5,
          ),
          headlineMedium: base.headlineMedium?.copyWith(
            fontWeight: FontWeight.w700,
            letterSpacing: -0.4,
          ),
          headlineSmall: base.headlineSmall?.copyWith(
            fontWeight: FontWeight.w700,
            letterSpacing: -0.3,
          ),
          titleLarge: base.titleLarge?.copyWith(
            fontSize: 20,
            fontWeight: FontWeight.w700,
            letterSpacing: -0.2,
          ),
          titleMedium: base.titleMedium?.copyWith(
            fontSize: 16,
            fontWeight: FontWeight.w600,
            letterSpacing: -0.1,
          ),
          titleSmall: base.titleSmall?.copyWith(
            fontWeight: FontWeight.w600,
          ),
          bodyLarge: base.bodyLarge?.copyWith(
            fontSize: 15.5,
            height: 1.45,
          ),
          bodyMedium: base.bodyMedium?.copyWith(
            fontSize: 14.5,
            height: 1.45,
          ),
          bodySmall: base.bodySmall?.copyWith(
            fontSize: 12.5,
            height: 1.4,
            color: muted,
          ),
          labelLarge: base.labelLarge?.copyWith(
            fontWeight: FontWeight.w600,
            letterSpacing: 0.1,
          ),
          labelSmall: base.labelSmall?.copyWith(
            fontSize: 11,
            letterSpacing: 0.4,
            color: muted,
          ),
        )
        .apply(bodyColor: primary, displayColor: primary);
  }
}
