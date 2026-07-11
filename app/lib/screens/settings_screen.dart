import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api.dart';
import '../qr_pairing.dart';
import '../settings.dart';
import '../theme.dart';
import 'qr_scan_screen.dart';
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
  static final Uri _privacyUrl = Uri.parse(
    'https://berkayturanci.github.io/voicebridge/privacy.html',
  );
  static final Uri _supportUrl = Uri.parse(
    'https://github.com/berkayturanci/voicebridge/issues',
  );
  static final Uri _docsUrl = Uri.parse(
    'https://github.com/berkayturanci/voicebridge#readme',
  );

  late final TextEditingController _url = TextEditingController(
    text: widget.settings.baseUrl,
  );
  late final TextEditingController _token = TextEditingController(
    text: widget.settings.token,
  );
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
            builder: (_) => SessionsScreen(settings: widget.settings),
          ),
        );
      }
    } catch (e) {
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _scanQr() async {
    final pairing = await Navigator.push<ScannedPairing>(
      context,
      MaterialPageRoute(builder: (_) => const QrScanScreen()),
    );
    if (pairing == null || !mounted) return;
    _url.text = pairing.baseUrl;
    _token.text = pairing.token;
    await _saveAndTest();
  }

  @override
  Widget build(BuildContext context) {
    final firstRun = _isFirstRun;
    return Scaffold(
      appBar: firstRun ? null : AppBar(title: const Text('Bridge settings')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 8, 22, 28),
          children: [
            if (firstRun) ...[
              const SizedBox(height: 28),
              Center(child: _logo()),
              const SizedBox(height: 22),
              _firstRunIntro(),
              const SizedBox(height: 28),
            ] else
              const SizedBox(height: 12),
            _label(firstRun ? 'PC bridge URL' : 'Bridge URL'),
            const SizedBox(height: 8),
            TextField(
              controller: _url,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.link_rounded),
                hintText: 'https://your-pc.tailnet.ts.net',
              ),
            ),
            const SizedBox(height: 10),
            Center(
              child: TextButton.icon(
                onPressed: _busy ? null : _scanQr,
                icon: const Icon(Icons.qr_code_scanner_rounded, size: 18),
                label: const Text('Scan QR code instead'),
              ),
            ),
            const SizedBox(height: 10),
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
                  icon: Icon(
                    _obscure
                        ? Icons.visibility_outlined
                        : Icons.visibility_off_outlined,
                  ),
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
                    color: VbColors.danger.withValues(alpha: 0.4),
                  ),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      Icons.error_outline_rounded,
                      size: 19,
                      color: VbColors.danger,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: VbColors.danger,
                          fontSize: 13.5,
                          height: 1.4,
                        ),
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
                        strokeWidth: 2.2,
                        color: Color(0xFF06210C),
                      ),
                    )
                  : const Icon(Icons.arrow_forward_rounded),
              label: Text(
                _busy
                    ? 'Connecting to PC...'
                    : firstRun
                        ? 'Connect to PC'
                        : 'Test & Save',
              ),
            ),
            const SizedBox(height: 24),
            if (!firstRun) ...[
              _label('Appearance'),
              const SizedBox(height: 8),
              _themeToggle(),
              const SizedBox(height: 22),
            ],
            _label('About'),
            const SizedBox(height: 8),
            _aboutLinks(),
            const SizedBox(height: 22),
            _hint(),
          ],
        ),
      ),
    );
  }

  Future<void> _openUrl(Uri url) async {
    final ok = await launchUrl(url, mode: LaunchMode.externalApplication);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Couldn't open ${url.toString()}")),
      );
    }
  }

  Widget _aboutLinks() {
    return Material(
      color: VbColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(VbRadius.card),
        side: BorderSide(color: VbColors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          _linkRow(
            icon: Icons.privacy_tip_outlined,
            title: 'Privacy policy',
            subtitle:
                'How VoiceBridge handles bridge settings, tokens, and voice data.',
            url: _privacyUrl,
          ),
          Divider(height: 1, color: VbColors.border),
          _linkRow(
            icon: Icons.help_outline_rounded,
            title: 'Support',
            subtitle: 'Report bugs or ask for help on GitHub.',
            url: _supportUrl,
          ),
          Divider(height: 1, color: VbColors.border),
          _linkRow(
            icon: Icons.menu_book_outlined,
            title: 'Documentation',
            subtitle: 'Setup, security notes, and bridge configuration.',
            url: _docsUrl,
          ),
        ],
      ),
    );
  }

  Widget _themeSurface({required Widget child}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: VbColors.surface,
        borderRadius: BorderRadius.circular(VbRadius.card),
        border: Border.all(color: VbColors.border),
      ),
      child: child,
    );
  }

  Widget _linkRow({
    required IconData icon,
    required String title,
    required String subtitle,
    required Uri url,
  }) {
    return ListTile(
      leading: Icon(icon, color: VbColors.accent),
      title: Text(
        title,
        style: TextStyle(
          fontWeight: FontWeight.w700,
          color: VbColors.textPrimary,
        ),
      ),
      subtitle: Text(
        subtitle,
        style: TextStyle(color: VbColors.textMuted, height: 1.35),
      ),
      trailing: Icon(Icons.open_in_new_rounded, color: VbColors.textMuted),
      onTap: () => _openUrl(url),
    );
  }

  Widget _themeToggle() {
    return ValueListenableBuilder<String>(
      valueListenable: VbThemeController.mode,
      builder: (_, mode, __) => _themeSurface(
        child: Row(
          children: [
            Icon(Icons.brightness_6_rounded, size: 20, color: VbColors.accent),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'Theme',
                style: TextStyle(
                  fontSize: 14.5,
                  fontWeight: FontWeight.w600,
                  color: VbColors.textPrimary,
                ),
              ),
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
            child: Text(
              label,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                color: selected ? VbColors.accent : VbColors.textMuted,
              ),
            ),
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
      child: const Icon(
        Icons.graphic_eq_rounded,
        color: Color(0xFF06210C),
        size: 46,
      ),
    );
  }

  Widget _firstRunIntro() {
    return Column(
      children: [
        Text(
          'Connect to your PC',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 26,
            fontWeight: FontWeight.w800,
            color: VbColors.textPrimary,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          'Start the bridge on your computer, expose it over Tailscale HTTPS, then paste the PC URL here.',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 14,
            color: VbColors.textMuted,
            height: 1.5,
          ),
        ),
        const SizedBox(height: 18),
        Container(
          decoration: BoxDecoration(
            color: VbColors.surface,
            borderRadius: BorderRadius.circular(VbRadius.card),
            border: Border.all(color: VbColors.border),
          ),
          child: Column(
            children: [
              _setupStep(
                icon: Icons.computer_rounded,
                title: 'Run bridge',
                detail: 'npm start',
              ),
              Divider(height: 1, color: VbColors.border),
              _setupStep(
                icon: Icons.lock_outline_rounded,
                title: 'Publish HTTPS',
                detail: 'tailscale serve --bg --https=443 localhost:8787',
              ),
              Divider(height: 1, color: VbColors.border),
              _setupStep(
                icon: Icons.link_rounded,
                title: 'Paste URL',
                detail: 'Use the https://...ts.net address from your PC.',
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _setupStep({
    required IconData icon,
    required String title,
    required String detail,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: VbColors.accent),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                    color: VbColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  detail,
                  style: detail.startsWith('Use ')
                      ? TextStyle(
                          fontSize: 12.5,
                          color: VbColors.textMuted,
                          height: 1.35,
                        )
                      : VbTheme.mono(size: 12.2, color: VbColors.textMuted),
                ),
              ],
            ),
          ),
        ],
      ),
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
          Icon(
            Icons.lightbulb_outline_rounded,
            size: 18,
            color: VbColors.warning,
          ),
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
                    color: VbColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'On your computer, serve the bridge over HTTPS with Tailscale:',
                  style: TextStyle(
                    fontSize: 12.5,
                    color: VbColors.textMuted,
                    height: 1.45,
                  ),
                ),
                const SizedBox(height: 6),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 7,
                  ),
                  decoration: BoxDecoration(
                    color: VbColors.bg,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: VbColors.border),
                  ),
                  child: Text(
                    'tailscale serve --bg --https=443 localhost:8787',
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
