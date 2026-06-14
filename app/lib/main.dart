import 'package:flutter/material.dart';

import 'settings.dart';
import 'screens/sessions_screen.dart';
import 'screens/settings_screen.dart';

void main() => runApp(const VoiceBridgeApp());

class VoiceBridgeApp extends StatelessWidget {
  const VoiceBridgeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'voicebridge',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        colorSchemeSeed: const Color(0xFF3fb950),
        useMaterial3: true,
      ),
      home: const _Bootstrap(),
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
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (!s.isConfigured) return SettingsScreen(settings: s);
    return SessionsScreen(settings: s);
  }
}
