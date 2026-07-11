import 'package:shared_preferences/shared_preferences.dart';

/// Where the bridge lives (e.g. your Tailscale HTTPS URL) plus an optional
/// access token, persisted on the device.
class AppSettings {
  String baseUrl;
  String token;

  /// Whether the first-run explainer (see [OnboardingScreen]) has been shown
  /// or skipped. Distinct from [isConfigured]: a user can dismiss onboarding
  /// without having connected to a bridge yet, and it should not reappear.
  bool hasSeenOnboarding;

  AppSettings({
    this.baseUrl = '',
    this.token = '',
    this.hasSeenOnboarding = false,
  });

  bool get isConfigured => baseUrl.trim().isNotEmpty;

  /// Normalized base with no trailing slash.
  String get base {
    var b = baseUrl.trim();
    while (b.endsWith('/')) {
      b = b.substring(0, b.length - 1);
    }
    return b;
  }

  static Future<AppSettings> load() async {
    final p = await SharedPreferences.getInstance();
    return AppSettings(
      baseUrl: p.getString('baseUrl') ?? '',
      token: p.getString('token') ?? '',
      hasSeenOnboarding: p.getBool('hasSeenOnboarding') ?? false,
    );
  }

  Future<void> save() async {
    final p = await SharedPreferences.getInstance();
    await p.setString('baseUrl', baseUrl.trim());
    await p.setString('token', token.trim());
  }

  /// Persisted separately from [save] so dismissing onboarding doesn't
  /// require (or wait on) a successful bridge connection.
  Future<void> markOnboardingSeen() async {
    hasSeenOnboarding = true;
    final p = await SharedPreferences.getInstance();
    await p.setBool('hasSeenOnboarding', true);
  }
}
