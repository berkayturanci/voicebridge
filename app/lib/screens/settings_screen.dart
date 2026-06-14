import 'package:flutter/material.dart';

import '../api.dart';
import '../settings.dart';
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
  String? _error;

  Future<void> _saveAndTest() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    widget.settings
      ..baseUrl = _url.text
      ..token = _token.text;
    try {
      await Api(widget.settings).config(); // reachability + auth check
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
    return Scaffold(
      appBar: AppBar(title: const Text('Köprü ayarları')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('Bilgisayarındaki voicebridge köprüsünün adresi:'),
          const SizedBox(height: 8),
          TextField(
            controller: _url,
            keyboardType: TextInputType.url,
            autocorrect: false,
            decoration: const InputDecoration(
              labelText: 'Köprü URL',
              hintText: 'https://mac.tail-xxxx.ts.net',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _token,
            obscureText: true,
            decoration: const InputDecoration(
              labelText: 'Erişim token (opsiyonel)',
              border: OutlineInputBorder(),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 16),
            Text('⚠️ $_error',
                style: const TextStyle(color: Colors.redAccent)),
          ],
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: _busy ? null : _saveAndTest,
            icon: _busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.check),
            label: Text(_busy ? 'Bağlanıyor…' : 'Test et & Kaydet'),
          ),
          const SizedBox(height: 24),
          const Text(
            'İpucu: bilgisayarda köprüyü Tailscale ile HTTPS yayınla:\n'
            '  tailscale serve --bg 8787',
            style: TextStyle(fontSize: 12, color: Colors.grey),
          ),
        ],
      ),
    );
  }
}
