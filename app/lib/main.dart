import 'package:flutter/material.dart';

import 'settings.dart';
import 'theme.dart';
import 'screens/sessions_screen.dart';
import 'screens/settings_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await VbThemeController.load();
  runApp(const VoiceBridgeApp());
}

class VoiceBridgeApp extends StatelessWidget {
  const VoiceBridgeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: VbThemeController.isDark,
      builder: (_, dark, __) {
        VbColors.setPalette(dark ? VbPalette.dark : VbPalette.light);
        return MaterialApp(
          title: 'voicebridge',
          debugShowCheckedModeBanner: false,
          theme: VbTheme.themed(),
          home: const _Bootstrap(),
        );
      },
    );
  }
}

/// Load saved settings, then go to the session list (or to setup if the bridge
/// URL hasn't been configured yet).
class _Bootstrap extends StatefulWidget {
  const _Bootstrap();

  @override
  State<_Bootstrap> createState() => _BootstrapState();
}

class _BootstrapState extends State<_Bootstrap> {
  AppSettings? _settings;

  @override
  void initState() {
    super.initState();
    AppSettings.load().then((s) => setState(() => _settings = s));
  }

  @override
  Widget build(BuildContext context) {
    final s = _settings;
    if (s == null) {
      return Scaffold(
        backgroundColor: VbColors.bg,
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 76,
                height: 76,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(20),
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [VbColors.accentBright, VbColors.accentDim],
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: VbColors.accent.withValues(alpha: 0.35),
                      blurRadius: 28,
                      spreadRadius: 2,
                    ),
                  ],
                ),
                child: const Icon(Icons.graphic_eq_rounded,
                    color: Color(0xFF06210C), size: 40),
              ),
              const SizedBox(height: 22),
              Text('voicebridge',
                  style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.3,
                      color: VbColors.textPrimary)),
              const SizedBox(height: 20),
              const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2.4),
              ),
            ],
          ),
        ),
      );
    }
    if (!s.isConfigured) return SettingsScreen(settings: s);
    return SessionsScreen(settings: s);
  }
}
