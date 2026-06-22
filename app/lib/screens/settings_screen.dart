import 'package:flutter/material.dart';

import '../api.dart';
import '../settings.dart';
import '../theme.dart';
import 'sessions_screen.dart';

/// Where the bridge is. The app talks to your machine's voicebridge over the
/// network — typically a Tailscale HTTPS URL (HTTPS is required for the OS to
/// allow background networking and is good practice for the token).
class SettingsScreen extends StatefulWidget {
  final AppSettings settings;
  const SettingsScreen({super.key, required this.settings});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController _url =
      TextEditingController(text: widget.settings.baseUrl);
  late final TextEditingController _token =
      TextEditingController(text: widget.settings.token);
  bool _busy = false;
  bool _obscure = true;
  String? _error;

  bool get _isFirstRun => !Navigator.canPop(context);

  Future<void> _saveAndTest() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    widget.settings
      ..baseUrl = _url.text
      ..token = _token.text;
    try {
      final api = Api(widget.settings);
      final cfg = await api.config(); // reachability
      if (cfg['authRequired'] == true) {
        await api.sessions(); // authed call → 401 if the token is wrong
      }
      await widget.settings.save();
      if (!mounted) return;
      // When opened from the list we pop back; when this is the first-run
      // screen there's nothing to pop, so go straight to the session list.
      if (Navigator.canPop(context)) {
        Navigator.pop(context, true);
      } else {
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(
              builder: (_) => SessionsScreen(settings: widget.settings)),
        );
      }
    } catch (e) {
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final firstRun = _isFirstRun;
    return Scaffold(
      appBar: firstRun
          ? null
          : AppBar(title: const Text('Bridge settings')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 8, 22, 28),
          children: [
            if (firstRun) ...[
              const SizedBox(height: 28),
              Center(child: _logo()),
              const SizedBox(height: 22),
              Text(
                'voicebridge',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 26,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.5,
                  color: VbColors.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Type and talk to Claude Code from your phone.\n'
                'Enter the bridge address to get started.',
                textAlign: TextAlign.center,
                style: TextStyle(
                    fontSize: 14, color: VbColors.textMuted, height: 1.5),
              ),
              const SizedBox(height: 34),
            ] else
              const SizedBox(height: 12),
            _label('Bridge URL'),
            const SizedBox(height: 8),
            TextField(
              controller: _url,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.link_rounded),
                hintText: 'https://mac.tail-xxxx.ts.net',
              ),
            ),
            const SizedBox(height: 20),
            _label('Access token'),
            const SizedBox(height: 8),
            TextField(
              controller: _token,
              obscureText: _obscure,
              autocorrect: false,
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.key_rounded),
                hintText: 'optional',
                suffixIcon: IconButton(
                  onPressed: () => setState(() => _obscure = !_obscure),
                  icon: Icon(_obscure
                      ? Icons.visibility_outlined
                      : Icons.visibility_off_outlined),
                ),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 18),
              Container(
                padding: const EdgeInsets.all(13),
                decoration: BoxDecoration(
                  color: VbColors.danger.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(VbRadius.field),
                  border: Border.all(
                      color: VbColors.danger.withValues(alpha: 0.4)),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.error_outline_rounded,
                        size: 19, color: VbColors.danger),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        _error!,
                        style: TextStyle(
                            color: VbColors.danger,
                            fontSize: 13.5,
                            height: 1.4),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 26),
            FilledButton.icon(
              onPressed: _busy ? null : _saveAndTest,
              icon: _busy
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.2, color: Color(0xFF06210C)))
                  : const Icon(Icons.arrow_forward_rounded),
              label: Text(_busy
                  ? 'Connecting…'
                  : firstRun
                      ? 'Connect'
                      : 'Test & Save'),
            ),
            const SizedBox(height: 24),
            _label('Appearance'),
            const SizedBox(height: 8),
            _themeToggle(),
            const SizedBox(height: 22),
            _hint(),
          ],
        ),
      ),
    );
  }

  Widget _themeToggle() {
    return ValueListenableBuilder<String>(
      valueListenable: VbThemeController.mode,
      builder: (_, mode, __) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: VbColors.surface,
          borderRadius: BorderRadius.circular(VbRadius.card),
          border: Border.all(color: VbColors.border),
        ),
        child: Row(
          children: [
            Icon(Icons.brightness_6_rounded, size: 20, color: VbColors.accent),
            const SizedBox(width: 12),
            Expanded(
              child: Text('Theme',
                  style: TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w600,
                      color: VbColors.textPrimary)),
            ),
            _themeSeg('system', 'System', mode == 'system'),
            _themeSeg('light', 'Light', mode == 'light'),
            _themeSeg('dark', 'Dark', mode == 'dark'),
          ],
        ),
      ),
    );
  }

  Widget _themeSeg(String id, String label, bool selected) {
    return Padding(
      padding: const EdgeInsets.only(left: 6),
      child: Material(
        color: selected
            ? VbColors.accent.withValues(alpha: 0.16)
            : VbColors.surfaceHigh,
        borderRadius: BorderRadius.circular(9),
        child: InkWell(
          borderRadius: BorderRadius.circular(9),
          onTap: () => VbThemeController.setMode(id),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
            child: Text(label,
                style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: selected ? VbColors.accent : VbColors.textMuted)),
          ),
        ),
      ),
    );
  }

  Widget _logo() {
    return Container(
      width: 88,
      height: 88,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [VbColors.accentBright, VbColors.accentDim],
        ),
        boxShadow: [
          BoxShadow(
            color: VbColors.accent.withValues(alpha: 0.38),
            blurRadius: 34,
            spreadRadius: 2,
          ),
        ],
      ),
      child: const Icon(Icons.graphic_eq_rounded,
          color: Color(0xFF06210C), size: 46),
    );
  }

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(left: 4),
        child: Text(
          text,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: VbColors.textPrimary,
          ),
        ),
      );

  Widget _hint() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: VbColors.surface,
        borderRadius: BorderRadius.circular(VbRadius.card),
        border: Border.all(color: VbColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.lightbulb_outline_rounded,
              size: 18, color: VbColors.warning),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Tip',
                  style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: VbColors.textPrimary),
                ),
                const SizedBox(height: 4),
                Text(
                  'On your computer, serve the bridge over HTTPS with Tailscale:',
                  style: TextStyle(
                      fontSize: 12.5,
                      color: VbColors.textMuted,
                      height: 1.45),
                ),
                const SizedBox(height: 6),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                  decoration: BoxDecoration(
                    color: VbColors.bg,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: VbColors.border),
                  ),
                  child: Text(
                    'tailscale serve --bg 8787',
                    style: VbTheme.mono(size: 12, color: VbColors.accentBright),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
