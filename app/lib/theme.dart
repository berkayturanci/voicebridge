import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// App-wide light/dark switch. Persisted across launches; default dark. Listen to
/// [isDark] to rebuild the app (and re-point [VbColors]) when it changes.
class VbThemeController {
  VbThemeController._();
  static final ValueNotifier<bool> isDark = ValueNotifier<bool>(true);
  static const _key = 'vb_theme_dark';

  static Future<void> load() async {
    try {
      final v = (await SharedPreferences.getInstance()).getBool(_key);
      if (v != null) isDark.value = v;
    } catch (_) {}
    VbColors.setPalette(isDark.value ? VbPalette.dark : VbPalette.light);
  }

  static Future<void> set(bool dark) async {
    VbColors.setPalette(dark ? VbPalette.dark : VbPalette.light);
    isDark.value = dark; // notifies listeners -> app rebuilds with the new theme
    try {
      await (await SharedPreferences.getInstance()).setBool(_key, dark);
    } catch (_) {}
  }
}

/// One named palette (dark or light). Same keys; different values.
class VbPalette {
  final Brightness brightness;
  final Color accent, accentDim, accentBright;
  final Color bg, surface, surfaceHigh, border, textPrimary, textMuted;
  final Color danger, warning, info;
  const VbPalette({
    required this.brightness,
    required this.accent,
    required this.accentDim,
    required this.accentBright,
    required this.bg,
    required this.surface,
    required this.surfaceHigh,
    required this.border,
    required this.textPrimary,
    required this.textMuted,
    required this.danger,
    required this.warning,
    required this.info,
  });

  // GitHub-dark surface palette with a signature brand-green accent.
  static const VbPalette dark = VbPalette(
    brightness: Brightness.dark,
    accent: Color(0xFF3FB950),
    accentDim: Color(0xFF2EA043),
    accentBright: Color(0xFF56D364),
    bg: Color(0xFF0D1117),
    surface: Color(0xFF161B22),
    surfaceHigh: Color(0xFF1C2230),
    border: Color(0xFF30363D),
    textPrimary: Color(0xFFE6EDF3),
    textMuted: Color(0xFF8B949E),
    danger: Color(0xFFF85149),
    warning: Color(0xFFD29922),
    info: Color(0xFF58A6FF),
  );

  // GitHub-light surface palette; accent darkened for contrast on white.
  static const VbPalette light = VbPalette(
    brightness: Brightness.light,
    accent: Color(0xFF1F883D),
    accentDim: Color(0xFF1A7F37),
    accentBright: Color(0xFF2DA44E),
    bg: Color(0xFFFFFFFF),
    surface: Color(0xFFF6F8FA),
    surfaceHigh: Color(0xFFEAEEF2),
    border: Color(0xFFD0D7DE),
    textPrimary: Color(0xFF1F2328),
    textMuted: Color(0xFF656D76),
    danger: Color(0xFFCF222E),
    warning: Color(0xFF9A6700),
    info: Color(0xFF0969DA),
  );
}

/// voicebridge design system — a swappable palette so the app supports both a
/// GitHub-dark and a GitHub-light theme. `VbColors.x` reads from the active
/// palette (so call sites can't be `const`); set it via [setPalette].
class VbColors {
  VbColors._();

  static VbPalette _p = VbPalette.dark;
  static VbPalette get active => _p;
  static void setPalette(VbPalette p) => _p = p;

  // Brand
  static Color get accent => _p.accent; // signature green
  static Color get accentDim => _p.accentDim;
  static Color get accentBright => _p.accentBright;

  // Surface palette
  static Color get bg => _p.bg;
  static Color get surface => _p.surface;
  static Color get surfaceHigh => _p.surfaceHigh;
  static Color get border => _p.border;
  static Color get textPrimary => _p.textPrimary;
  static Color get textMuted => _p.textMuted;

  // Semantic
  static Color get danger => _p.danger;
  static Color get warning => _p.warning;
  static Color get info => _p.info;

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

  // Readable text/icon color on top of the accent fill (dark-green ink on the
  // bright dark-mode accent; white on the darker light-mode accent).
  static Color get _onAccent => VbColors.active.brightness == Brightness.dark
      ? const Color(0xFF06210C)
      : Colors.white;

  /// Builds the theme for the currently-active palette (dark or light).
  static ThemeData themed() {
    final scheme = ColorScheme.fromSeed(
      seedColor: VbColors.accent,
      brightness: VbColors.active.brightness,
    ).copyWith(
      primary: VbColors.accent,
      onPrimary: _onAccent,
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
      brightness: VbColors.active.brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: VbColors.bg,
      canvasColor: VbColors.bg,
      dividerColor: VbColors.border,
      splashFactory: InkSparkle.splashFactory,
    );

    return base.copyWith(
      textTheme: _textTheme(base.textTheme, VbColors.textPrimary, VbColors.textMuted),
      appBarTheme: AppBarTheme(
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
          side: BorderSide(color: VbColors.border),
        ),
      ),
      dividerTheme: DividerThemeData(
        color: VbColors.border,
        thickness: 1,
        space: 1,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: VbColors.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        hintStyle: TextStyle(color: VbColors.textMuted),
        labelStyle: TextStyle(color: VbColors.textMuted),
        floatingLabelStyle: TextStyle(color: VbColors.accent),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(VbRadius.field),
          borderSide: BorderSide(color: VbColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(VbRadius.field),
          borderSide: BorderSide(color: VbColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(VbRadius.field),
          borderSide: BorderSide(color: VbColors.accent, width: 1.6),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(VbRadius.field),
          borderSide: BorderSide(color: VbColors.danger),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(VbRadius.field),
          borderSide: BorderSide(color: VbColors.danger, width: 1.6),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: VbColors.accent,
          foregroundColor: _onAccent,
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
          side: BorderSide(color: VbColors.border),
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
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: VbColors.accent,
        foregroundColor: _onAccent,
        elevation: 2,
        highlightElevation: 4,
      ),
      iconTheme: IconThemeData(color: VbColors.textPrimary),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(foregroundColor: VbColors.textPrimary),
      ),
      listTileTheme: ListTileThemeData(
        iconColor: VbColors.textMuted,
        textColor: VbColors.textPrimary,
      ),
      chipTheme: ChipThemeData(
        backgroundColor: VbColors.surfaceHigh,
        side: BorderSide(color: VbColors.border),
        labelStyle: TextStyle(fontSize: 12, color: VbColors.textMuted),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(VbRadius.chip),
        ),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: VbColors.surface,
        surfaceTintColor: Colors.transparent,
        modalBackgroundColor: VbColors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: VbColors.surface,
        surfaceTintColor: Colors.transparent,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: VbColors.surfaceHigh,
        contentTextStyle: TextStyle(color: VbColors.textPrimary),
        actionTextColor: VbColors.accent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(VbRadius.button),
        ),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: VbColors.accent,
      ),
      dropdownMenuTheme: DropdownMenuThemeData(
        menuStyle: MenuStyle(
          backgroundColor: WidgetStatePropertyAll(VbColors.surfaceHigh),
          surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        ),
      ),
      popupMenuTheme: PopupMenuThemeData(
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
